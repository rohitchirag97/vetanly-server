import { and, desc, eq, gte, lte, min, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  attendanceLogsTable,
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
  getEmployeeMembership,
  PEOPLE_MANAGER_ROLES,
  requireRole,
} from "@/services/access.services";
import type { AuthenticatedKiosk } from "@/services/kiosk.services";
import { eachDate } from "@/services/payroll-calc";
import { createLeaveRequest, updateLeaveStatus } from "@/services/leave.services";
import { holidayDatesBetween } from "@/services/holiday.services";
import { parseWeeklyOff } from "@/services/payroll-settings.services";
import { enqueueAttendance } from "@/queue/producer/recordAttendance";
import { loadRoster } from "@/services/roster.services";
import type { AttendanceJob } from "@/queue/types";
import { fail, isUniqueViolation, ok, type ServiceResult } from "@/utils/result";
import type {
  bulkManualAttendanceSchema,
  dailyAttendanceQuerySchema,
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

  const localDate = new Date(occurredAt.getTime() + utcOffsetMinutes * MINUTE_MS)
    .toISOString()
    .slice(0, 10);
  const [leave] = await db
    .select({ id: leaveRequestsTable.id })
    .from(leaveRequestsTable)
    .where(
      and(
        eq(leaveRequestsTable.organizationId, organizationId),
        eq(leaveRequestsTable.userOrganizationId, userOrganizationId),
        eq(leaveRequestsTable.status, "approved"),
        eq(leaveRequestsTable.isHalfDay, false),
        lte(leaveRequestsTable.startDate, localDate),
        gte(leaveRequestsTable.endDate, localDate),
      ),
    )
    .limit(1);
  if (leave) return fail("conflict", "This employee is on approved leave on that date");

  if (eventType === "check_in") {
    const dayStart = new Date(`${localDate}T00:00:00.000Z`).getTime() - utcOffsetMinutes * MINUTE_MS;
    const [existingCheckIn] = await db
      .select({ id: attendanceLogsTable.id })
      .from(attendanceLogsTable)
      .where(
        and(
          eq(attendanceLogsTable.organizationId, organizationId),
          eq(attendanceLogsTable.userOrganizationId, userOrganizationId),
          eq(attendanceLogsTable.eventType, "check_in"),
          gte(attendanceLogsTable.occurredAt, new Date(dayStart)),
          lte(attendanceLogsTable.occurredAt, new Date(dayStart + 24 * 60 * MINUTE_MS - 1)),
        ),
      )
      .limit(1);
    if (existingCheckIn) {
      return fail("conflict", "This employee has already checked in on that date");
    }
  }
  return null;
};

export const recordKioskAttendance = async (
  kiosk: AuthenticatedKiosk,
  input: z.infer<typeof kioskAttendanceSchema>,
): Promise<ServiceResult<AttendanceReceipt>> => {
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

  const rejection = await checkPunchRules(
    kiosk.organizationId,
    membership.id,
    input.eventType,
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
    eventType: input.eventType,
    externalEventId: input.externalEventId ?? crypto.randomUUID(),
    occurredAt: occurredAt.toISOString(),
    faceMatchScore: input.faceMatchScore,
    livenessPassed: input.livenessPassed,
    faceTemplateId: input.faceTemplateId,
  };
  return ok(await submitAttendance(job));
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
  if (access.data.role === UserRole.HR && membership.role !== UserRole.EMPLOYEE) {
    return fail("forbidden");
  }
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
  status: DayStatus;
};

const DAY_MINUTES = 1440;
// How long after a night shift ends a check-out still belongs to that night.
const NIGHT_CHECKOUT_GRACE_MINUTES = 240;

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
  const effective = { ...query, employeeId, employeeRole };
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
  query: z.infer<typeof dailyAttendanceQuerySchema> & { employeeRole?: string },
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

  const [members, firstPunches, leaves, holidays, [settings]] = await Promise.all([
    db
      .select({
        id: userOrganizationsTable.id,
        userId: userOrganizationsTable.userId,
        hireDate: userOrganizationsTable.hireDate,
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
  const holidaySet = new Set(holidays);
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
        status: onLeave ? "on_leave" : "absent",
      });
    }
  }
  return rows;
};

/** Access-unchecked calculation shared with payroll. Callers must authorize first. */
export const computeDailyAttendance = async (
  organizationId: string,
  query: z.infer<typeof dailyAttendanceQuerySchema> & { employeeRole?: string },
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

  const [rows, [settings]] = await Promise.all([
    db
      .select({
        employeeId: userOrganizationsTable.userId,
        membershipId: attendanceLogsTable.userOrganizationId,
        fname: usersTable.fname,
        lname: usersTable.lname,
        eventType: attendanceLogsTable.eventType,
        occurredAt: attendanceLogsTable.occurredAt,
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
  const punches = new Map<string, { firstIn: Date | null; lastOut: Date | null; fixedIn: Date | null; fixedOut: Date | null }>();
  const shifts = new Map<string, ReturnType<typeof shiftOn>>();

  for (const row of rows) {
    const local = new Date(row.occurredAt.getTime() + offsetMs);
    let date = local.toISOString().slice(0, 10);
    // An early-morning punch belongs to the previous day when that day's shift ran past midnight.
    const previousShift = shiftOn(row.membershipId, previousDate(date));
    if (
      previousShift.shiftStart &&
      previousShift.shiftEnd &&
      toMinutes(previousShift.shiftEnd) < toMinutes(previousShift.shiftStart)
    ) {
      const minuteOfDay = Math.floor(
        ((row.occurredAt.getTime() + offsetMs) % (DAY_MINUTES * MINUTE_MS)) / MINUTE_MS,
      );
      // A check-out may run past the shift end (overtime, a late handover); a check-in may not.
      const window = row.eventType === "check_out" ? NIGHT_CHECKOUT_GRACE_MINUTES : 0;
      if (minuteOfDay <= toMinutes(previousShift.shiftEnd) + window) date = previousDate(date);
    }
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
        status: "incomplete",
      });
      punches.set(key, { firstIn: null, lastOut: null, fixedIn: null, fixedOut: null });
      shifts.set(key, shiftOn(row.membershipId, date));
    }
    const punch = punches.get(key)!;
    // An approved correction replaces the original punch of that type for the day.
    if (row.source === "regularization") {
      if (row.eventType === "check_in") punch.fixedIn = row.occurredAt;
      else punch.fixedOut = row.occurredAt;
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
    const firstIn = punch.fixedIn ?? punch.firstIn;
    const lastOut = punch.fixedOut ?? punch.lastOut;
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
      day.workedMinutes = Math.max(0, elapsedMinutes - breakMinutes);

      const span = (end - start + DAY_MINUTES) % DAY_MINUTES;
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
  if (query.from) conditions.push(gte(attendanceLogsTable.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(attendanceLogsTable.occurredAt, new Date(query.to)));

  const rows = await selectLogs(and(...conditions))
    .orderBy(desc(attendanceLogsTable.occurredAt))
    .limit(query.limit)
    .offset(query.offset);
  return ok(rows.map(toLog));
};
