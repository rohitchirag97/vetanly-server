import type { DayStatus } from "@/services/attendance.services";

/** Indian Financial System Code: four letters (the bank), a zero, then six letters or digits (the branch). */
export const isValidIfsc = (ifsc: string) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc);

const STATUS_CODE: Record<DayStatus, string> = {
  present: "P",
  half_day: "HD",
  absent: "A",
  on_leave: "L",
  // A check-in or check-out is missing, so the day cannot be counted yet.
  incomplete: "MP",
};

/** One muster-roll cell. Attendance wins over an off day: work on a holiday shows as P. */
export const musterCode = (day: {
  status?: DayStatus;
  weeklyOff: boolean;
  holiday: boolean;
  beforeJoining: boolean;
  future: boolean;
}) => {
  if (day.status) return STATUS_CODE[day.status];
  if (day.beforeJoining || day.future) return "";
  if (day.holiday) return "H";
  if (day.weeklyOff) return "WO";
  return "";
};

export const MUSTER_LEGEND =
  "P present · HD half day · A absent · L leave · WO weekly off · H holiday · MP missing punch (check-in or check-out not recorded).";

/** Totals for one muster-roll row: a half day counts half present and half absent. */
export const musterTotals = (codes: string[]) => {
  const count = (code: string) => codes.filter((c) => c === code).length;
  const half = count("HD") / 2;
  return {
    present: count("P") + half,
    absent: count("A") + half,
    leave: count("L"),
    off: count("WO") + count("H"),
  };
};

// Leading =, +, - or @ makes spreadsheets run the cell as a formula.
const csvCell = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const toCsv = (header: string[], rows: (string | number | null)[][]) =>
  [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
