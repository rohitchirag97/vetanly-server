import { describe, expect, test } from "bun:test";

import { carriedInto, compOffAvailable } from "@/services/leave-balance";

const none = new Map<number, number>();

describe("carriedInto", () => {
  test("unused days roll over, capped each year", () => {
    // 12 a year, cap 10: 2024 used 4 -> carry 8; 2025: 12 + 8 - 5 = 15 -> carry 10.
    const usedByYear = new Map([[2024, 4], [2025, 5]]);
    expect(carriedInto({ year: 2026, firstYear: 2024, allowance: 12, cap: 10, usedByYear, creditsByYear: none })).toBe(10);
    expect(carriedInto({ year: 2025, firstYear: 2024, allowance: 12, cap: 10, usedByYear, creditsByYear: none })).toBe(8);
  });

  test("no cap means nothing carries, and an overdrawn year carries zero", () => {
    expect(carriedInto({ year: 2026, firstYear: 2024, allowance: 12, cap: null, usedByYear: none, creditsByYear: none })).toBe(0);
    const overdrawn = new Map([[2025, 20]]);
    expect(carriedInto({ year: 2026, firstYear: 2025, allowance: 12, cap: 10, usedByYear: overdrawn, creditsByYear: none })).toBe(0);
  });

  test("the first year carries nothing in", () => {
    expect(carriedInto({ year: 2026, firstYear: 2026, allowance: 12, cap: 10, usedByYear: none, creditsByYear: none })).toBe(0);
  });
});

describe("compOffAvailable", () => {
  const credits = [
    { workedOn: "2026-08-02", days: 1 },
    { workedOn: "2026-09-06", days: 1 },
    { workedOn: "2026-10-04", days: 0.5 },
  ];

  test("without expiry every credit counts, minus what was taken", () => {
    const taken = [{ startDate: "2026-09-10", days: 1 }];
    expect(compOffAvailable({ credits, taken, asOf: "2026-10-16", validityDays: null })).toBe(1.5);
  });

  test("expired credits drop out, along with leave taken before the oldest valid one", () => {
    // 60-day validity on 16 Oct: the August credit has expired; leave taken in August used it.
    const taken = [{ startDate: "2026-08-20", days: 1 }];
    expect(compOffAvailable({ credits, taken, asOf: "2026-10-16", validityDays: 60 })).toBe(1.5);
  });

  test("credits earned after the date do not count yet", () => {
    expect(compOffAvailable({ credits, taken: [], asOf: "2026-09-01", validityDays: null })).toBe(1);
  });
});
