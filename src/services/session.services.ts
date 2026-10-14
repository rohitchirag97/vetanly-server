import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import db from "@/utils/db";
import { userSessionsTable } from "@/drizzle/schema";

// Replaces any existing session, which signs the user out everywhere else.
export const startSession = async (userId: string, userAgent?: string | null) => {
  const sessionId = randomUUID();
  const values = { sessionId, userAgent: userAgent?.slice(0, 300) ?? null, createdAt: new Date() };
  await db
    .insert(userSessionsTable)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userSessionsTable.userId, set: values });
  return sessionId;
};

export const isActiveSession = async (userId: string, sessionId: string) => {
  const [row] = await db
    .select({ sessionId: userSessionsTable.sessionId })
    .from(userSessionsTable)
    .where(eq(userSessionsTable.userId, userId))
    .limit(1);
  return row?.sessionId === sessionId;
};

export const endSession = async (userId: string) => {
  await db.delete(userSessionsTable).where(eq(userSessionsTable.userId, userId));
};
