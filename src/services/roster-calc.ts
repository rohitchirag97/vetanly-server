import type { ShiftRotationStep } from "@/drizzle/schema";

/**
 * Pure roster rules. The shift on a date is, in order: an override for that day, else the rotation
 * the employee is on that day, else their default shift. A null shift means a rostered day off.
 */

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

export const cycleLength = (pattern: ShiftRotationStep[]) => pattern.reduce((sum, step) => sum + step.days, 0);

/** The step of the pattern that falls on the date, for an assignment starting at startsOn. */
export const rotationShiftOn = (
  pattern: ShiftRotationStep[],
  startsOn: string,
  cycleOffset: number,
  date: string,
): string | null => {
  const length = cycleLength(pattern);
  if (length <= 0) return null;
  const elapsed = dayNumber(date) - dayNumber(startsOn) + cycleOffset;
  let position = ((elapsed % length) + length) % length;
  for (const step of pattern) {
    if (position < step.days) return step.shiftId;
    position -= step.days;
  }
  return null;
};

export type RosterSource = "override" | "rotation" | "default";
export type RosterDay = { shiftId: string | null; source: RosterSource };

export type RosterAssignment = {
  startsOn: string;
  endsOn: string | null;
  cycleOffset: number;
  pattern: ShiftRotationStep[];
};

export const resolveRosterDay = (input: {
  date: string;
  override?: { shiftId: string | null };
  assignments: RosterAssignment[];
  defaultShiftId: string | null;
}): RosterDay => {
  if (input.override) return { shiftId: input.override.shiftId, source: "override" };
  const assignment = input.assignments.find(
    (item) => item.startsOn <= input.date && (item.endsOn === null || input.date <= item.endsOn),
  );
  if (assignment) {
    return { shiftId: rotationShiftOn(assignment.pattern, assignment.startsOn, assignment.cycleOffset, input.date), source: "rotation" };
  }
  return { shiftId: input.defaultShiftId, source: "default" };
};

export const eachDay = (from: string, to: string) => {
  const days: string[] = [];
  for (let day = dayNumber(from); day <= dayNumber(to); day += 1) {
    days.push(new Date(day * DAY_MS).toISOString().slice(0, 10));
  }
  return days;
};

export const addDays = (date: string, days: number) => new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
