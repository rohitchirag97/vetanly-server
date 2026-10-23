import type { Context } from "hono";

import { authenticateKiosk } from "@/services/kiosk.services";
import { requireFeature } from "@/services/billing-access.services";
import { readUuid } from "@/utils/request";
import { sendResponse } from "@/utils/response";

export const authenticateKioskMiddleware = async (
  c: Context,
  next: () => Promise<void>,
) => {
  const kioskId = readUuid(c.req.header("X-Kiosk-Id"));
  const apiKey = c.req.header("X-Kiosk-Key");
  const kiosk = kioskId && apiKey ? await authenticateKiosk(kioskId, apiKey) : null;
  if (!kiosk) return sendResponse(c, "error", "Unauthorized", null, 401);
  const attendance = await requireFeature(kiosk.organizationId, "attendance");
  if (!attendance.ok) return sendResponse(c, "error", attendance.message!, { code: "FEATURE_NOT_IN_PLAN", feature: "attendance" }, 403);
  c.set("kiosk", kiosk);
  await next();
};
