import type { Context } from "hono";

import { authenticateKiosk } from "@/services/kiosk.services";
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
  c.set("kiosk", kiosk);
  await next();
};
