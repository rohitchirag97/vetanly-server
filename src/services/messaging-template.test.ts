import { describe, expect, test } from "bun:test";

import { mapStatus, nextStatus, readPath, renderJsonBody, renderText, unknownPlaceholders } from "@/services/messaging-template";

const ctx = {
  phone: "919876543210",
  recipientName: 'Asha "AJ" Patel',
  template: "salary_slip_v2",
  language: "en",
  params: ["Asha", "Acme", "Sep 2026"],
  documentUrl: "https://files.example.com/slip.pdf?sig=a&b=c",
  documentFilename: "slip.pdf",
  reference: "log-123",
  secrets: { apiKey: "sk_live_1" },
};

describe("custom provider templates", () => {
  test("AiSensy-style body with escaping and a raw params array", () => {
    const body = renderJsonBody(
      `{"apiKey":"{{secret.apiKey}}","campaignName":"{{template}}","destination":"{{phone_plus}}","userName":"{{recipient_name}}","templateParams":{{params_json}},"media":{"url":"{{document_url}}","filename":"{{document_filename}}"}}`,
      ctx,
    );
    expect(body).toEqual({
      apiKey: "sk_live_1",
      campaignName: "salary_slip_v2",
      destination: "+919876543210",
      userName: 'Asha "AJ" Patel',
      templateParams: ["Asha", "Acme", "Sep 2026"],
      media: { url: "https://files.example.com/slip.pdf?sig=a&b=c", filename: "slip.pdf" },
    });
  });

  test("numbered params and plain-text headers", () => {
    expect(renderJsonBody(`{"a":"{{param1}}","c":"{{param3}}","missing":"{{param7}}"}`, ctx)).toEqual({ a: "Asha", c: "Sep 2026", missing: "" });
    expect(renderText("Bearer {{secret.apiKey}}", ctx)).toBe("Bearer sk_live_1");
  });

  test("unknown placeholders and unsaved secrets are reported", () => {
    expect(unknownPlaceholders(`{"x":"{{phnoe}}","k":"{{secret.token}}","ok":"{{phone}}","p":{{params_json}}}`, ["apiKey"])).toEqual(["phnoe", "secret.token"]);
  });

  test("a body that is not valid JSON fails", () => {
    expect(() => renderJsonBody(`{"a": {{phone}}`, ctx)).toThrow();
  });
});

describe("reading provider responses and callbacks", () => {
  test("dot paths with array indexes (Meta-style webhook)", () => {
    const meta = { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered" }] } }] }] };
    expect(readPath(meta, "entry.0.changes.0.value.statuses.0.id")).toBe("wamid.1");
    expect(readPath(meta, "entry.1.changes")).toBeUndefined();
  });

  test("status words map case-insensitively", () => {
    const map = { delivered: ["DELIVERED"], read: ["read", "seen"], failed: ["failed", "undelivered"] };
    expect(mapStatus("Delivered", map)).toBe("delivered");
    expect(mapStatus("seen", map)).toBe("read");
    expect(mapStatus("queued", map)).toBeNull();
  });

  test("statuses only move forward", () => {
    expect(nextStatus("sent", "delivered")).toBe("delivered");
    expect(nextStatus("read", "delivered")).toBeNull();
    expect(nextStatus("delivered", "failed")).toBe("failed");
    expect(nextStatus("read", "failed")).toBeNull();
    expect(nextStatus("failed", "read")).toBeNull();
  });
});
