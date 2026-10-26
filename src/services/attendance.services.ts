import { and, desc, eq, gte, inArray, lte, min, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  attendanceLogsTable,
  branchesTable,
  leaveRequestsTable,
  organizationPayrollSettingsTable,
  userOrganizationsTable,
  UserRole,
  usersTable,
  type AttendanceEventType,
  type AttendanceSource,
  type FaceVerificationStatus,
} from "@/drizzle/schema";
import {
  ALL_ROLES,
  branchFilter,
  canManageMember,
  getEmployeeMembership,
  PEOPLE_MANAGER_ROLES,
  requireRole,
} from "@/services/access.services";
import type { AuthenticatedKiosk } from "@/services/kiosk.services";
import { eachDate, workedAfterBreak } from "@/services/payroll-calc";
import { createLeaveRequest, updateLeaveStatus } from "@/services/leave.services";
import { holidayDatesBetween, holidaysForBranch } from "@/services/holiday.services";
import { checkGeofence } from "@/services/geofence";
import { isAdminAttendanceEditEnabled, parseWeeklyOff } from "@/services/payroll-settings.services";
import { enqueueAttendance } from "@/queue/producer/recordAttendance";
import { loadRoster } from "@/services/roster.services";
import { type ShiftTimes, workDateOf } from "@/services/work-day";
import type { AttendanceJob } from "@/queue/types";
import { fail, isUniqueViolation, ok, type ServiceResult } from "@/utils/result";
import type {
  bulkManualAttendanceSchema,
  dailyAttendanceQuerySchema,
  gpsAttendanceSchema,
  kioskAttendanceSchema,
  listAttendanceQuerySchema,
  manualAttendanceSchema,
} from "@/validator/kiosk-attendance.validator";

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

type AttendanceLog = {
  id: string;
  employeeId: string;
  employeeName: string;
  kioskId: string | null;
  eventType: AttendanceEventType;
  source: AttendanceSource;
  faceVerificationStatus: FaceVerificationStatus;
  externalEventId: string | null;
  occurredAt: Date;
  recordedAt: Date;
};

const selectLogs = (where: SQL | undefined) =>
  db
    .select({
      id: attendanceLogsTable.id,
      employeeId: userOrganizationsTable.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      kioskId: attendanceLogsTable.kioskId,
      eventType: attendanceLogsTable.eventType,
      source: attendanceLogsTable.source,
      faceVerificationStatus: attendanceLogsTable.faceVerificationStatus,
      externalEventId: attendanceLogsTable.externalEventId,
      occurredAt: attendanceLogsTable.occurredAt,
      recordedAt: attendanceLogsTable.recordedAt,
    })
    .from(attendanceLogsTable)
    .innerJoin(
      userOrganizationsTable,
      eq(userOrganizationsTable.id, attendanceLogsTable.userOrganizationId),
    )
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .where(where);

type LogRow = Awaited<ReturnType<typeof selectLogs>>[number];

const toLog = ({ fname, lname, ...row }: LogRow): AttendanceLog => ({
  ...row,
  employeeName: `${fname} ${lname}`.trim(),
});

const getLogById = async (id: string) => {
  const [row] = await selectLogs(eq(attendanceLogsTable.id, id)).limit(1);
  return row ? toLog(row) : null;
};

const resolveOccurredAt = (value?: string): Date | null => {
  const occurredAt = value ? new Date(value) : new Date();
  return occurredAt.getTime() > Date.now() + MAX_FUTURE_SKEW_MS ? null : occurredAt;
};

export type AttendanceReceipt = {
  externalEventId: string | null;
  occurredAt: Date;
  /** True when the write was handed to the background worker. */
  queued: boolean;
};

/** Persists an attendance punch. Safe to repeat: a duplicate kiosk event is ignored. */
export const insertAttendance = async (job: AttendanceJob) => {
  try {
    await db.insert(attendanceLogsTable).values({
      organizationId: job.organizationId,
      userOrganizationId: job.userOrganizationId,
      kioskId: job.kioskId,
      eventType: job.eventType,
      source: job.source,
      faceVerificationStatus: job.source === "kiosk" ? "verified" : "not_applicable",
      externalEventId: job.externalEventId,
      faceMatchScore: job.faceMatchScore?.toFixed(4),
      livenessPassed: job.livenessPassed,
      faceTemplateId: job.faceTemplateId,
      occurredAt: new Date(job.occurredAt),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
};

const submitAttendance = async (job: AttendanceJob): Promise<AttendanceReceipt> => {
  const receipt = {
    externalEventId: job.externalEventId ?? null,
    occurredAt: new Date(job.occurredAt),
  };
  try {
    await enqueueAttendance(job);
    return { ...receipt, queued: true };
  } catch (error) {
    // Redis is unavailable: write directly rather than losing the punch.
    console.error("Attendance queue unavailable, writing directly:", error);
    await insertAttendance(job);
    return { ...receipt, queued: false };
  }
};

const MINUTE_MS = 60_000;

/** Rules shared by kiosk and manual punches so both stay consistent. */
const checkPunchRules = async (
  organizationId: string,
  userOrganizationId: string,
  eventType: AttendanceEventType,
  occurredAt: Date,
  utcOffsetMinutes: number,
): Promise<ServiceResult<never> | null> => {
  const oppositeEventType = eventType === "check_in" ? "check_out" : "check_in";
  const [oppositePunchAtSameTime] = await db
    .select({ id: attendanceLogsTable.id })
    .from(attendanceLogsTable)
    .where(
      and(
        eq(attendanceLogsTable.organizationId, organizationId),
        eq(attendanceLogsTable.userOrganizationId, userOrganizationId),
        eq(attendanceLogsTable.eventType, oppositeEventType),
        eq(attendanceLogsTable.occurredAt, occurredAt),
      ),
    )
    .limit(1);
  if (oppositePunchAtSameTime) {
    return fail(
      "conflict",
      "Check-in and check-out cannot use the same time. Choose the actual punch time.",
    );
  }

  // Leave and the one-check-in rule follow the work day, so a night shift's after-midnight punch is not refused.
  const workDate = await workDateForPunch(organizationId, userOrganizationId, occurredAt, utcOffsetMinutes);
  const [leave] = await db
    .select({ id: leaveRequestsTable.id })
    .from(leaveRequestsTable)
    .where(
      and(
        eq(leaveRequestsTable.organizationId, organizationId),
        eq(leaveRequestsTable.userOrganizationId, userOrganizationId),
        eq(leaveRequestsTable.status, "approved"),
        eq(leaveRequestsTable.isHalfDay, false),
        lte(leaveRequestsTable.startDate, workDate),
        gte(leaveRequestsTable.endDate, workDate),
      ),
    )
    .limit(1);
  if (leave) return fail("conflict", "This employee is on approved leave on that date");

  if (
    eventType === "check_in" &&
    (await hasCheckInOnWorkDay(organizationId, userOrganizationId, workDate, utcOffsetMinutes))
  ) {
    return fail("conflict", "This employee has already checked in on that date");
  }
  return null;
};

/** The work day a punch belongs to for this employee: see work-day.ts. */
const workDateForPunch = async (
  organizationId: string,
  userOrganizationId: string,
  occurredAt: Date,
  utcOffsetMinutes: number,
) => {
  const offsetMs = utcOffsetMinutes * MINUTE_MS;
  const localDate = new Date(occurredAt.getTime() + offsetMs).toISOString().slice(0, 10);
  const roster = await loadRoster(organizationId, previousDate(localDate), localDate, [userOrganizationId]);
  return workDateAt(occurredAt, offsetMs, (day) => shiftTimes(roster, userOrganizationId, day));
};

/** The employee's punches on one work day, oldest first. */
const punchesOnWorkDay = async (
  organizationId: string,
  userOrganizationId: string,
  workDate: string,
  utcOffsetMinutes: number,
) => {
  const offsetMs = utcOffsetMinutes * MINUTE_MS;
  // A work day's punches fall on its own calendar date or, after midnight, the next one.
  const from = Date.parse(`${workDate}T00:00:00Z`) - offsetMs;
  const rows = await db
    .select({ eventType: attendanceLogsTable.eventType, occurredAt: attendanceLogsTable.occurredAt })
    .from(attendanceLogsTable)
    .where(
      and(
        eq(attendanceLogsTable.organizationId, organizationId),
        eq(attendanceLogsTable.userOrganizationId, userOrganizationId),
        gte(attendanceLogsTable.occurredAt, new Date(from)),
        lte(attendanceLogsTable.occurredAt, new Date(from + 2 * DAY_MINUTES * MINUTE_MS - 1)),
      ),
    )
    .orderBy(attendanceLogsTable.occurredAt);
  if (!rows.length) return rows;
  const roster = await loadRoster(organizationId, previousDate(workDate), nextDate(workDate), [userOrganizationId]);
  return rows.filter(
    (row) => workDateAt(row.occurredAt, offsetMs, (day) => shiftTimes(roster, userOrganizationId, day)) === workDate,
  );
};

const hasCheckInOnWorkDay = async (
  organizationId: string,
  userOrganizationId: string,
  workDate: string,
  utcOffsetMinutes: number,
) =>
  (await punchesOnWorkDay(organizationId, userOrganizationId, workDate, utcOffsetMinutes)).some(
    (row) => row.eventType === "check_in",
  );

/** A face seen again within this window is the same visit, not a new punch. */
const KIOSK_PUNCH_COOLDOWN_MS = 15 * MINUTE_MS;

export type KioskAttendanceReceipt = AttendanceReceipt & {
  eventType: AttendanceEventType;
  /** True when the punch fell inside the cooldown and the earlier punch was returned instead. */
  alreadyRecorded: boolean;
};

export const recordKioskAttendance = async (
  kiosk: AuthenticatedKiosk,
  input: z.infer<typeof kioskAttendanceSchema>,
): Promise<ServiceResult<KioskAttendanceReceipt>> => {
  const membership = await getEmployeeMembership(
    kiosk.organizationId,
    input.employeeId,
  );
  if (!membership || !membership.isActive) {
    return fail("not-found", "Employee not found in this organization");
  }
  const occurredAt = resolveOccurredAt(input.occurredAt);
  if (!occurredAt) return fail("invalid", "Event time cannot be in the future");

  if (kiosk.requireLiveness && input.livenessPassed !== true) {
    return fail("invalid", "Liveness check is required");
  }
  if (kiosk.faceMatchThreshold !== null) {
    if (input.faceMatchScore === undefined || input.faceMatchScore < kiosk.faceMatchThreshold) {
      return fail("invalid", "Face match score is below the required threshold");
    }
  }

  // Measured from the punch's own time, so a replayed offline punch hits its earlier copy.
  const [recent] = await db
    .select({ eventType: attendanceLogsTable.eventType, occurredAt: attendanceLogsTable.occurredAt })
    .from(attendanceLogsTable)
    .where(
      and(
        eq(attendanceLogsTable.organizationId, kiosk.organizationId),
        eq(attendanceLogsTable.userOrganizationId, membership.id),
        gte(attendanceLogsTable.occurredAt, new Date(occurredAt.getTime() - KIOSK_PUNCH_COOLDOWN_MS)),
        lte(attendanceLogsTable.occurredAt, occurredAt),
      ),
    )
    .orderBy(desc(attendanceLogsTable.occurredAt))
    .limit(1);
  if (recent) {
    return ok({
      externalEventId: input.externalEventId ?? null,
      occurredAt: recent.occurredAt,
      queued: false,
      eventType: recent.eventType,
      alreadyRecorded: true,
    });
  }

  // Without an explicit type: the work day's first punch is the check-in, every later one a check-out.
  // The work day, not the calendar date, so a check-out after midnight is never mistaken for a new check-in.
  const eventType =
    input.eventType ??
    ((await hasCheckInOnWorkDay(
      kiosk.organizationId,
      membership.id,
      await workDateForPunch(kiosk.organizationId, membership.id, occurredAt, input.utcOffsetMinutes),
      input.utcOffsetMinutes,
    ))
      ? "check_out"
      : "check_in");

  const rejection = await checkPunchRules(
    kiosk.organizationId,
    membership.id,
    eventType,
    occurredAt,
    input.utcOffsetMinutes,
  );
  if (rejection) return rejection;

  // The event id makes the punch idempotent, so one is always assigned.
  const job: AttendanceJob = {
    organizationId: kiosk.organizationId,
    userOrganizationId: membership.id,
    source: "kiosk",
    kioskId: kiosk.id,
    eventType,
    externalEventId: input.externalEventId ?? crypto.randomUUID(),
    occurredAt: occurredAt.toISOString(),
    faceMatchScore: input.faceMatchScore,
    livenessPassed: input.livenessPassed,
    faceTemplateId: input.faceTemplateId,
  };
  return ok({ ...(await submitAttendance(job)), eventType, alreadyRecorded: false });
};

export const recordManualAttendance = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof manualAttendanceSchema>,
): Promise<ServiceResult<AttendanceReceipt>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const membership = await getEmployeeMembership(organizationId, input.employeeId);
  if (!membership || !membership.isActive) {
    return fail("not-found", "Employee not found in this organization");
  }
  if (!canManageMember(access.data, membership)) return fail("forbidden");
  const occurredAt = resolveOccurredAt(input.occurredAt);
  if (!occurredAt) return fail("invalid", "Event time cannot be in the future");

  const rejection = await checkPunchRules(
    organizationId,
    membership.id,
    input.eventType,
    occurredAt,
    input.utcOffsetMinutes,
  );
  if (rejection) return rejection;

  // Manual entries are low-volume and the administrator expects them to be
  // visible as soon as the request succeeds. Persist them before responding;
  // kiosk traffic remains queued for background processing.
  await insertAttendance({
    organizationId,
    userOrganizationId: membership.id,
    source: "manual",
    eventType: input.eventType,
    occurredAt: occurredAt.toISOString(),
  });
  return ok({
    externalEventId: null,
    occurredAt,
    queued: false,
  });
};

export type BulkAttendanceResult = {
  employeeId: string;
  status: "present" | "half_day" | "on_leave" | "absent";
  ok: boolean;
  message?: string;
};

/**
 * Daily register: converts a status per employee into the same punches or
 * leave records the single manual entry uses. Nothing here touches kiosk logic.
 */
export const recordBulkManualAttendance = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof bulkManualAttendanceSchema>,
): Promise<ServiceResult<BulkAttendanceResult[]>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const [people, [settings]] = await Promise.all([
    db
      .select({ employeeId: userOrganizationsTable.userId, membershipId: userOrganizationsTable.id })
      .from(userOrganizationsTable)
      .where(eq(userOrganizationsTable.organizationId, organizationId)),
    db
      .select({ half: organizationPayrollSettingsTable.halfDayThresholdPercent })
      .from(organizationPayrollSettingsTable)
      .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
      .limit(1),
  ]);
  // Punch times come from the shift rostered on that date, not just the employee's default shift.
  const roster = await loadRoster(organizationId, input.date, input.date, people.map((person) => person.membershipId));
  const shiftByEmployee = new Map(
    people.flatMap((person) => {
      const shift = roster.byMembership.get(person.membershipId)?.get(input.date)?.shift;
      return shift ? [[person.employeeId, { start: shift.startTime, end: shift.endTime, breakMinutes: shift.breakMinutes }] as const] : [];
    }),
  );
  const halfPercent = Number(settings?.half ?? 50);

  const toMinutes = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return h! * 60 + m!;
  };
  const atMinutes = (minutes: number) => {
    const [y, mo, d] = input.date.split("-").map(Number);
    return new Date(
      Date.UTC(y!, mo! - 1, d!, 0, minutes) - input.utcOffsetMinutes * MINUTE_MS,
    ).toISOString();
  };

  const results: BulkAttendanceResult[] = [];
  for (const entry of input.entries) {
    const { employeeId, status } = entry;
    const report = (ok: boolean, message?: string) =>
      results.push({ employeeId, status, ok, message });

    if (status === "absent") {
      report(true, "No attendance recorded");
      continue;
    }

    if (status === "on_leave") {
      const created = await createLeaveRequest(organizationId, requesterId, {
        employeeId,
        leaveTypeId: input.leaveTypeId!,
        startDate: input.date,
        endDate: input.date,
        isHalfDay: false,
        reason: "Marked on leave from the attendance register",
      });
      if (!created.ok) {
        report(false, created.message);
        continue;
      }
      const approved = await updateLeaveStatus(organizationId, requesterId, created.data.id, {
        status: "approved",
      });
      report(approved.ok, approved.ok ? undefined : approved.message);
      continue;
    }

    const shift = shiftByEmployee.get(employeeId);
    if (!shift) {
      report(false, "No shift on this date (a rostered day off, or no shift assigned)");
      continue;
    }
    const start = toMinutes(shift.start.slice(0, 5));
    let end = toMinutes(shift.end.slice(0, 5));
    if (end <= start) end += DAY_MINUTES;
    const breakMinutes = shift.breakMinutes ?? 0;

    // Half day is the minimum worked time that still counts as a half day.
    const checkOut =
      status === "half_day"
        ? start + breakMinutes + Math.ceil(((end - start - breakMinutes) * halfPercent) / 100)
        : end + entry.overtimeMinutes;

    const checkIn = await recordManualAttendance(organizationId, requesterId, {
      employeeId,
      eventType: "check_in",
      occurredAt: atMinutes(start),
      utcOffsetMinutes: input.utcOffsetMinutes,
    });
    if (!checkIn.ok) {
      report(false, `Check-in: ${checkIn.message ?? "failed"}`);
      continue;
    }
    const out = await recordManualAttendance(organizationId, requesterId, {
      employeeId,
      eventType: "check_out",
      occurredAt: atMinutes(checkOut),
      utcOffsetMinutes: input.utcOffsetMinutes,
    });
    report(out.ok, out.ok ? undefined : `Check-out: ${out.message ?? "failed"}`);
  }
  return ok(results);
};

/** Whether the requester may set others' attendance directly (people managers, when the setting is on). */
export const canEditAttendance = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  return access.ok && (await isAdminAttendanceEditEnabled(organizationId));
};

/** Daily attendance query, narrowed by role and branches after authorization. */
type DailyQuery = z.infer<typeof dailyAttendanceQuerySchema> & { employeeRole?: string; branchIds?: string[] };

export type DayStatus = "present" | "half_day" | "absent" | "incomplete" | "on_leave";

export type DailyAttendance = {
  employeeId: string;
  employeeName: string;
  date: string;
  firstCheckIn: Date | null;
  lastCheckOut: Date | null;
  workedMinutes: number | null;
  expectedMinutes: number | null;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  /** Time worked beyond the shift on a full day; before any approval. Payroll and overtime read this. */
  overtimeMinutes: number;
  status: DayStatus;
};

const DAY_MINUTES = 1440;

type Roster = Awaited<ReturnType<typeof loadRoster>>;

const shiftTimes = (roster: Roster, membershipId: string, date: string): ShiftTimes | null => {
  const shift = roster.byMembership.get(membershipId)?.get(date)?.shift;
  return shift ? { startTime: shift.startTime, endTime: shift.endTime } : null;
};

/** The work day of a punch, from the shifts rostered on its local date and the day before. */
const workDateAt = (occurredAt: Date, offsetMs: number, shiftOn: (date: string) => ShiftTimes | null) => {
  const local = new Date(occurredAt.getTime() + offsetMs);
  const localDate = local.toISOString().slice(0, 10);
  const minuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
  return workDateOf(localDate, minuteOfDay, shiftOn(localDate), shiftOn(previousDate(localDate)));
};

const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const nextDate = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MINUTES * MINUTE_MS)
    .toISOString()
    .slice(0, 10);

const previousDate = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MINUTES * MINUTE_MS)
    .toISOString()
    .slice(0, 10);

/**
 * Turns raw punches into one row per employee per local day.
 * Worked time is first check-in to last check-out, less the shift break. The day
 * is a full day at or above the full-day percentage of the shift's expected
 * time, a half day at or above the half-day percentage, otherwise absent.
 */
export const getDailyAttendance = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof dailyAttendanceQuerySchema>,
): Promise<ServiceResult<DailyAttendance[]>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role);
  if (!isManager && query.employeeId && query.employeeId !== requesterId) {
    return fail("forbidden");
  }
  const employeeId = isManager ? query.employeeId : requesterId;
  const employeeRole = access.data.role === UserRole.HR
    ? employeeId === requesterId ? UserRole.HR : UserRole.EMPLOYEE
    : undefined;
  // A manager looking at their own attendance is not limited to their branches.
  const branchIds = employeeId === requesterId ? undefined : branchFilter(access.data, query.branchId);
  const effective = { ...query, employeeId, employeeRole, branchIds };
  const punched = await computeDailyAttendance(organizationId, effective);
  const gaps = await missingDays(organizationId, effective, punched);
  return ok(
    [...punched, ...gaps].sort(
      (a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName),
    ),
  );
};

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * Rows for finished working days on which an active employee has no punches:
 * "on_leave" when an approved leave covers the day, otherwise "absent".
 * Weekly offs, holidays, days before joining and the current day are skipped.
 * Used for display only; payroll does its own day-by-day calculation.
 */
const missingDays = async (
  organizationId: string,
  query: DailyQuery,
  punched: DailyAttendance[],
): Promise<DailyAttendance[]> => {
  const offsetMs = query.utcOffsetMinutes * MINUTE_MS;
  const today = new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
  const last = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MINUTES * MINUTE_MS)
    .toISOString()
    .slice(0, 10);
  const to = query.to < last ? query.to : last;
  if (query.from > to) return [];

  const memberFilter = [
    eq(userOrganizationsTable.organizationId, organizationId),
    eq(userOrganizationsTable.isActive, true),
  ];
  if (query.employeeId) memberFilter.push(eq(userOrganizationsTable.userId, query.employeeId));
  if (query.employeeRole) memberFilter.push(eq(userOrganizationsTable.role, query.employeeRole));
  if (query.branchIds) memberFilter.push(inArray(userOrganizationsTable.branchId, query.branchIds));

  const [members, firstPunches, leaves, holidays, [settings]] = await Promise.all([
    db
      .select({
        id: userOrganizationsTable.id,
        userId: userOrganizationsTable.userId,
        hireDate: userOrganizationsTable.hireDate,
        branchId: userOrganizationsTable.branchId,
        fname: usersTable.fname,
        lname: usersTable.lname,
      })
      .from(userOrganizationsTable)
      .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
      .where(and(...memberFilter)),
    db
      .select({
        userOrganizationId: attendanceLogsTable.userOrganizationId,
        first: min(attendanceLogsTable.occurredAt),
      })
      .from(attendanceLogsTable)
      .where(eq(attendanceLogsTable.organizationId, organizationId))
      .groupBy(attendanceLogsTable.userOrganizationId),
    db
      .select({
        userOrganizationId: leaveRequestsTable.userOrganizationId,
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
      })
      .from(leaveRequestsTable)
      .where(
        and(
          eq(leaveRequestsTable.organizationId, organizationId),
          eq(leaveRequestsTable.status, "approved"),
          lte(leaveRequestsTable.startDate, to),
          gte(leaveRequestsTable.endDate, query.from),
        ),
      ),
    holidayDatesBetween(organizationId, query.from, to),
    db
      .select({ weeklyOffDays: organizationPayrollSettingsTable.weeklyOffDays })
      .from(organizationPayrollSettingsTable)
      .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
      .limit(1),
  ]);

  const weeklyOff = settings ? parseWeeklyOff(settings.weeklyOffDays) : [0];
  const firstPunchOf = new Map(
    firstPunches.map((row) => [
      row.userOrganizationId,
      row.first ? new Date(new Date(row.first).getTime() + offsetMs).toISOString().slice(0, 10) : null,
    ]),
  );
  const punchedKeys = new Set(punched.map((row) => `${row.employeeId}|${row.date}`));

  const rows: DailyAttendance[] = [];
  for (const member of members) {
    // Without a hire date, an employee counts from their first ever punch.
    const startsOn = member.hireDate ?? firstPunchOf.get(member.id) ?? null;
    if (!startsOn) continue;
    const memberLeaves = leaves.filter((leave) => leave.userOrganizationId === member.id);
    const holidaySet = new Set(holidaysForBranch(holidays, member.branchId));
    for (const date of eachDate(query.from, to)) {
      if (date < startsOn) continue;
      if (weeklyOff.includes(weekdayOf(date)) || holidaySet.has(date)) continue;
      if (punchedKeys.has(`${member.userId}|${date}`)) continue;
      const onLeave = memberLeaves.some((leave) => leave.startDate <= date && date <= leave.endDate);
      rows.push({
        employeeId: member.userId,
        employeeName: `${member.fname} ${member.lname}`.trim(),
        date,
        firstCheckIn: null,
        lastCheckOut: null,
        workedMinutes: null,
        expectedMinutes: null,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        status: onLeave ? "on_leave" : "absent",
      });
    }
  }
  return rows;
};

/** Access-unchecked calculation shared with payroll. Callers must authorize first. */
export const computeDailyAttendance = async (
  organizationId: string,
  query: DailyQuery,
): Promise<DailyAttendance[]> => {
  const employeeId = query.employeeId;
  const offsetMs = query.utcOffsetMinutes * MINUTE_MS;
  const startMs =
    Date.parse(`${query.from}T00:00:00Z`) - offsetMs - DAY_MINUTES * MINUTE_MS;
  const endMs =
    Date.parse(`${query.to}T00:00:00Z`) + 2 * DAY_MINUTES * MINUTE_MS - offsetMs;

  const conditions: SQL[] = [
    eq(attendanceLogsTable.organizationId, organizationId),
    gte(attendanceLogsTable.occurredAt, new Date(startMs)),
    lte(attendanceLogsTable.occurredAt, new Date(endMs)),
  ];
  if (employeeId) conditions.push(eq(userOrganizationsTable.userId, employeeId));
  if (query.employeeRole) conditions.push(eq(userOrganizationsTable.role, query.employeeRole));
  if (query.branchIds) conditions.push(inArray(userOrganizationsTable.branchId, query.branchIds));

  const [rows, [settings]] = await Promise.all([
    db
      .select({
        employeeId: userOrganizationsTable.userId,
        membershipId: attendanceLogsTable.userOrganizationId,
        fname: usersTable.fname,
        lname: usersTable.lname,
        eventType: attendanceLogsTable.eventType,
        occurredAt: attendanceLogsTable.occurredAt,
        recordedAt: attendanceLogsTable.recordedAt,
        source: attendanceLogsTable.source,
      })
      .from(attendanceLogsTable)
      .innerJoin(
        userOrganizationsTable,
        eq(userOrganizationsTable.id, attendanceLogsTable.userOrganizationId),
      )
      .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
      .where(and(...conditions))
      .orderBy(attendanceLogsTable.occurredAt),
    db
      .select({
        full: organizationPayrollSettingsTable.fullDayThresholdPercent,
        half: organizationPayrollSettingsTable.halfDayThresholdPercent,
      })
      .from(organizationPayrollSettingsTable)
      .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
      .limit(1),
  ]);
  const fullPercent = Number(settings?.full ?? 90);
  const halfPercent = Number(settings?.half ?? 50);

  // The shift for each employee and date comes from the roster (override, rotation, then default shift).
  const roster = await loadRoster(
    organizationId,
    previousDate(query.from),
    nextDate(query.to),
    [...new Set(rows.map((row) => row.membershipId))],
  );
  const shiftOn = (membershipId: string, date: string) => {
    const shift = roster.byMembership.get(membershipId)?.get(date)?.shift;
    return {
      shiftStart: shift?.startTime ?? null,
      shiftEnd: shift?.endTime ?? null,
      breakMinutes: shift?.breakMinutes ?? 0,
      graceMinutes: shift?.gracePeriodMinutes ?? 0,
    };
  };

  const days = new Map<string, DailyAttendance>();
  type Fixed = { at: Date; recordedAt: Date } | null;
  const punches = new Map<string, { firstIn: Date | null; lastOut: Date | null; fixedIn: Fixed; fixedOut: Fixed }>();
  const shifts = new Map<string, ReturnType<typeof shiftOn>>();

  for (const row of rows) {
    // Punches after midnight stay on the day the work started (night shifts, late overtime).
    const date = workDateAt(row.occurredAt, offsetMs, (day) => shiftTimes(roster, row.membershipId, day));
    const key = `${row.employeeId}|${date}`;
    if (!days.has(key)) {
      days.set(key, {
        employeeId: row.employeeId,
        employeeName: `${row.fname} ${row.lname}`.trim(),
        date,
        firstCheckIn: null,
        lastCheckOut: null,
        workedMinutes: null,
        expectedMinutes: null,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        status: "incomplete",
      });
      punches.set(key, { firstIn: null, lastOut: null, fixedIn: null, fixedOut: null });
      shifts.set(key, shiftOn(row.membershipId, date));
    }
    const punch = punches.get(key)!;
    // An approved correction replaces the original punch of that type for the day; the latest correction wins.
    if (row.source === "regularization") {
      const fixed = { at: row.occurredAt, recordedAt: row.recordedAt };
      const slot = row.eventType === "check_in" ? "fixedIn" : "fixedOut";
      if (!punch[slot] || punch[slot].recordedAt <= row.recordedAt) punch[slot] = fixed;
    }
    if (row.eventType === "check_in") {
      punch.firstIn ??= row.occurredAt;
    } else {
      // Keep the checkout visible even if its check-in is delayed or missing.
      // The day remains incomplete until both punches are available.
      punch.lastOut = row.occurredAt;
    }
  }

  for (const [key, day] of days) {
    const punch = punches.get(key)!;
    const firstIn = punch.fixedIn?.at ?? punch.firstIn;
    const lastOut = punch.fixedOut?.at ?? punch.lastOut;
    const shift = shifts.get(key)!;
    day.firstCheckIn = firstIn;
    day.lastCheckOut = lastOut;
    if (!firstIn || !lastOut) continue;

    const breakMinutes = shift.breakMinutes ?? 0;
    let elapsedMinutes = Math.round((lastOut.getTime() - firstIn.getTime()) / MINUTE_MS);

    if (shift.shiftStart && shift.shiftEnd) {
      const start = toMinutes(shift.shiftStart);
      const end = toMinutes(shift.shiftEnd);
      if (end < start && elapsedMinutes < 0) elapsedMinutes += DAY_MINUTES;
      const span = (end - start + DAY_MINUTES) % DAY_MINUTES;
      day.workedMinutes = workedAfterBreak(elapsedMinutes, span, breakMinutes);

      const expected = span - breakMinutes;
      if (expected > 0) {
        day.expectedMinutes = expected;
        const percent = (day.workedMinutes / expected) * 100;
        day.status =
          percent >= fullPercent ? "present" : percent >= halfPercent ? "half_day" : "absent";
      } else {
        day.status = "present";
      }

      const minuteOfDay = (value: Date) =>
        Math.floor(((value.getTime() + offsetMs) % (DAY_MINUTES * MINUTE_MS)) / MINUTE_MS);
      let inMinute = minuteOfDay(firstIn);
      if (end < start && inMinute <= end) inMinute += DAY_MINUTES;
      if (inMinute > start + (shift.graceMinutes ?? 0)) day.lateMinutes = inMinute - start;
      if (end > start) {
        const outMinute = minuteOfDay(lastOut);
        if (outMinute < end) day.earlyLeaveMinutes = end - outMinute;
      } else if (end < start) {
        const outMinute = minuteOfDay(lastOut);
        const shiftEnd = end + DAY_MINUTES;
        const adjustedOut = outMinute < start ? outMinute + DAY_MINUTES : outMinute;
        day.earlyLeaveMinutes = Math.max(0, shiftEnd - adjustedOut);
      }
    } else {
      day.workedMinutes = Math.max(0, elapsedMinutes - breakMinutes);
      // Without an assigned shift there is nothing to measure the day against.
      day.status = "present";
    }
    if (day.status === "present" && day.workedMinutes !== null && day.expectedMinutes) {
      day.overtimeMinutes = Math.max(0, day.workedMinutes - day.expectedMinutes);
    }
  }

  return [...days.values()]
    .filter((day) => day.date >= query.from && day.date <= query.to)
    .sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName));
};

export const listAttendance = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof listAttendanceQuerySchema>,
): Promise<ServiceResult<AttendanceLog[]>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role);
  const employeeId = isManager ? query.employeeId : requesterId;
  if (!isManager && query.employeeId && query.employeeId !== requesterId) {
    return fail("forbidden");
  }

  const conditions: SQL[] = [eq(attendanceLogsTable.organizationId, organizationId)];
  if (employeeId) conditions.push(eq(userOrganizationsTable.userId, employeeId));
  if (access.data.role === UserRole.HR) {
    conditions.push(
      eq(
        userOrganizationsTable.role,
        employeeId === requesterId ? UserRole.HR : UserRole.EMPLOYEE,
      ),
    );
  }
  const branchIds = isManager && employeeId !== requesterId ? branchFilter(access.data, query.branchId) : undefined;
  if (branchIds) conditions.push(inArray(userOrganizationsTable.branchId, branchIds));
  if (query.from) conditions.push(gte(attendanceLogsTable.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(attendanceLogsTable.occurredAt, new Date(query.to)));

  const rows = await selectLogs(and(...conditions))
    .orderBy(desc(attendanceLogsTable.occurredAt))
    .limit(query.limit)
    .offset(query.offset);
  return ok(rows.map(toLog));
};

// ---------- GPS check-in from the employee's phone ----------

const gpsContext = async (organizationId: string, membershipId: string) => {
  const [row] = await db
    .select({
      branchId: branchesTable.id,
      name: branchesTable.name,
      latitude: branchesTable.latitude,
      longitude: branchesTable.longitude,
      radius: branchesTable.geofenceRadiusMeters,
      gpsCheckIn: branchesTable.gpsCheckIn,
      isActive: branchesTable.isActive,
    })
    .from(userOrganizationsTable)
    .innerJoin(branchesTable, eq(branchesTable.id, userOrganizationsTable.branchId))
    .where(and(eq(userOrganizationsTable.id, membershipId), eq(userOrganizationsTable.organizationId, organizationId)))
    .limit(1);
  if (!row || !row.isActive || !row.gpsCheckIn || row.latitude === null || row.longitude === null) return null;
  return { ...row, latitude: Number(row.latitude), longitude: Number(row.longitude) };
};

/** The current work day's first check-in and last check-out (a night shift's still counts after midnight). */
const todaysPunches = async (organizationId: string, membershipId: string, utcOffsetMinutes: number) => {
  const workDate = await workDateForPunch(organizationId, membershipId, new Date(), utcOffsetMinutes);
  const rows = await punchesOnWorkDay(organizationId, membershipId, workDate, utcOffsetMinutes);
  return {
    checkedInAt: rows.find((row) => row.eventType === "check_in")?.occurredAt ?? null,
    checkedOutAt: rows.filter((row) => row.eventType === "check_out").at(-1)?.occurredAt ?? null,
  };
};

/** Whether the employee can check in by GPS, their branch's geofence, and today's punches. */
export const getGpsStatus = async (organizationId: string, requesterId: string, utcOffsetMinutes: number) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const branch = await gpsContext(organizationId, access.data.id);
  return ok({
    enabled: !!branch,
    branch: branch ? { name: branch.name, latitude: branch.latitude, longitude: branch.longitude, radiusMeters: branch.radius } : null,
    ...(branch ? await todaysPunches(organizationId, access.data.id, utcOffsetMinutes) : { checkedInAt: null, checkedOutAt: null }),
  });
};

/** A check-in or check-out from the employee's phone, accepted only inside their branch's geofence. */
export const recordGpsAttendance = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof gpsAttendanceSchema>,
): Promise<ServiceResult<{ occurredAt: Date; distanceMeters: number; branchName: string }>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const branch = await gpsContext(organizationId, access.data.id);
  if (!branch) return fail("forbidden", "GPS check-in is not turned on for your branch");

  const check = checkGeofence({
    at: { latitude: input.latitude, longitude: input.longitude },
    accuracy: input.accuracyMeters,
    branch,
    radius: branch.radius,
  });
  if (!check.ok) {
    return fail(
      "invalid",
      check.reason === "imprecise"
        ? `Your location is too imprecise (±${Math.round(input.accuracyMeters)} m). Turn on precise location and try again, ideally near a window or outdoors.`
        : `You are ${check.distance} m from ${branch.name}. GPS check-in works within ${branch.radius} m.`,
    );
  }

  const occurredAt = new Date();
  if (input.eventType === "check_out") {
    // A check-out needs a check-in in the last 20 hours (night shifts cross midnight).
    const [recent] = await db
      .select({ id: attendanceLogsTable.id })
      .from(attendanceLogsTable)
      .where(
        and(
          eq(attendanceLogsTable.userOrganizationId, access.data.id),
          eq(attendanceLogsTable.eventType, "check_in"),
          gte(attendanceLogsTable.occurredAt, new Date(occurredAt.getTime() - 20 * 60 * MINUTE_MS)),
        ),
      )
      .limit(1);
    if (!recent) return fail("conflict", "Check in first");
  }
  const rejection = await checkPunchRules(organizationId, access.data.id, input.eventType, occurredAt, input.utcOffsetMinutes);
  if (rejection) return rejection;

  await db.insert(attendanceLogsTable).values({
    organizationId,
    userOrganizationId: access.data.id,
    eventType: input.eventType,
    source: "gps",
    faceVerificationStatus: "not_applicable",
    latitude: input.latitude.toFixed(6),
    longitude: input.longitude.toFixed(6),
    accuracyMeters: Math.round(input.accuracyMeters),
    distanceMeters: check.distance,
    branchId: branch.branchId,
    occurredAt,
  });
  return ok({ occurredAt, distanceMeters: check.distance, branchName: branch.name });
};
