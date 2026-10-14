import { describe, expect, test } from "bun:test";

import { addDays, cycleLength, resolveRosterDay, rotationShiftOn } from "@/services/roster-calc";

// Morning x2, Night x2, Off x1: a 5-day cycle.
const pattern = [
  { shiftId: "morning", days: 2 },
  { shiftId: "night", days: 2 },
  { shiftId: null, days: 1 },
];

describe("rotationShiftOn", () => {
  test("walks the pattern from the start date and repeats it", () => {
    expect(cycleLength(pattern)).toBe(5);
    const start = "2026-11-02";
    const week = [0, 1, 2, 3, 4, 5, 6].map((n) => rotationShiftOn(pattern, start, 0, addDays(start, n)));
    expect(week).toEqual(["morning", "morning", "night", "night", null, "morning", "morning"]);
  });

  test("a cycle offset staggers crews on the same pattern", () => {
    expect(rotationShiftOn(pattern, "2026-11-02", 2, "2026-11-02")).toBe("night");
    expect(rotationShiftOn(pattern, "2026-11-02", 4, "2026-11-02")).toBe(null);
  });

  test("dates before the start still map onto the cycle", () => {
    expect(rotationShiftOn(pattern, "2026-11-02", 0, "2026-11-01")).toBe(null);
  });
});

describe("resolveRosterDay", () => {
  const assignments = [{ startsOn: "2026-11-02", endsOn: "2026-11-30", cycleOffset: 0, pattern }];

  test("an override wins, then the rotation, then the default shift", () => {
    expect(resolveRosterDay({ date: "2026-11-02", override: { shiftId: "evening" }, assignments, defaultShiftId: "general" }))
      .toEqual({ shiftId: "evening", source: "override" });
    expect(resolveRosterDay({ date: "2026-11-06", assignments, defaultShiftId: "general" }))
      .toEqual({ shiftId: null, source: "rotation" });
    expect(resolveRosterDay({ date: "2026-12-01", assignments, defaultShiftId: "general" }))
      .toEqual({ shiftId: "general", source: "default" });
  });

  test("an override can make a rostered workday a day off", () => {
    expect(resolveRosterDay({ date: "2026-11-02", override: { shiftId: null }, assignments, defaultShiftId: "general" }))
      .toEqual({ shiftId: null, source: "override" });
  });
});
