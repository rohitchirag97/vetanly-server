import { describe, expect, test } from "bun:test";

import { reviewKioskFor } from "@/services/kiosk-review";

const config = { kioskId: "kiosk-1", pairingCode: "246810", enrollmentCode: "135790" };

describe("kiosk review codes", () => {
  test("each code opens only its own kind", () => {
    expect(reviewKioskFor(config, "pair", "246810")).toBe("kiosk-1");
    expect(reviewKioskFor(config, "enroll", "135790")).toBe("kiosk-1");
    expect(reviewKioskFor(config, "pair", "135790")).toBeNull();
    expect(reviewKioskFor(config, "enroll", "246810")).toBeNull();
  });

  test("other codes fall through to normal pairing", () => {
    expect(reviewKioskFor(config, "pair", "000000")).toBeNull();
  });

  test("unset or empty config disables review access", () => {
    expect(reviewKioskFor({}, "pair", "246810")).toBeNull();
    expect(reviewKioskFor({ ...config, kioskId: "" }, "pair", "246810")).toBeNull();
    expect(reviewKioskFor({ ...config, pairingCode: "" }, "pair", "")).toBeNull();
  });
});
