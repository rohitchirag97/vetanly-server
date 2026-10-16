import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { clientIp } from "@/middleware/audit.middleware";

const app = new Hono().get("/", (c) => c.text(clientIp(c) ?? "none"));

/** Calls the app as if the TCP peer were `peer`, the way Bun.serve reports it. */
const ipFor = async (peer: string, forwardedFor?: string) => {
  const headers = forwardedFor ? { "x-forwarded-for": forwardedFor } : undefined;
  const bunServer = { requestIP: () => ({ address: peer, family: "IPv4", port: 1234 }) };
  return (await app.request("/", { headers }, bunServer)).text();
};

describe("clientIp", () => {
  test("behind the proxy, the forwarded visitor address is used", async () => {
    expect(await ipFor("172.18.0.5", "203.0.113.7")).toBe("203.0.113.7");
    expect(await ipFor("::ffff:172.18.0.5", "203.0.113.7, 172.18.0.5")).toBe("203.0.113.7");
  });

  test("a forged header from the internet is ignored", async () => {
    expect(await ipFor("198.51.100.9", "10.0.0.1")).toBe("198.51.100.9");
  });

  test("without a header, the socket address is used", async () => {
    expect(await ipFor("198.51.100.9")).toBe("198.51.100.9");
  });
});
