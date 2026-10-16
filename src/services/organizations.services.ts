import db from "@/utils/db";
import { and, eq, sql } from "drizzle-orm";
import {
  organizationsTable,
  userOrganizationsTable,
  UserRole,
} from "@/drizzle/schema";
import type {
  CreateOrganizationInput,
  Organization,
  OrganizationWithUsers,
} from "@/types/organization.types";

export const createOrganizationService: (
  data: CreateOrganizationInput,
) => Promise<Organization> = async (data: CreateOrganizationInput) => {
  return db.transaction(async (trx) => {
    const [newOrganization] = await trx
      .insert(organizationsTable)
      .values({ name: data.name, slug: data.slug, createdAt: new Date() })
      .returning();

    await trx.insert(userOrganizationsTable).values({
      organizationId: newOrganization.id,
      userId: data.userId,
      role: UserRole.SUPER_ADMIN,
    });
    return newOrganization;
  });
};

export const getOrganizationBySlug: (
  slug: string,
) => Promise<typeof organizationsTable.$inferSelect | null> = async (
  slug: string,
) => {
  const [organization] = await db
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, slug))
    .limit(1);

  return organization ?? null;
};

type UpdateOrganizationResult =
  | { status: "updated"; organization: Organization }
  | { status: "organization-not-found" }
  | { status: "forbidden" }
  | { status: "slug-taken" };

export const updateOrganization = async (
  organizationId: string,
  userId: string,
  input: { name: string; slug: string },
): Promise<UpdateOrganizationResult> =>
  db.transaction(async (trx) => {
    const [membership] = await trx
      .select({ role: userOrganizationsTable.role })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, organizationId),
          eq(userOrganizationsTable.userId, userId),
          eq(userOrganizationsTable.isActive, true),
        ),
      )
      .limit(1);

    if (membership?.role !== UserRole.SUPER_ADMIN) {
      const [organization] = await trx
        .select({ id: organizationsTable.id })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId))
        .limit(1);
      return organization
        ? { status: "forbidden" }
        : { status: "organization-not-found" };
    }

    const [existingSlug] = await trx
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.slug, input.slug))
      .limit(1);

    if (existingSlug && existingSlug.id !== organizationId) {
      return { status: "slug-taken" };
    }

    const [organization] = await trx
      .update(organizationsTable)
      .set({ name: input.name, slug: input.slug })
      .where(eq(organizationsTable.id, organizationId))
      .returning({
        id: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        isActive: organizationsTable.isActive,
      });

    if (!organization) return { status: "organization-not-found" };
    return { status: "updated", organization };
  });

export const getOrganizationwithUser: (
  slug: string,
) => Promise<OrganizationWithUsers | null> = async (slug: string) => {
  const organizationRows = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      userId: userOrganizationsTable.userId,
    })
    .from(organizationsTable)
    .leftJoin(
      userOrganizationsTable,
      eq(organizationsTable.id, userOrganizationsTable.organizationId),
    )
    .where(eq(organizationsTable.slug, slug));

  if (organizationRows.length === 0) return null;

  const organization = organizationRows[0];
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    users: [
      ...new Set(
        organizationRows.flatMap((row) => (row.userId ? [row.userId] : [])),
      ),
    ],
  };
};

export const getUsersOrganizations: (
  userId: string,
) => Promise<
  Array<Organization & { role: UserRole; membershipActive: boolean; branchLimited: boolean }>
> = async (userId: string) => {
  const organizations = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      isActive: organizationsTable.isActive,
      status: organizationsTable.status,
      deactivatedAt: organizationsTable.deactivatedAt,
      deletionScheduledAt: organizationsTable.deletionScheduledAt,
      role: userOrganizationsTable.role,
      membershipActive: userOrganizationsTable.isActive,
      // Limited to some branches: finance and organization settings are hidden.
      branchLimited: sql<boolean>`exists (select 1 from branch_managers bm where bm.user_organization_id = ${userOrganizationsTable.id})`,
    })
    .from(organizationsTable)
    .innerJoin(
      userOrganizationsTable,
      eq(organizationsTable.id, userOrganizationsTable.organizationId),
    )
    .where(eq(userOrganizationsTable.userId, userId));

  return organizations as Array<
    Organization & { role: UserRole; membershipActive: boolean; branchLimited: boolean }
  >;
};

export const addUserToOrganization: (
  organizationId: string,
  userId: string,
  role: UserRole,
) => Promise<typeof userOrganizationsTable.$inferSelect | null> = async (
  organizationId: string,
  userId: string,
  role: UserRole,
) => {
  const [addedUser] = await db
    .insert(userOrganizationsTable)
    .values({ organizationId, userId, role })
    .returning();
  return addedUser ?? null;
};
