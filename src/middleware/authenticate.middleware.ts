import { Context } from "hono";

import { getUserById } from "@/services/user.services";
import { verifyToken } from "@/services/jwt.services";
import { isActiveSession } from "@/services/session.services";
import { sendResponse } from "@/utils/response";
import { and, eq } from "drizzle-orm";
import db from "@/utils/db";
import { organizationsTable, userOrganizationsTable } from "@/drizzle/schema";
import { readUuid } from "@/utils/request";

const requestedOrganizationId = async (c: Context): Promise<string | null> => {
  const fromQuery = readUuid(c.req.query("organizationId"));
  if (fromQuery) return fromQuery;
  const pathId = readUuid(/\/organization\/([0-9a-f-]{36})(?:\/|$)/i.exec(c.req.path)?.[1]);
  if (pathId) return pathId;
  if (!c.req.header("content-type")?.includes("application/json")) return null;
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return readUuid((body as Record<string, unknown>).organizationId as string | undefined);
};

export const authenticate = async (c: Context, next: () => Promise<void>) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return sendResponse(c, "error", "Unauthorized", null, 401);
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = verifyToken(token);
    if (!decoded) {
      return sendResponse(c, "error", "Unauthorized", null, 401);
    }
    if (!(await isActiveSession(decoded.id, decoded.sid))) {
      return sendResponse(c, "error", "You were signed out because your account was used on another device.", null, 401);
    }
    const user = await getUserById(decoded.id);
    if (!user) {
      return sendResponse(c, "error", "Unauthorized", null, 401);
    }
    c.set("user", user);
    c.set("sessionId", decoded.sid);

    const organizationId = await requestedOrganizationId(c);
    if (organizationId) {
      const [membership] = await db
        .select({ status: organizationsTable.status })
        .from(userOrganizationsTable)
        .innerJoin(
          organizationsTable,
          eq(organizationsTable.id, userOrganizationsTable.organizationId),
        )
        .where(
          and(
            eq(userOrganizationsTable.organizationId, organizationId),
            eq(userOrganizationsTable.userId, user.id),
            eq(userOrganizationsTable.isActive, true),
          ),
        )
        .limit(1);
      if (membership && membership.status !== "active") {
        return sendResponse(
          c,
          "error",
          "This organization is suspended. Contact support.",
          { code: "ORGANIZATION_SUSPENDED" },
          403,
        );
      }
    }
    await next();
  } catch (error) {
    return sendResponse(c, "error", "Unauthorized", null, 401);
  }
};
