import { eq } from "drizzle-orm";

import db from "@/utils/db";
import { organizationsTable } from "@/drizzle/schema";

export const db_organizationName = async (organizationId: string) => {
  const [row] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId))
    .limit(1);
  return row?.name ?? "";
};
