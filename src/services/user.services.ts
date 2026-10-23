import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, or } from "drizzle-orm";

import db from "@/utils/db";
import {
  assetsTable,
  branchesTable,
  organizationsTable,
  UserRole,
  userOrganizationsTable,
  userSessionsTable,
  usersTable,
} from "@/drizzle/schema";

import type {
  User,
  CreateUserInput,
  UpdateUserInput,
} from "@/types/user.types";
import { branchCondition, branchScopeOf, canManageMember, PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { fail, isForeignKeyViolation, isUniqueViolation, ok, type ServiceResult } from "@/utils/result";

export const createUser: (user: CreateUserInput) => Promise<User> = async (
  user: CreateUserInput,
) => {
  const [newUser] = await db.insert(usersTable).values(user).returning();
  return newUser;
};

/** Stand-in phone for accounts made through Google; the "g" prefix never collides with OTP numbers. */
export const newPlaceholderPhone = () => `g${randomUUID().replace(/-/g, "").slice(0, 14)}`;

export type DeliveryChannels = { whatsapp: boolean; email: boolean };

/** WhatsApp needs a real phone; email needs an address Google has verified, so documents never go to a typed-in address. */
export const deliveryChannels = (user: {
  phone: string;
  email: string | null;
  emailVerified: boolean;
}): DeliveryChannels => ({
  whatsapp: !user.phone.startsWith("g"),
  email: Boolean(user.email && user.emailVerified),
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The caller has just proven they own this phone or email, so another account holding it is theirs too.
 * An account with no organizations holds nothing, so it gives the value up; any other account keeps it,
 * because merging two accounts' records is not safe to do automatically.
 */
const releaseFromOtherAccount = async (
  trx: Tx,
  ownerId: string,
  field: "phone" | "email",
): Promise<boolean> => {
  const [[membership], [owner]] = await Promise.all([
    trx
      .select({ id: userOrganizationsTable.id })
      .from(userOrganizationsTable)
      .where(eq(userOrganizationsTable.userId, ownerId))
      .limit(1),
    trx
      .select({ isPlatformAdmin: usersTable.isPlatformAdmin })
      .from(usersTable)
      .where(eq(usersTable.id, ownerId))
      .limit(1),
  ]);
  if (membership || !owner || owner.isPlatformAdmin) return false;
  await trx
    .update(usersTable)
    .set(
      field === "phone"
        ? { phone: newPlaceholderPhone(), phoneVerified: false }
        : { email: null, emailVerified: false },
    )
    .where(eq(usersTable.id, ownerId));
  await trx.delete(userSessionsTable).where(eq(userSessionsTable.userId, ownerId));
  return true;
};

const linkIdentity = async (
  userId: string,
  field: "phone" | "email",
  value: string,
  conflictMessage: string,
): Promise<ServiceResult<User>> => {
  try {
    return await db.transaction(async (trx) => {
      const column = field === "phone" ? usersTable.phone : usersTable.email;
      const [holder] = await trx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(column, value))
        .limit(1);
      if (holder && holder.id !== userId && !(await releaseFromOtherAccount(trx, holder.id, field))) {
        return fail("conflict", conflictMessage);
      }
      const [user] = await trx
        .update(usersTable)
        .set(
          field === "phone"
            ? { phone: value, phoneVerified: true }
            : { email: value, emailVerified: true },
        )
        .where(eq(usersTable.id, userId))
        .returning();
      return user ? ok(user) : fail("not-found", "User not found");
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("conflict", conflictMessage);
    throw error;
  }
};

/** Call only after the user has proven the phone with an OTP. */
export const linkPhone = (userId: string, phone: string) =>
  linkIdentity(
    userId,
    "phone",
    phone,
    "This number already belongs to another Vetanly account. Sign in with that number and link Google from there.",
  );

/** Call only with an email Google has verified for this user. */
export const linkGoogleEmail = (userId: string, email: string) =>
  linkIdentity(
    userId,
    "email",
    email,
    "This Google account already belongs to another Vetanly account. Sign in with Google and link your phone from there.",
  );

type CreateEmployeeInput = CreateUserInput & {
  organizationId: string;
  role: UserRole.ADMIN | UserRole.HR | UserRole.EMPLOYEE;
  branchId?: string;
};

type CreateEmployeeResult =
  | { status: "created"; employee: User }
  | { status: "added"; employee: User }
  | { status: "already-member"; employee: User }
  | { status: "organization-not-found" }
  | { status: "forbidden" };

type ListEmployeesResult =
  | {
      status: "ok";
      employees: Array<User & { role: string; isActive: boolean; branchId: string | null; branchName: string | null }>;
    }
  | { status: "organization-not-found" }
  | { status: "forbidden" };

type UpdateEmployeeResult =
  | { status: "updated"; employee: User & { role: UserRole.ADMIN | UserRole.HR | UserRole.EMPLOYEE } }
  | { status: "organization-not-found" }
  | { status: "forbidden" }
  | { status: "employee-not-found" }
  | { status: "cannot-update-super-admin" };

type EmployeeMembershipResult =
  | { status: "updated"; isActive: boolean }
  | { status: "removed" }
  | { status: "cannot-remove-super-admin" }
  | { status: "holds-assets"; count: number }
  | { status: "has-history" }
  | { status: "organization-not-found" }
  | { status: "forbidden" }
  | { status: "employee-not-found" }
  | { status: "cannot-manage-super-admin" };

/** HR only manages plain employees; a branch-limited manager only people in their branches. */
const managesMember = async (
  requester: { id: string; role: string },
  target: { role: string; branchId: string | null },
) => canManageMember({ role: requester.role, branchIds: await branchScopeOf(requester.id, requester.role) }, target);

export const setEmployeeMembershipActive = async (
  employeeId: string,
  organizationId: string,
  isActive: boolean,
  requesterId: string,
  reason?: string,
): Promise<EmployeeMembershipResult> =>
  db.transaction(async (trx) => {
    const [organization] = await trx
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);

    if (!organization) return { status: "organization-not-found" };

    const [requesterMembership] = await trx
      .select({ id: userOrganizationsTable.id, role: userOrganizationsTable.role })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, organizationId),
          eq(userOrganizationsTable.userId, requesterId),
          eq(userOrganizationsTable.isActive, true),
        ),
      )
      .limit(1);

    if (!PEOPLE_MANAGER_ROLES.includes(requesterMembership?.role ?? "")) {
      return { status: "forbidden" };
    }

    const [employeeMembership] = await trx
      .select({
        id: userOrganizationsTable.id,
        role: userOrganizationsTable.role,
        branchId: userOrganizationsTable.branchId,
      })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, organizationId),
          eq(userOrganizationsTable.userId, employeeId),
        ),
      )
      .limit(1);

    if (!employeeMembership) return { status: "employee-not-found" };
    if (employeeMembership.role === UserRole.SUPER_ADMIN) {
      return { status: "cannot-manage-super-admin" };
    }
    if (!(await managesMember(requesterMembership!, employeeMembership))) {
      return { status: "forbidden" };
    }

    await trx
      .update(userOrganizationsTable)
      .set(
        isActive
          ? { isActive, deactivationReason: null, deactivatedAt: null, deactivatedByUserId: null }
          : {
              isActive,
              deactivationReason: reason ?? null,
              deactivatedAt: new Date(),
              deactivatedByUserId: requesterId,
            },
      )
      .where(eq(userOrganizationsTable.id, employeeMembership.id));

    return { status: "updated", isActive };
  });

export const removeEmployeeFromOrganization = async (
  employeeId: string,
  organizationId: string,
  requesterId: string,
): Promise<EmployeeMembershipResult> =>
  db.transaction(async (trx) => {
    const [organization] = await trx
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);

    if (!organization) return { status: "organization-not-found" };

    const [requesterMembership] = await trx
      .select({ id: userOrganizationsTable.id, role: userOrganizationsTable.role })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, organizationId),
          eq(userOrganizationsTable.userId, requesterId),
          eq(userOrganizationsTable.isActive, true),
        ),
      )
      .limit(1);

    const [employeeMembership] = await trx
      .select({
        id: userOrganizationsTable.id,
        role: userOrganizationsTable.role,
        branchId: userOrganizationsTable.branchId,
      })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, organizationId),
          eq(userOrganizationsTable.userId, employeeId),
        ),
      )
      .limit(1);

    if (!employeeMembership) return { status: "employee-not-found" };
    const isSelfRemoval = employeeId === requesterId;
    if (employeeMembership.role === UserRole.SUPER_ADMIN) {
      return { status: "cannot-remove-super-admin" };
    }
    const canManage =
      !!requesterMembership &&
      PEOPLE_MANAGER_ROLES.includes(requesterMembership.role) &&
      (await managesMember(requesterMembership, employeeMembership));
    if (!isSelfRemoval && !canManage) {
      return { status: "forbidden" };
    }
    // Removing the membership would orphan the handover records; assets must come back first.
    const held = await trx
      .select({ id: assetsTable.id })
      .from(assetsTable)
      .where(eq(assetsTable.holderMembershipId, employeeMembership.id));
    if (held.length) return { status: "holds-assets", count: held.length };

    // Attendance, leave, payroll etc. reference the membership; deleting would wipe that history, so refuse.
    // Savepoint so the FK failure doesn't abort the outer transaction.
    try {
      await trx.transaction((sp) =>
        sp.delete(userOrganizationsTable).where(eq(userOrganizationsTable.id, employeeMembership.id)),
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) return { status: "has-history" };
      throw error;
    }

    return { status: "removed" };
  });

export const updateEmployeeForOrganization = async (
  employeeId: string,
  input: {
    organizationId: string;
    fname: string;
    lname: string;
    role: UserRole.ADMIN | UserRole.HR | UserRole.EMPLOYEE;
  },
  requesterId: string,
): Promise<UpdateEmployeeResult> =>
  db.transaction(async (trx) => {
    const [organization] = await trx
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, input.organizationId))
      .limit(1);

    if (!organization) return { status: "organization-not-found" };

    const [requesterMembership] = await trx
      .select({ id: userOrganizationsTable.id, role: userOrganizationsTable.role })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, input.organizationId),
          eq(userOrganizationsTable.userId, requesterId),
          eq(userOrganizationsTable.isActive, true),
        ),
      )
      .limit(1);

    if (
      !requesterMembership ||
      !PEOPLE_MANAGER_ROLES.includes(requesterMembership.role)
    ) {
      return { status: "forbidden" };
    }

    const [employeeMembership] = await trx
      .select({
        id: userOrganizationsTable.id,
        role: userOrganizationsTable.role,
        branchId: userOrganizationsTable.branchId,
      })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, input.organizationId),
          eq(userOrganizationsTable.userId, employeeId),
        ),
      )
      .limit(1);

    if (!employeeMembership) return { status: "employee-not-found" };
    if (employeeMembership.role === UserRole.SUPER_ADMIN) {
      return { status: "cannot-update-super-admin" };
    }
    if (
      (requesterMembership.role === UserRole.HR && input.role !== UserRole.EMPLOYEE) ||
      !(await managesMember(requesterMembership, employeeMembership))
    ) {
      return { status: "forbidden" };
    }

    const [employee] = await trx
      .update(usersTable)
      .set({ fname: input.fname, lname: input.lname })
      .where(eq(usersTable.id, employeeId))
      .returning();

    if (!employee) return { status: "employee-not-found" };

    await trx
      .update(userOrganizationsTable)
      .set({ role: input.role })
      .where(eq(userOrganizationsTable.id, employeeMembership.id));

    return { status: "updated", employee: { ...employee, role: input.role } };
  });

export const listEmployeesForOrganization = async (
  organizationId: string,
  requesterId: string,
): Promise<ListEmployeesResult> =>
  db.transaction(async (trx) => {
    const [organization] = await trx
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);

    if (!organization) return { status: "organization-not-found" };

    const [membership] = await trx
      .select({ id: userOrganizationsTable.id, role: userOrganizationsTable.role })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, organizationId),
          eq(userOrganizationsTable.userId, requesterId),
          eq(userOrganizationsTable.isActive, true),
        ),
      )
      .limit(1);

    if (
      !membership ||
      !PEOPLE_MANAGER_ROLES.includes(membership.role)
    ) {
      return { status: "forbidden" };
    }

    const employees = await trx
      .select({
        id: usersTable.id,
        fname: usersTable.fname,
        lname: usersTable.lname,
        phone: usersTable.phone,
        role: userOrganizationsTable.role,
        isActive: userOrganizationsTable.isActive,
        branchId: userOrganizationsTable.branchId,
        branchName: branchesTable.name,
      })
      .from(userOrganizationsTable)
      .innerJoin(usersTable, eq(userOrganizationsTable.userId, usersTable.id))
      .leftJoin(branchesTable, eq(branchesTable.id, userOrganizationsTable.branchId))
      .where(
        and(
          eq(userOrganizationsTable.organizationId, organizationId),
          membership.role === UserRole.HR ? eq(userOrganizationsTable.role, UserRole.EMPLOYEE) : undefined,
          branchCondition({ branchIds: await branchScopeOf(membership.id, membership.role) }),
          or(
            ne(userOrganizationsTable.role, UserRole.SUPER_ADMIN),
            eq(userOrganizationsTable.includeInPayroll, true),
          ),
        ),
      )
      .orderBy(usersTable.fname, usersTable.lname);

    return { status: "ok", employees };
  });

export const createEmployeeForOrganization = async (
  input: CreateEmployeeInput,
  requesterId: string,
): Promise<CreateEmployeeResult> =>
  db.transaction(async (trx) => {
    const [organization] = await trx
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, input.organizationId))
      .limit(1);

    if (!organization) return { status: "organization-not-found" };

    const [membership] = await trx
      .select({ id: userOrganizationsTable.id, role: userOrganizationsTable.role })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, input.organizationId),
          eq(userOrganizationsTable.userId, requesterId),
          eq(userOrganizationsTable.isActive, true),
        ),
      )
      .limit(1);

    if (
      !membership ||
      !PEOPLE_MANAGER_ROLES.includes(membership.role) ||
      (membership.role === UserRole.HR && input.role !== UserRole.EMPLOYEE)
    ) {
      return { status: "forbidden" };
    }

    // A branch admin adds people to their own branch (their only one when they don't say which).
    const scope = await branchScopeOf(membership.id, membership.role);
    const branchId = input.branchId ?? (scope?.length === 1 ? scope[0]! : null);
    if (scope && !(branchId && scope.includes(branchId))) return { status: "forbidden" };
    if (branchId) {
      const [branch] = await trx
        .select({ id: branchesTable.id })
        .from(branchesTable)
        .where(and(eq(branchesTable.id, branchId), eq(branchesTable.organizationId, input.organizationId), eq(branchesTable.isActive, true)))
        .limit(1);
      if (!branch) return { status: "forbidden" };
    }

    const [insertedEmployee] = await trx
      .insert(usersTable)
      .values({ fname: input.fname, lname: input.lname, phone: input.phone })
      .onConflictDoNothing({ target: usersTable.phone })
      .returning();

    const [existingEmployee] = insertedEmployee
      ? []
      : await trx
          .select()
          .from(usersTable)
          .where(eq(usersTable.phone, input.phone))
          .limit(1);

    // Existing platform users keep their own name; another organization's admin must not rewrite it.
    const employee = insertedEmployee ?? existingEmployee;
    if (!employee) {
      throw new Error("Unable to resolve employee after insert conflict");
    }

    const [existingMembership] = await trx
      .select({
        id: userOrganizationsTable.id,
        isActive: userOrganizationsTable.isActive,
        role: userOrganizationsTable.role,
      })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, input.organizationId),
          eq(userOrganizationsTable.userId, employee.id),
        ),
      )
      .limit(1);

    if (existingMembership) {
      if (existingMembership.role === UserRole.SUPER_ADMIN) {
        return { status: "forbidden" };
      }
      if (membership.role === UserRole.HR && existingMembership.role !== UserRole.EMPLOYEE) {
        return { status: "forbidden" };
      }
      if (existingMembership.isActive) {
        return { status: "already-member", employee };
      }
      await trx
        .update(userOrganizationsTable)
        // Re-hired into the branch chosen now (a former employee may come back to another branch).
        .set({ role: input.role, isActive: true, ...(branchId ? { branchId } : {}) })
        .where(eq(userOrganizationsTable.id, existingMembership.id));
      return { status: "added", employee };
    }

    await trx.insert(userOrganizationsTable).values({
      organizationId: input.organizationId,
      userId: employee.id,
      role: input.role,
      branchId,
    });

    return {
      status: insertedEmployee ? "created" : "added",
      employee,
    };
  });

export const getUserbyPhone: (phone: string) => Promise<User | null> = async (
  phone: string,
) => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.phone, phone))
    .limit(1);
  return user ?? null;
};

export const getUserByEmail = async (email: string): Promise<User | null> => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  return user ?? null;
};

export const getUserById: (id: string) => Promise<User | null> = async (
  id: string,
) => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id as unknown as string))
    .limit(1);
  return user ?? null;
};

export const updateUser: (
  id: string,
  updates: UpdateUserInput,
) => Promise<User | null> = async (
  id: string,
  updates: UpdateUserInput,
): Promise<User | null> => {
  const [updatedUser] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning();
  return updatedUser ?? null;
};

/**
 * What importing each phone would do, decided by the same rules as createEmployeeForOrganization:
 * - new: no Vetanly account yet; one is created.
 * - existing-user: has an account (another organization or sign-up); added to this one.
 * - inactive-member: was in this organization and is reactivated.
 * - member: already active here; importing again would do nothing.
 * - not-allowed: the owner, or someone HR may not manage.
 */
export type BulkCheckStatus = "new" | "existing-user" | "inactive-member" | "member" | "not-allowed";

export const checkBulkEmployees = async (
  organizationId: string,
  requesterId: string,
  phones: string[],
  employeeCodes: string[],
): Promise<
  ServiceResult<{
    phones: Record<string, { status: BulkCheckStatus; name?: string }>;
    /** Codes already used in this organization, with the phone of the member who holds each. */
    takenCodes: Record<string, string>;
  }>
> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const [people, codeHolders] = await Promise.all([
    phones.length === 0
      ? []
      : db
          .select({
            phone: usersTable.phone,
            fname: usersTable.fname,
            lname: usersTable.lname,
            role: userOrganizationsTable.role,
            isActive: userOrganizationsTable.isActive,
          })
          .from(usersTable)
          .leftJoin(
            userOrganizationsTable,
            and(
              eq(userOrganizationsTable.userId, usersTable.id),
              eq(userOrganizationsTable.organizationId, organizationId),
            ),
          )
          .where(inArray(usersTable.phone, phones)),
    employeeCodes.length === 0
      ? []
      : db
          .select({ code: userOrganizationsTable.employeeCode, phone: usersTable.phone })
          .from(userOrganizationsTable)
          .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
          .where(
            and(
              eq(userOrganizationsTable.organizationId, organizationId),
              inArray(userOrganizationsTable.employeeCode, employeeCodes),
            ),
          ),
  ]);

  const result: Record<string, { status: BulkCheckStatus; name?: string }> = {};
  for (const phone of phones) result[phone] = { status: "new" };
  for (const person of people) {
    const name = `${person.fname} ${person.lname}`.trim();
    let status: BulkCheckStatus;
    if (!person.role) status = "existing-user";
    else if (
      person.role === UserRole.SUPER_ADMIN ||
      (access.data.role === UserRole.HR && person.role !== UserRole.EMPLOYEE)
    ) status = "not-allowed";
    else status = person.isActive ? "member" : "inactive-member";
    result[person.phone] = { status, name };
  }

  const takenCodes: Record<string, string> = {};
  for (const holder of codeHolders) if (holder.code) takenCodes[holder.code] = holder.phone;
  return ok({ phones: result, takenCodes });
};
