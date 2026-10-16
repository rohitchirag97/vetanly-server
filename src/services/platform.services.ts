import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";

import db from "@/utils/db";
import {
  UserRole,
  organizationsTable,
  platformAuditLogsTable,
  platformNotesTable,
  userOrganizationsTable,
  usersTable,
} from "@/drizzle/schema";
import type { PlatformOrganizationStatus } from "@/drizzle/schema";
import { getOrganizationUsage } from "@/services/platform-usage.services";

export type PlatformActor = {
  id: string;
  name: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type PlatformAuditInput = {
  actor: PlatformActor;
  action: string;
  organizationId?: string | null;
  organizationName?: string | null;
  targetUserId?: string | null;
  reason?: string | null;
  beforeValues?: Record<string, unknown> | null;
  afterValues?: Record<string, unknown> | null;
};

const GENESIS_HASH = "0".repeat(64);

type PlatformTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const appendPlatformAudit = async (tx: PlatformTransaction, entry: PlatformAuditInput) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vetanly-platform-audit'))`);
  const [last] = await tx
    .select({ hash: platformAuditLogsTable.hash, createdAt: platformAuditLogsTable.createdAt })
    .from(platformAuditLogsTable)
    .orderBy(desc(platformAuditLogsTable.createdAt), desc(platformAuditLogsTable.id))
    .limit(1);
  const createdAt = new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1));
  const id = randomUUID();
  const fields = {
    id,
    createdAt: createdAt.toISOString(),
    actorUserId: entry.actor.id,
    actorName: entry.actor.name,
    action: entry.action,
    targetOrganizationId: entry.organizationId ?? null,
    targetOrganizationName: entry.organizationName ?? null,
    targetUserId: entry.targetUserId ?? null,
    reason: entry.reason ?? null,
    beforeValues: entry.beforeValues ?? null,
    afterValues: entry.afterValues ?? null,
    ipAddress: entry.actor.ipAddress ?? null,
    userAgent: entry.actor.userAgent?.slice(0, 300) ?? null,
  };
  const prevHash = last?.hash ?? GENESIS_HASH;
  const hash = createHash("sha256").update(prevHash).update(JSON.stringify(fields)).digest("hex");
  await tx.insert(platformAuditLogsTable).values({ ...fields, prevHash, hash, createdAt });
};

const writePlatformAudit = async (entry: PlatformAuditInput) =>
  db.transaction((tx) => appendPlatformAudit(tx, entry));

export const recordPlatformEvent = writePlatformAudit;

const ownerRowsFor = async (organizationIds: string[]) => {
  if (organizationIds.length === 0) return [];
  return db
    .select({
      organizationId: userOrganizationsTable.organizationId,
      id: usersTable.id,
      fname: usersTable.fname,
      lname: usersTable.lname,
      phone: usersTable.phone,
      email: usersTable.email,
    })
    .from(userOrganizationsTable)
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .where(
      and(
        inArray(userOrganizationsTable.organizationId, organizationIds),
        eq(userOrganizationsTable.role, UserRole.SUPER_ADMIN),
      ),
    )
    .orderBy(asc(usersTable.fname), asc(usersTable.lname));
};

const withAccountMetadata = async <T extends { id: string }>(organizations: T[]) => {
  const ids = organizations.map((organization) => organization.id);
  const [owners, usage] = await Promise.all([ownerRowsFor(ids), getOrganizationUsage(ids)]);
  const firstOwner = new Map<string, (typeof owners)[number]>();
  for (const owner of owners) {
    if (!firstOwner.has(owner.organizationId)) firstOwner.set(owner.organizationId, owner);
  }
  return organizations.map((organization) => {
    const owner = firstOwner.get(organization.id);
    return {
      ...organization,
      owner: owner
        ? {
            id: owner.id,
            name: `${owner.fname} ${owner.lname}`.trim(),
            phone: owner.phone,
            email: owner.email,
          }
        : null,
      usage: usage.get(organization.id) ?? {
        activeEmployees: 0,
        totalEmployees: 0,
        activeAdmins: 0,
        totalAdmins: 0,
        loginsLast30Days: 0,
        lastSignInAt: null,
      },
    };
  });
};

export type OrganizationListQuery = {
  search?: string;
  status?: PlatformOrganizationStatus;
  page: number;
  pageSize: number;
};

export const getPlatformOverview = async (actor: PlatformActor) => {
  await writePlatformAudit({ actor, action: "overview.read" });
  const organizations = await db
    .select({ id: organizationsTable.id, status: organizationsTable.status, createdAt: organizationsTable.createdAt })
    .from(organizationsTable);
  const usage = await getOrganizationUsage(organizations.map((organization) => organization.id));
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const signupStart = new Date();
  signupStart.setDate(1);
  signupStart.setHours(0, 0, 0, 0);
  signupStart.setMonth(signupStart.getMonth() - 5);
  const signupRows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${organizationsTable.createdAt}), 'YYYY-MM')`,
      count: sql<number>`count(*)::int`,
    })
    .from(organizationsTable)
    .where(gte(organizationsTable.createdAt, signupStart))
    .groupBy(sql`date_trunc('month', ${organizationsTable.createdAt})`)
    .orderBy(sql`date_trunc('month', ${organizationsTable.createdAt})`);
  const signupCounts = new Map(signupRows.map((row) => [row.month, Number(row.count)]));
  const signupsByMonth = Array.from({ length: 6 }, (_, offset) => {
    const date = new Date(signupStart.getFullYear(), signupStart.getMonth() + offset, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    return {
      month: key,
      label: new Intl.DateTimeFormat("en", { month: "short" }).format(date),
      organizations: signupCounts.get(key) ?? 0,
    };
  });
  const recentRows = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name, slug: organizationsTable.slug, status: organizationsTable.status, createdAt: organizationsTable.createdAt })
    .from(organizationsTable)
    .orderBy(desc(organizationsTable.createdAt), asc(organizationsTable.name))
    .limit(5);
  const recentOrganizations = await withAccountMetadata(recentRows);
  const usageRows = [...usage.values()];

  return {
    metrics: {
      totalOrganizations: organizations.length,
      activeOrganizations: organizations.filter((organization) => organization.status === "active").length,
      suspendedOrganizations: organizations.filter((organization) => organization.status === "suspended").length,
      newThisMonth: organizations.filter((organization) => organization.createdAt && organization.createdAt >= monthStart).length,
      employees: usageRows.reduce((total, item) => total + item.activeEmployees, 0),
      organizationsWithSignIn30Days: usageRows.filter((item) => item.lastSignInAt && item.lastSignInAt >= thirtyDaysAgo).length,
    },
    signupsByMonth,
    recentOrganizations,
    reportingStartedAt: signupStart.toISOString(),
  };
};

export const listPlatformOrganizations = async (
  actor: PlatformActor,
  query: OrganizationListQuery,
) => {
  await writePlatformAudit({ actor, action: "organizations.list.read" });
  const term = query.search?.trim();
  const filter = and(
    term ? or(ilike(organizationsTable.name, `%${term}%`), ilike(organizationsTable.slug, `%${term}%`)) : undefined,
    query.status ? eq(organizationsTable.status, query.status) : undefined,
  );
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizationsTable)
    .where(filter);
  const rows = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      status: organizationsTable.status,
      suspendedReason: organizationsTable.suspendedReason,
      createdAt: organizationsTable.createdAt,
    })
    .from(organizationsTable)
    .where(filter)
    .orderBy(desc(organizationsTable.createdAt), asc(organizationsTable.name))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return {
    items: await withAccountMetadata(rows),
    page: query.page,
    pageSize: query.pageSize,
    total: Number(countRow?.count ?? 0),
  };
};

export const getPlatformOrganization = async (actor: PlatformActor, organizationId: string) => {
  const [organization] = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      status: organizationsTable.status,
      suspendedReason: organizationsTable.suspendedReason,
      suspendedAt: organizationsTable.suspendedAt,
      createdAt: organizationsTable.createdAt,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId))
    .limit(1);
  await writePlatformAudit({
    actor,
    action: "organization.detail.read",
    organizationId,
    organizationName: organization?.name,
  });
  if (!organization) return null;
  const [metadata] = await withAccountMetadata([organization]);
  const notes = await db
    .select({ id: platformNotesTable.id, authorName: platformNotesTable.authorName, text: platformNotesTable.text, createdAt: platformNotesTable.createdAt })
    .from(platformNotesTable)
    .where(eq(platformNotesTable.organizationId, organizationId))
    .orderBy(desc(platformNotesTable.createdAt))
    .limit(30);
  return { ...metadata, notes };
};

export type CreatePlatformOrganizationInput = {
  name: string;
  slug: string;
  owner: { fname: string; lname: string; phone: string; email?: string };
};

export const createPlatformOrganization = async (
  actor: PlatformActor,
  input: CreatePlatformOrganizationInput,
) => {
  const result = await db.transaction(async (tx) => {
    const [existingOrganization] = await tx
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.slug, input.slug))
      .limit(1);
    if (existingOrganization) return { status: "slug-taken" as const };

    let [owner] = await tx
      .select({ id: usersTable.id, fname: usersTable.fname, lname: usersTable.lname, phone: usersTable.phone, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.phone, input.owner.phone))
      .limit(1);
    const existingOwner = Boolean(owner);
    if (!owner) {
      [owner] = await tx
        .insert(usersTable)
        .values({
          fname: input.owner.fname,
          lname: input.owner.lname,
          phone: input.owner.phone,
          email: input.owner.email ?? null,
        })
        .returning({ id: usersTable.id, fname: usersTable.fname, lname: usersTable.lname, phone: usersTable.phone, email: usersTable.email });
    }
    if (!owner) throw new Error("Could not create the owner account");

    const [organization] = await tx
      .insert(organizationsTable)
      .values({ name: input.name, slug: input.slug, status: "active", createdAt: new Date() })
      .returning({ id: organizationsTable.id, name: organizationsTable.name, slug: organizationsTable.slug, status: organizationsTable.status, createdAt: organizationsTable.createdAt });
    await tx.insert(userOrganizationsTable).values({
      organizationId: organization.id,
      userId: owner.id,
      role: UserRole.SUPER_ADMIN,
    });
    await appendPlatformAudit(tx, {
      actor,
      action: "organization.create",
      organizationId: organization.id,
      organizationName: organization.name,
      targetUserId: owner.id,
      afterValues: { slug: organization.slug, ownerUserId: owner.id },
    });
    return { status: "created" as const, organization, owner, existingOwner };
  });
  if (result.status !== "created") return result;
  return {
    status: "created" as const,
    organization: result.organization,
    owner: {
      id: result.owner.id,
      name: `${result.owner.fname} ${result.owner.lname}`.trim(),
      phone: result.owner.phone,
      email: result.owner.email,
    },
    existingOwner: result.existingOwner,
  };
};

export const updatePlatformOrganizationStatus = async (
  actor: PlatformActor,
  organizationId: string,
  status: Extract<PlatformOrganizationStatus, "active" | "suspended">,
  reason?: string,
) => {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ name: organizationsTable.name, status: organizationsTable.status, suspendedReason: organizationsTable.suspendedReason })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);
    if (!before) return null;
    const [updated] = await tx
      .update(organizationsTable)
      .set(
        status === "suspended"
          ? { status, suspendedReason: reason ?? null, suspendedAt: new Date() }
          : { status, suspendedReason: null, suspendedAt: null },
      )
      .where(eq(organizationsTable.id, organizationId))
      .returning({ id: organizationsTable.id, name: organizationsTable.name, status: organizationsTable.status, suspendedReason: organizationsTable.suspendedReason, suspendedAt: organizationsTable.suspendedAt });
    await appendPlatformAudit(tx, {
      actor,
      action: status === "suspended" ? "organization.suspend" : "organization.reactivate",
      organizationId,
      organizationName: before.name,
      reason,
      beforeValues: { status: before.status, suspendedReason: before.suspendedReason },
      afterValues: { status: updated.status, suspendedReason: updated.suspendedReason },
    });
    return updated;
  });
};

export const addPlatformOrganizationNote = async (
  actor: PlatformActor,
  organizationId: string,
  text: string,
) => {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .select({ id: organizationsTable.id, name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);
    if (!organization) return null;
    const [note] = await tx
      .insert(platformNotesTable)
      .values({ organizationId, authorUserId: actor.id, authorName: actor.name, text })
      .returning({ id: platformNotesTable.id, authorName: platformNotesTable.authorName, text: platformNotesTable.text, createdAt: platformNotesTable.createdAt });
    await appendPlatformAudit(tx, {
      actor,
      action: "organization.note.add",
      organizationId,
      organizationName: organization.name,
      afterValues: { noteId: note.id },
    });
    return note;
  });
};

export const listPlatformAuditLogs = async (actor: PlatformActor, page: number, pageSize: number) => {
  await writePlatformAudit({ actor, action: "audit-log.read" });
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(platformAuditLogsTable);
  const items = await db
    .select({
      id: platformAuditLogsTable.id,
      actorUserId: platformAuditLogsTable.actorUserId,
      actorName: platformAuditLogsTable.actorName,
      action: platformAuditLogsTable.action,
      targetOrganizationId: platformAuditLogsTable.targetOrganizationId,
      targetOrganizationName: platformAuditLogsTable.targetOrganizationName,
      targetUserId: platformAuditLogsTable.targetUserId,
      reason: platformAuditLogsTable.reason,
      beforeValues: platformAuditLogsTable.beforeValues,
      afterValues: platformAuditLogsTable.afterValues,
      ipAddress: platformAuditLogsTable.ipAddress,
      createdAt: platformAuditLogsTable.createdAt,
    })
    .from(platformAuditLogsTable)
    .orderBy(desc(platformAuditLogsTable.createdAt), desc(platformAuditLogsTable.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items, page, pageSize, total: Number(countRow?.count ?? 0) };
};
