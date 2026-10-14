// Kept free of other imports so drizzle.config.ts can use it outside the app.

type PostgresSettings = Record<string, string | undefined>;

/** Builds the connection URL from the same variables docker-compose uses, escaping characters a password may contain. */
export const buildDatabaseUrl = (settings: PostgresSettings) => {
  const missing = (["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"] as const)
    .filter((key) => !settings[key]);
  if (missing.length > 0) throw new Error(`Missing database settings: ${missing.join(", ")}`);
  const user = encodeURIComponent(settings.POSTGRES_USER!);
  const password = encodeURIComponent(settings.POSTGRES_PASSWORD!);
  const database = encodeURIComponent(settings.POSTGRES_DB!);
  return `postgresql://${user}:${password}@${settings.POSTGRES_HOST}:${settings.POSTGRES_PORT}/${database}`;
};
