import { Hono } from "hono";

import { handleCustomWebhook, handleVetanlyWebhook, verifyCustomWebhook } from "@/services/messaging-delivery";

// Delivery-status callbacks from WhatsApp providers. Outside /api/v1: no login and no audit; each is
// authenticated by a signature (Vetanly's service) or an unguessable token in the URL (custom providers).
const webhookRoutes: Hono = new Hono();

// shortcut: the pre-rebrand path and header (/messaging/hazripro, X-Hazripro-Signature) stay accepted until
// the WhatsApp service is switched to the new ones; delete the alias and header fallback after that.
for (const path of ["/messaging/vetanly", "/messaging/hazripro"]) {
  webhookRoutes.post(path, async (c) => {
    const signature = c.req.header("x-vetanly-signature") ?? c.req.header("x-hazripro-signature");
    const result = await handleVetanlyWebhook(await c.req.text(), signature);
    return c.json({ updated: result.updated }, result.status);
  });
}

// Meta-style verification handshake for providers that ask for one.
webhookRoutes.get("/messaging/:token", async (c) => {
  const challenge = await verifyCustomWebhook(c.req.param("token"), c.req.query());
  return challenge === null ? c.text("Forbidden", 403) : c.text(challenge);
});

webhookRoutes.post("/messaging/:token", async (c) => {
  const result = await handleCustomWebhook(c.req.param("token"), await c.req.text());
  return c.json({ updated: result.updated }, result.status);
});

export default webhookRoutes;
