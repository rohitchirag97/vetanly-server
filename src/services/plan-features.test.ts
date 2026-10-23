import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { ALL_FEATURES, CORE_PATHS, featureForPath, featuresOf, PLAN_FEATURES, withRequirements } from "@/services/plan-features";

describe("plan features", () => {
  test("every API module is a plan feature or declared core", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const mounted = [...index.matchAll(/app\.route\(`\$\{\$apiPrefix\}(\/[^`]+)`/g)].map((match) => match[1]!);
    expect(mounted.length).toBeGreaterThan(30);
    const unclassified = mounted.filter((path) => !CORE_PATHS.includes(path) && !featureForPath(path));
    expect(unclassified).toEqual([]);
  });

  test("a feature brings what it needs", () => {
    expect(withRequirements(["statutory"])).toEqual(["attendance", "payroll", "statutory"]);
    expect(withRequirements(["overtime", "documents"])).toEqual(["attendance", "overtime", "documents"]);
    expect(withRequirements(["Attendance", "nope"])).toEqual([]);
    for (const feature of ALL_FEATURES) {
      for (const needed of PLAN_FEATURES[feature].requires) expect(ALL_FEATURES).toContain(needed);
    }
  });

  test("paths map to their feature", () => {
    expect(featureForPath("/payroll")).toBe("payroll");
    expect(featureForPath("/payroll/abc/slips")).toBe("payroll");
    expect(featureForPath("/payroll-settings")).toBeNull();
    expect(featureForPath("/employee-record/123/documents")).toBe("documents");
    expect(featureForPath("/employee-record/123/documents/9/url")).toBe("documents");
    expect(featureForPath("/employee-record/123/profile")).toBeNull();
    expect(featureForPath("/attendance/kiosk")).toBe("attendance");
  });

  test("only a paid plan restricts features", () => {
    const plan = { paidUntil: "2027-01-01", subscriptionStatus: "active", planFeatures: ["leave"] };
    expect(featuresOf({ ...plan, accessState: "paid" })).toEqual(["leave"]);
    expect(featuresOf({ ...plan, accessState: "grace" })).toEqual(["leave"]);
    expect(featuresOf({ ...plan, accessState: "trial" })).toEqual(ALL_FEATURES);
    expect(featuresOf({ ...plan, accessState: "paid", subscriptionStatus: "trial" })).toEqual(ALL_FEATURES);
    expect(featuresOf({ ...plan, accessState: "grace", paidUntil: null })).toEqual(ALL_FEATURES);
    expect(featuresOf({ accessState: "read_only", paidUntil: null, subscriptionStatus: null, planFeatures: null })).toEqual(ALL_FEATURES);
  });
});
