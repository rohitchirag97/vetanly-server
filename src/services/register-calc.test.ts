import { describe, expect, test } from "bun:test";

import { isValidIfsc, musterCode, musterTotals, toCsv } from "@/services/register-calc";

const day = { weeklyOff: false, holiday: false, beforeJoining: false, future: false };

describe("isValidIfsc", () => {
  test("accepts real-format codes and rejects the rest", () => {
    expect(isValidIfsc("HDFC0001234")).toBe(true);
    expect(isValidIfsc("SBIN0ABC123")).toBe(true);
    expect(isValidIfsc("HDFC1001234")).toBe(false);
    expect(isValidIfsc("HDF0001234")).toBe(false);
    expect(isValidIfsc("hdfc0001234")).toBe(false);
  });
});

describe("musterCode", () => {
  test("attendance first, then holidays and weekly offs", () => {
    expect(musterCode({ ...day, status: "present", holiday: true })).toBe("P");
    expect(musterCode({ ...day, status: "incomplete" })).toBe("MP");
    expect(musterCode({ ...day, holiday: true, weeklyOff: true })).toBe("H");
    expect(musterCode({ ...day, weeklyOff: true })).toBe("WO");
    expect(musterCode({ ...day, future: true, weeklyOff: true })).toBe("");
    expect(musterCode({ ...day, beforeJoining: true })).toBe("");
  });

  test("totals split half days", () => {
    expect(musterTotals(["P", "P", "HD", "A", "L", "WO", "H", "MP"])).toEqual({ present: 2.5, absent: 1.5, leave: 1, off: 2 });
  });
});

describe("toCsv", () => {
  test("quotes commas and neutralises spreadsheet formulas", () => {
    expect(toCsv(["Name", "Amount"], [["Das, Anaya", 1200.5], ["=HYPERLINK(1)", null]])).toBe(
      'Name,Amount\r\n"Das, Anaya",1200.5\r\n\'=HYPERLINK(1),\r\n',
    );
  });
});
