import { eq } from "drizzle-orm";

import db from "@/utils/db";
import { usersTable } from "@/drizzle/schema";

const phone = process.argv[2]?.replace(/\D/g, "");
if (!phone || !/^\d{11,15}$/.test(phone)) {
  console.error("Usage: bun run platform:promote <phone-with-country-code>");
  process.exit(1);
}

const [user] = await db
  .update(usersTable)
  .set({ isPlatformAdmin: true })
  .where(eq(usersTable.phone, phone))
  .returning({ id: usersTable.id, phone: usersTable.phone });

if (!user) {
  console.error("No account found for that phone. Sign in once with OTP, then run this command again.");
  process.exit(1);
}

console.info(`Platform admin access enabled for account ${user.id} (${user.phone}).`);
process.exit(0);
