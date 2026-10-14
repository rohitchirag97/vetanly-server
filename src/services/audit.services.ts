import { createHash } from "node:crypto";
import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";

import db from "@/utils/db";
import { auditLogsTable } from "@/drizzle/schema";
import { OWNER_ROLES, requireRole } from "@/services/access.services";
import { ok, type ServiceResult } from "@/utils/result";

export type AuditEntry = {
  organizationId: string;
  userId: string | null;
  userName: string | null;
  role: string | null;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string | null;
  userAgent: string | null;
  summary: string | null;
  details: Record<string, unknown> | null;
};

const GENESIS_HASH = "0".repeat(64);

// Idempotent. Run at every startup so the guard is restored if anyone drops it.
export const ensureAuditLogGuards = async () => {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION audit_logs_block_change() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP USING ERRCODE = '42501';
    END;
    $$ LANGUAGE plpgsql`);
  await db.execute(sql`DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON audit_logs`);
  await db.execute(sql`
    CREATE TRIGGER audit_logs_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_block_change()`);
  await db.execute(sql`DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs`);
  await db.execute(sql`
    CREATE TRIGGER audit_logs_no_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_change()`);
};

const computeHash = (prevHash: string, row: Record<string, unknown>) =>
  createHash("sha256")
    .update(prevHash)
    .update(JSON.stringify(row))
    .digest("hex");

const hashedFields = (
  id: string,
  createdAt: Date,
  entry: Omit<AuditEntry, "userName" | "userAgent" | "details" | "summary">,
  action: string,
  summary: string | null,
) => ({
  id,
  createdAt: createdAt.toISOString(),
  organizationId: entry.organizationId,
  userId: entry.userId,
  role: entry.role,
  method: entry.method,
  path: entry.path,
  action,
  statusCode: entry.statusCode,
  ipAddress: entry.ipAddress,
  // Older rows predate summaries, so only newer rows carry it in their hash.
  ...(summary ? { summary } : {}),
});

// Each row hashes its predecessor, so removing or editing history breaks the chain.
export const writeAuditLog = async (entry: AuditEntry, action: string) => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${entry.organizationId}))`);
    const [last] = await tx
      .select({ hash: auditLogsTable.hash })
      .from(auditLogsTable)
      .where(eq(auditLogsTable.organizationId, entry.organizationId))
      .orderBy(desc(auditLogsTable.seq))
      .limit(1);
    const prevHash = last?.hash ?? GENESIS_HASH;
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const hash = computeHash(prevHash, hashedFields(id, createdAt, entry, action, entry.summary));
    await tx.insert(auditLogsTable).values({ ...entry, id, action, createdAt, prevHash, hash });
  });
};

export type AuditQuery = {
  search?: string;
  method?: string;
  before?: number;
  limit: number;
};

export const listAuditLogs = async (
  organizationId: string,
  requesterId: string,
  query: AuditQuery,
): Promise<ServiceResult<{ items: Array<typeof auditLogsTable.$inferSelect>; nextBefore: number | null }>> => {
  const access = await requireRole(organizationId, requesterId, OWNER_ROLES);
  if (!access.ok) return access;

  const term = query.search?.trim();
  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(
      and(
        eq(auditLogsTable.organizationId, organizationId),
        query.method ? eq(auditLogsTable.method, query.method) : undefined,
        query.before ? lt(auditLogsTable.seq, query.before) : undefined,
        term
          ? or(
              ilike(auditLogsTable.userName, `%${term}%`),
              ilike(auditLogsTable.summary, `%${term}%`),
              ilike(auditLogsTable.action, `%${term}%`),
              ilike(auditLogsTable.path, `%${term}%`),
              ilike(auditLogsTable.ipAddress, `%${term}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(auditLogsTable.seq))
    .limit(query.limit + 1);

  const items = rows.slice(0, query.limit);
  return ok({ items, nextBefore: rows.length > query.limit ? items[items.length - 1].seq : null });
};

// Walks the chain from the oldest row and reports the first row that does not match.
export const verifyAuditChain = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<{ valid: boolean; checked: number; brokenAtSeq: number | null }>> => {
  const access = await requireRole(organizationId, requesterId, OWNER_ROLES);
  if (!access.ok) return access;

  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(eq(auditLogsTable.organizationId, organizationId))
    .orderBy(auditLogsTable.seq);

  let prev = GENESIS_HASH;
  for (const row of rows) {
    const expected = computeHash(prev, hashedFields(row.id, row.createdAt, row, row.action, row.summary));
    if (row.prevHash !== prev || row.hash !== expected) {
      return ok({ valid: false, checked: rows.length, brokenAtSeq: row.seq });
    }
    prev = row.hash;
  }
  return ok({ valid: true, checked: rows.length, brokenAtSeq: null });
};
