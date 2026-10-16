import { describe, expect, test } from "bun:test";

import { workDateOf } from "@/services/work-day";

const DAY = { startTime: "09:00", endTime: "18:00" };
const NIGHT = { startTime: "22:00", endTime: "06:00" };
const at = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};
const TODAY = "2026-10-15";
const YESTERDAY = "2026-10-14";

describe("workDateOf", () => {
  test("a day shift that runs past midnight is paid on the day it started", () => {
    expect(workDateOf(TODAY, at("01:30"), DAY, DAY)).toBe(YESTERDAY);
    expect(workDateOf(TODAY, at("23:40"), DAY, DAY)).toBe(TODAY);
  });

  test("a normal day stays on its own date, early arrivals included", () => {
    expect(workDateOf(TODAY, at("07:00"), DAY, DAY)).toBe(TODAY);
    expect(workDateOf(TODAY, at("08:55"), DAY, DAY)).toBe(TODAY);
    expect(workDateOf(TODAY, at("18:30"), DAY, DAY)).toBe(TODAY);
  });

  test("a night shift keeps its check-out, late arrival and overtime on the night it started", () => {
    expect(workDateOf(TODAY, at("21:50"), NIGHT, NIGHT)).toBe(TODAY);
    expect(workDateOf(TODAY, at("00:30"), NIGHT, NIGHT)).toBe(YESTERDAY);
    expect(workDateOf(TODAY, at("06:20"), NIGHT, NIGHT)).toBe(YESTERDAY);
    expect(workDateOf(TODAY, at("12:00"), NIGHT, NIGHT)).toBe(YESTERDAY);
  });

  test("a rotation from nights to days splits the morning correctly", () => {
    expect(workDateOf(TODAY, at("06:10"), DAY, NIGHT)).toBe(YESTERDAY);
    expect(workDateOf(TODAY, at("08:55"), DAY, NIGHT)).toBe(TODAY);
  });

  test("days without a shift fall back to 09:00-18:00", () => {
    expect(workDateOf(TODAY, at("02:00"), null, null)).toBe(YESTERDAY);
    expect(workDateOf(TODAY, at("09:10"), null, null)).toBe(TODAY);
  });
});
