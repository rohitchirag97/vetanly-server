import "dotenv/config";
import { defineConfig } from "drizzle-kit";

import { buildDatabaseUrl } from "./src/utils/database-url";

export default defineConfig({
  out: "./src/drizzle/migrations",
  schema: "./src/drizzle/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: buildDatabaseUrl(process.env),
  },
});
