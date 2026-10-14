import { Context } from "hono";

import { getUserById } from "@/services/user.services";
import { verifyToken } from "@/services/jwt.services";
import { isActiveSession } from "@/services/session.services";
import { sendResponse } from "@/utils/response";
import { and, eq } from "drizzle-orm";
import db from "@/utils/db";
import { organizationsTable, platformSubscriptionsTable, userOrganizationsTable } from "@/drizzle/schema";
import { computeAccess, TRIAL_NOT_STARTED_MESSAGE } from "@/services/billing-access.services";
import { readUuid } from "@/utils/request";

// Reachable before the trial starts: billing (to start it) and the organization's own basics.
const TRIAL_GATE_EXEMPT = ["/api/v1/billing/", "/api/v1/organization"];
const ORGANIZATION_LIFECYCLE_PATH = /^\/api\/v1\/organization\/[0-9a-f-]{36}\/(deactivate|reactivate|deletion)$/i;

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
        .select({
          status: organizationsTable.status,
          isActive: organizationsTable.isActive,
          trialEndsAt: organizationsTable.trialEndsAt,
          paidUntil: platformSubscriptionsTable.paidUntil,
          subscriptionStatus: platformSubscriptionsTable.status,
        })
        .from(userOrganizationsTable)
        .innerJoin(
          organizationsTable,
          eq(organizationsTable.id, userOrganizationsTable.organizationId),
        )
        .leftJoin(
          platformSubscriptionsTable,
          eq(platformSubscriptionsTable.organizationId, organizationsTable.id),
        )
        .where(
          and(
            eq(userOrganizationsTable.organizationId, organizationId),
            eq(userOrganizationsTable.userId, user.id),
            eq(userOrganizationsTable.isActive, true),
          ),
        )
        .limit(1);
      // The owner's pause, reactivate and deletion actions must work while the organization is locked.
      if (membership && membership.status !== "active" && !ORGANIZATION_LIFECYCLE_PATH.test(c.req.path)) {
        return membership.status === "pending_deletion"
          ? sendResponse(
              c,
              "error",
              "This organization is scheduled for deletion. The owner can cancel it from the organization menu.",
              { code: "ORGANIZATION_PENDING_DELETION" },
              403,
            )
          : sendResponse(
              c,
              "error",
              "This organization is suspended. Contact support.",
              { code: "ORGANIZATION_SUSPENDED" },
              403,
            );
      }
      // A paused organization is closed to everyone, including the owner, until they reactivate it.
      if (membership && !membership.isActive && !ORGANIZATION_LIFECYCLE_PATH.test(c.req.path)) {
        return sendResponse(
          c,
          "error",
          "This organization is paused. The owner can reactivate it from the organization menu.",
          { code: "ORGANIZATION_PAUSED" },
          403,
        );
      }
      // Until the owner starts the free trial, nothing in the workspace can be read or changed.
      if (
        membership &&
        !TRIAL_GATE_EXEMPT.some((prefix) => c.req.path.startsWith(prefix)) &&
        computeAccess(membership).state === "inactive"
      ) {
        return sendResponse(c, "error", TRIAL_NOT_STARTED_MESSAGE, { code: "TRIAL_NOT_STARTED" }, 402);
      }
    }
    await next();
  } catch (error) {
    return sendResponse(c, "error", "Unauthorized", null, 401);
  }
};
