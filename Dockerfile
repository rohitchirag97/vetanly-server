# --- Production dependencies only: what the running API needs ---
FROM oven/bun:1.3.5-alpine AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Migrations: adds drizzle-kit. Used by `docker compose run --rm migrate` ---
FROM oven/bun:1.3.5-alpine AS migrate-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# drizzle-kit runs on Node: it loads node:sqlite, which Bun does not provide.
FROM node:24.22.1-alpine AS migrate
WORKDIR /app
COPY --from=migrate-deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts tsconfig.json ./
COPY src ./src
CMD ["node_modules/.bin/drizzle-kit", "migrate"]

# --- Runtime (default target): the API and its background queue workers in one process ---
FROM oven/bun:1.3.5-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# Uploads land in /app/storage (a mounted volume); the image itself stays read-only to the app user.
RUN mkdir -p /app/storage && chown bun:bun /app/storage
USER bun
EXPOSE 8000
CMD ["bun", "src/index.ts"]
