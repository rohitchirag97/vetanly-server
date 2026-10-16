import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

import { getActiveMembership } from "@/services/access.services";
import { describeAction, paramsFromPath, resolveTargets } from "@/services/audit-describe";
import { writeAuditLog } from "@/services/audit.services";
import { readOrganizationId, readUuid } from "@/utils/request";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const API_PREFIX = "/api/v1";
// POST endpoints that only read, so they would only add noise to the log.
const READ_ONLY_POSTS = new Set([`${API_PREFIX}/employee/bulk/check`]);

type Body = Record<string, unknown>;

// Loopback and private ranges: in production the only peer there is our own Caddy proxy.
const PRIVATE_PEER = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.|f[cd])/i;

/** The visitor's IP. Behind the proxy every socket is the proxy's, so read the address it forwards. */
export const clientIp = (c: Context): string | null => {
  let peer: string | null = null;
  try {
    peer = getConnInfo(c).remote.address ?? null;
  } catch {
    // No socket info (e.g. tests): only the header is available.
  }
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
  // Caddy overwrites X-Forwarded-For from the internet, so it is trusted only when the proxy sent it.
  if (forwarded && (!peer || PRIVATE_PEER.test(peer))) return forwarded;
  return peer;
};

// Hono caches the parsed body, so reading it here does not disturb the handler.
const readJsonBody = async (c: Context): Promise<Body> => {
  if (!c.req.header("content-type")?.includes("application/json")) return {};
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : {};
};

const readOrgFromRequest = (c: Context, body: Body): string | null => {
  const fromQuery = readOrganizationId(c);
  if (fromQuery) return fromQuery;
  if (typeof body.organizationId === "string") {
    const fromBody = readUuid(body.organizationId);
    if (fromBody) return fromBody;
  }
  return readUuid(/\/organization\/([0-9a-f-]{36})(?:\/|$)/i.exec(c.req.path)?.[1]);
};

const readResponseMessage = async (c: Context): Promise<string | undefined> => {
  try {
    const json = (await c.res.clone().json()) as { message?: unknown };
    return typeof json.message === "string" ? json.message.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
};

// Records every state-changing request (including refused ones) once the handler has run.
// Raw request bodies are never stored, so passwords and tokens cannot leak into the log.
export const auditMiddleware = async (c: Context, next: () => Promise<void>) => {
  if (!MUTATING.has(c.req.method) || READ_ONLY_POSTS.has(c.req.path)) return next();

  const body = await readJsonBody(c);
  // Looked up before the handler so records it deletes can still be named.
  const targets = await resolveTargets(paramsFromPath(c.req.path, API_PREFIX), body);
  await next();

  const user = c.get("user") as { id: string; fname: string; lname: string } | undefined;
  const organizationId = readOrgFromRequest(c, body);
  if (!user || !organizationId) return;
  const actorName = `${user.fname} ${user.lname}`.trim();

  try {
    // Only members can write into an organization's log, so outsiders cannot pollute it.
    const membership = await getActiveMembership(organizationId, user.id);
    if (!membership) return;

    const { summary, details } = describeAction({
      actor: actorName,
      method: c.req.method,
      routePath: c.req.routePath,
      apiPrefix: API_PREFIX,
      body,
      targets,
      statusCode: c.res.status,
      message: await readResponseMessage(c),
    });

    await writeAuditLog(
      {
        organizationId,
        userId: user.id,
        userName: actorName,
        role: membership.role,
        method: c.req.method,
        path: c.req.path.slice(0, 500),
        statusCode: c.res.status,
        ipAddress: clientIp(c),
        userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
        summary,
        details,
      },
      `${c.req.method} ${c.req.routePath}`.slice(0, 200),
    );
  } catch (error) {
    console.error("Failed to write audit log", error);
  }
};
