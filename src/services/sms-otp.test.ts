import { afterEach, describe, expect, mock, test } from "bun:test";
import { UnrecoverableError } from "bullmq";

import { sendSmsOtp, smsMobile } from "@/services/sms-otp";

// A stand-in for apitxt, so the tests never send a real SMS or spend credits.
const realFetch = globalThis.fetch;
const fakeApitxt = (status: number, body: unknown) => {
  const fn = mock(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
};
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("smsMobile", () => {
  test("keeps Indian mobile numbers with their country code", () => {
    expect(smsMobile("919876543210")).toBe("919876543210");
    expect(smsMobile("+91 98765 43210")).toBe("919876543210");
  });

  test("refuses other countries and landlines", () => {
    expect(smsMobile("14155551234")).toBeNull();
    expect(smsMobile("911123456789")).toBeNull();
  });
});

describe("sendSmsOtp", () => {
  test("posts the key and code in the body, not the URL", async () => {
    const fetch = fakeApitxt(200, { status: "success", message: "Sms OTP Sent Successfully" });
    await sendSmsOtp("919876543210", "123456", "KEY");
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://apitxt.com/api/sendOTP");
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      authkey: "KEY",
      mobile: "919876543210",
      otp: "123456",
      channel: "sms",
    });
  });

  test("a refusal is not retried, a server error is", async () => {
    fakeApitxt(200, { status: "error", message: "Insufficient balance" });
    await expect(sendSmsOtp("919876543210", "123456", "KEY")).rejects.toBeInstanceOf(UnrecoverableError);
    fakeApitxt(502, null);
    const error = await sendSmsOtp("919876543210", "123456", "KEY").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  test("never calls apitxt for a non-Indian number", async () => {
    const fetch = fakeApitxt(200, { status: "success" });
    await expect(sendSmsOtp("14155551234", "123456", "KEY")).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
