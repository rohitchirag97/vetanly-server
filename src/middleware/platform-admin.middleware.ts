import type { Context } from "hono";
import { and, eq } from "drizzle-orm";

import db from "@/utils/db";
import { get, incrementWithExpiry } from "@/utils/redis";
import { usersTable, userSessionsTable } from "@/drizzle/schema";
import { sendResponse } from "@/utils/response";

type RequestUser = { id: string };

export const platformRateLimit = async (c: Context, next: () => Promise<void>) => {
  const user = c.get("user") as RequestUser | undefined;
  const key = user?.id ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const count = await incrementWithExpiry(`platform-rate:${key}`, 60);
  if (count > 180) {
    return sendResponse(c, "error", "Too many platform requests. Try again shortly.", null, 429);
  }
  await next();
};

export const requirePlatformAdmin = (options: { requireFreshAuth?: boolean } = {}) =>
  async (c: Context, next: () => Promise<void>) => {
    const user = c.get("user") as RequestUser | undefined;
    if (!user) return c.notFound();

    const [account] = await db
      .select({ isPlatformAdmin: usersTable.isPlatformAdmin })
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1);
    if (!account?.isPlatformAdmin) return c.notFound();

    if (options.requireFreshAuth === false) return next();
    const sessionId = c.get("sessionId") as string | undefined;
    if (!sessionId || !(await get(`platform-session:${sessionId}`))) {
      return sendResponse(
        c,
        "error",
        "Verify your identity to open the platform console.",
        { code: "PLATFORM_REAUTH_REQUIRED" },
        428,
      );
    }
    const [activeSession] = await db
      .select({ userId: userSessionsTable.userId })
      .from(userSessionsTable)
      .where(and(eq(userSessionsTable.userId, user.id), eq(userSessionsTable.sessionId, sessionId)))
      .limit(1);
    if (!activeSession) return sendResponse(c, "error", "Your session has expired.", null, 401);
    await next();
  };
