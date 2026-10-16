import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import { employeeProfilesTable, employeeStatutoryProfilesTable } from "@/drizzle/schema";
import { authorizeEmployeeRecord } from "@/services/access.services";
import { ok, type ServiceResult } from "@/utils/result";
import { decryptSecret, encryptSecret, maskAccountNumber } from "@/utils/crypto";
import type { profileSchema } from "@/validator/employee-record.validator";

const columns = {
  dateOfBirth: employeeProfilesTable.dateOfBirth,
  bloodGroup: employeeProfilesTable.bloodGroup,
  addressLine1: employeeProfilesTable.addressLine1,
  addressLine2: employeeProfilesTable.addressLine2,
  city: employeeProfilesTable.city,
  state: employeeProfilesTable.state,
  postalCode: employeeProfilesTable.postalCode,
  country: employeeProfilesTable.country,
  emergencyContactName: employeeProfilesTable.emergencyContactName,
  emergencyContactRelation: employeeProfilesTable.emergencyContactRelation,
  emergencyContactPhone: employeeProfilesTable.emergencyContactPhone,
  bankAccountHolder: employeeProfilesTable.bankAccountHolder,
  bankName: employeeProfilesTable.bankName,
  bankAccountNumber: employeeProfilesTable.bankAccountLast4,
  bankIfsc: employeeProfilesTable.bankIfsc,
  upiId: employeeProfilesTable.upiId,
  updatedAt: employeeProfilesTable.updatedAt,
};

export type EmployeeProfile = Record<keyof typeof columns | "gender", string | Date | null>;

const empty = (): EmployeeProfile =>
  Object.fromEntries([...Object.keys(columns), "gender"].map((key) => [key, null])) as EmployeeProfile;

/** Gender lives on the statutory profile, where professional tax slabs read it. */
const genderOf = async (membershipId: string) => {
  const [row] = await db
    .select({ gender: employeeStatutoryProfilesTable.gender })
    .from(employeeStatutoryProfilesTable)
    .where(eq(employeeStatutoryProfilesTable.userOrganizationId, membershipId))
    .limit(1);
  return row?.gender ?? null;
};

const withMask = (profile: EmployeeProfile): EmployeeProfile => ({
  ...profile,
  bankAccountNumber: maskAccountNumber(profile.bankAccountNumber as string | null),
});

/** Real account number for payouts. Server-side only; never expose it through an endpoint. */
export const getBankAccountNumberForPayout = async (organizationId: string, employeeId: string) => {
  const [row] = await db
    .select({ value: employeeProfilesTable.bankAccountNumber })
    .from(employeeProfilesTable)
    .where(
      and(
        eq(employeeProfilesTable.organizationId, organizationId),
        eq(employeeProfilesTable.userId, employeeId),
      ),
    )
    .limit(1);
  return row?.value ? decryptSecret(row.value) : null;
};

export const getEmployeeProfile = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
): Promise<ServiceResult<EmployeeProfile>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;

  const [profile] = await db
    .select(columns)
    .from(employeeProfilesTable)
    .where(
      and(
        eq(employeeProfilesTable.organizationId, organizationId),
        eq(employeeProfilesTable.userId, employeeId),
      ),
    )
    .limit(1);
  const gender = await genderOf(access.data.target.id);
  return ok({ ...(profile ? withMask({ ...profile, gender }) : empty()), gender });
};

export const saveEmployeeProfile = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  input: z.infer<typeof profileSchema>,
): Promise<ServiceResult<EmployeeProfile>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;

  const { bankAccountNumber, gender, ...rest } = input;
  if (gender !== undefined) {
    await db
      .insert(employeeStatutoryProfilesTable)
      .values({ organizationId, userOrganizationId: access.data.target.id, gender, updatedAt: new Date() })
      .onConflictDoUpdate({ target: employeeStatutoryProfilesTable.userOrganizationId, set: { gender, updatedAt: new Date() } });
  }
  const values = {
    ...rest,
    ...(bankAccountNumber === undefined
      ? {}
      : {
          bankAccountNumber: bankAccountNumber ? encryptSecret(bankAccountNumber) : null,
          bankAccountLast4: bankAccountNumber ? bankAccountNumber.slice(-4) : null,
        }),
    updatedAt: new Date(),
    updatedBy: requesterId,
  };
  const [profile] = await db
    .insert(employeeProfilesTable)
    .values({ organizationId, userId: employeeId, ...values })
    .onConflictDoUpdate({
      target: [employeeProfilesTable.organizationId, employeeProfilesTable.userId],
      set: values,
    })
    .returning(columns);
  return ok(withMask({ ...profile!, gender: await genderOf(access.data.target.id) }));
};
