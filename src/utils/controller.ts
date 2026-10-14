import type { Context } from "hono";
import type { z } from "zod";

import { sendResponse } from "@/utils/response";
import {
  badRequest,
  firstIssue,
  missingOrganization,
  readBody,
  readOrganizationId,
  readUuid,
} from "@/utils/request";

export type OrgContext = {
  organizationId: string;
  userId: string;
};

type Handler = Context;

export const withOrganization =
  (handler: (c: Handler, ctx: OrgContext) => Promise<Response>) =>
  async (c: Handler): Promise<Response> => {
    const organizationId = readOrganizationId(c);
    if (!organizationId) return missingOrganization(c);
    return handler(c, { organizationId, userId: c.get("user").id });
  };

export const withParam = async (
  c: Handler,
  name: string,
  handler: (id: string) => Promise<Response>,
): Promise<Response> => {
  const id = readUuid(c.req.param(name));
  return id ? handler(id) : badRequest(c, `Invalid ${name}`);
};

export const withBody = async <S extends z.ZodType>(
  c: Handler,
  schema: S,
  handler: (body: z.output<S>) => Promise<Response>,
): Promise<Response> => {
  const parsed = await readBody(c, schema);
  return parsed.success
    ? handler(parsed.data)
    : badRequest(c, firstIssue(parsed.error));
};

export const withQuery = async <S extends z.ZodType>(
  c: Handler,
  schema: S,
  handler: (query: z.output<S>) => Promise<Response>,
): Promise<Response> => {
  const parsed = schema.safeParse(c.req.query());
  return parsed.success
    ? handler(parsed.data)
    : sendResponse(c, "error", firstIssue(parsed.error), null, 400);
};
