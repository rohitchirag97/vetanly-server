import { describe, expect, test } from "bun:test";

import { computeAccess, estimatePlanAmount } from "@/services/billing-access.services";

const trialEndsAt = new Date("2026-10-28T09:00:00Z");
const at = (iso: string) => new Date(iso);
const access = (now: string, paidUntil: string | null = null, subscriptionStatus: string | null = null) =>
  computeAccess({ trialEndsAt, paidUntil, subscriptionStatus }, at(now));

describe("computeAccess", () => {
  test("trial counts down to its end", () => {
    expect(access("2026-10-14T09:00:00Z")).toMatchObject({ state: "trial", daysLeft: 14 });
    // The next afternoon, about 13.2 days remain: 13 calendar days, not 14.
    expect(access("2026-10-15T04:16:00Z")).toMatchObject({ state: "trial", daysLeft: 13 });
    // Late the evening before it ends (India time), one day left; on the last day, "ends today".
    expect(access("2026-10-27T17:00:00Z")).toMatchObject({ state: "trial", daysLeft: 1 });
    expect(access("2026-10-28T08:00:00Z")).toMatchObject({ state: "trial", daysLeft: 0 });
  });

  test("grace lasts 7 days after the trial, then read-only", () => {
    expect(access("2026-10-28T10:00:00Z")).toMatchObject({ state: "grace", daysLeft: 7 });
    expect(access("2026-11-04T08:59:00Z")).toMatchObject({ state: "grace", daysLeft: 0 });
    expect(access("2026-11-04T09:01:00Z")).toMatchObject({ state: "read_only", daysLeft: 0 });
  });

  test("a paid day lasts until midnight India time", () => {
    // 2026-11-30 23:59 IST is 18:29 UTC.
    expect(access("2026-11-30T18:00:00Z", "2026-11-30", "active")).toMatchObject({ state: "paid", daysLeft: 0 });
    expect(access("2026-11-30T18:31:00Z", "2026-11-30", "active").state).toBe("grace");
  });

  test("paying during the trial switches to paid", () => {
    expect(access("2026-10-20T00:00:00Z", "2026-11-30", "active").state).toBe("paid");
  });

  test("a paid period that ended before the trial ends leaves the trial in charge", () => {
    expect(access("2026-10-20T00:00:00Z", "2026-10-15", "active").state).toBe("trial");
  });

  test("a cancelled subscription gives no paid access", () => {
    expect(access("2026-11-20T00:00:00Z", "2026-12-31", "cancelled").state).toBe("read_only");
  });

  test("a new organization stays inactive until the owner starts the trial", () => {
    const inactive = computeAccess({ trialEndsAt: null, paidUntil: null, subscriptionStatus: null }, at("2026-10-14T09:00:00Z"));
    expect(inactive).toMatchObject({ state: "inactive", daysLeft: 0, accessEndsAt: null });
  });

  test("paying without ever starting the trial gives paid access", () => {
    expect(
      computeAccess({ trialEndsAt: null, paidUntil: "2026-11-30", subscriptionStatus: "active" }, at("2026-10-20T00:00:00Z")).state,
    ).toBe("paid");
  });

  test("a cancelled subscription with no trial is read-only, not inactive", () => {
    expect(
      computeAccess({ trialEndsAt: null, paidUntil: "2026-12-31", subscriptionStatus: "cancelled" }, at("2026-10-20T00:00:00Z")).state,
    ).toBe("read_only");
  });

  test("paying again after read-only restores full access", () => {
    expect(access("2026-12-10T00:00:00Z", "2027-01-09", "active").state).toBe("paid");
  });
});

describe("estimatePlanAmount", () => {
  test("flat per-employee price", () => {
    expect(estimatePlanAmount({ priceAmount: "0", includedEmployees: 0, overagePrice: "49.00" }, 25)).toBe("1225.00");
  });

  test("base price with included employees and overage", () => {
    const plan = { priceAmount: "999.00", includedEmployees: 10, overagePrice: "39.50" };
    expect(estimatePlanAmount(plan, 8)).toBe("999.00");
    expect(estimatePlanAmount(plan, 13)).toBe("1117.50");
  });
});
