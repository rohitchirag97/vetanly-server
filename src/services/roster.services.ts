import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  shiftRosterOverridesTable as overrides,
  shiftRotationAssignmentsTable as assignments,
  shiftRotationsTable as rotations,
  shiftsTable,
  shiftSwapRequestsTable as swaps,
  userOrganizationsTable as memberships,
  UserRole,
  usersTable,
  type ShiftRotationStep,
  type ShiftSwapStatus,
} from "@/drizzle/schema";
import { ALL_ROLES, PEOPLE_MANAGER_ROLES, requireRole, type ActiveMembership } from "@/services/access.services";
import { notify, peopleManagerIds } from "@/services/notification.services";
import { addDays, cycleLength, eachDay, resolveRosterDay, type RosterAssignment, type RosterSource } from "@/services/roster-calc";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  assignRotationSchema,
  endRotationSchema,
  overrideSchema,
  rotationSchema,
  swapRequestSchema,
} from "@/validator/roster.validator";

/**
 * Shift rotation: patterns, who is on which pattern from when, single-day overrides and shift swaps.
 * loadRoster is the one place that decides the shift an employee works on a date; attendance and
 * payroll both use it. Managing follows shifts: HR, admins and the owner, with HR limited to employees.
 */

export type ShiftInfo = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  gracePeriodMinutes: number;
};

export type RosterEntry = { shiftId: string | null; source: RosterSource; shift: ShiftInfo | null };

/**
 * Each employee's shift on each date in [from, to]. Keyed by membership id, then date. Employees on
 * no rotation and without overrides simply get their default shift on every date.
 */
export const loadRoster = async (organizationId: string, from: string, to: string, membershipIds?: string[]) => {
  const scope = membershipIds ? inArray(memberships.id, membershipIds) : undefined;
  if (membershipIds && membershipIds.length === 0) return { byMembership: new Map<string, Map<string, RosterEntry>>(), shifts: new Map<string, ShiftInfo>() };
  const [people, shiftRows, assignmentRows, overrideRows] = await Promise.all([
    db
      .select({ id: memberships.id, shiftId: memberships.shiftId })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), scope)),
    db
      .select({
        id: shiftsTable.id,
        name: shiftsTable.name,
        startTime: shiftsTable.startTime,
        endTime: shiftsTable.endTime,
        breakMinutes: shiftsTable.breakMinutes,
        gracePeriodMinutes: shiftsTable.gracePeriodMinutes,
      })
      .from(shiftsTable)
      .where(eq(shiftsTable.organizationId, organizationId)),
    db
      .select({
        membershipId: assignments.userOrganizationId,
        startsOn: assignments.startsOn,
        endsOn: assignments.endsOn,
        cycleOffset: assignments.cycleOffset,
        pattern: rotations.pattern,
      })
      .from(assignments)
      .innerJoin(rotations, eq(rotations.id, assignments.rotationId))
      .where(
        and(
          eq(assignments.organizationId, organizationId),
          lte(assignments.startsOn, to),
          or(isNull(assignments.endsOn), gte(assignments.endsOn, from)),
        ),
      ),
    db
      .select({ membershipId: overrides.userOrganizationId, date: overrides.date, shiftId: overrides.shiftId })
      .from(overrides)
      .where(and(eq(overrides.organizationId, organizationId), gte(overrides.date, from), lte(overrides.date, to))),
  ]);

  const shifts = new Map<string, ShiftInfo>(shiftRows.map((shift) => [shift.id, shift]));
  const assignmentsBy = new Map<string, RosterAssignment[]>();
  for (const row of assignmentRows) {
    const list = assignmentsBy.get(row.membershipId) ?? [];
    list.push(row);
    assignmentsBy.set(row.membershipId, list);
  }
  const overrideBy = new Map(overrideRows.map((row) => [`${row.membershipId}|${row.date}`, row]));

  const days = eachDay(from, to);
  const byMembership = new Map<string, Map<string, RosterEntry>>();
  for (const person of people) {
    const perDay = new Map<string, RosterEntry>();
    for (const date of days) {
      const day = resolveRosterDay({
        date,
        override: overrideBy.get(`${person.id}|${date}`),
        assignments: assignmentsBy.get(person.id) ?? [],
        defaultShiftId: person.shiftId,
      });
      perDay.set(date, { ...day, shift: day.shiftId ? (shifts.get(day.shiftId) ?? null) : null });
    }
    byMembership.set(person.id, perDay);
  }
  return { byMembership, shifts };
};

const canManageEmployee = (access: ActiveMembership, employeeRole: string) =>
  access.role !== UserRole.HR || employeeRole === UserRole.EMPLOYEE;

// ---------- Rotation patterns ----------

export const listRotations = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const rows = await db.select().from(rotations).where(eq(rotations.organizationId, organizationId)).orderBy(asc(rotations.name));
  const counts = rows.length
    ? await db
        .select({ rotationId: assignments.rotationId, membershipId: assignments.userOrganizationId })
        .from(assignments)
        .where(and(inArray(assignments.rotationId, rows.map((row) => row.id)), isNull(assignments.endsOn)))
    : [];
  return ok(
    rows.map((row) => ({
      ...row,
      cycleDays: cycleLength(row.pattern),
      activeEmployees: counts.filter((count) => count.rotationId === row.id).length,
    })),
  );
};

const validatePattern = async (organizationId: string, pattern: ShiftRotationStep[]) => {
  if (cycleLength(pattern) > 120) return "A rotation cycle can be at most 120 days";
  if (!pattern.some((step) => step.shiftId)) return "Add at least one working shift";
  const ids = [...new Set(pattern.flatMap((step) => (step.shiftId ? [step.shiftId] : [])))];
  const found = await db
    .select({ id: shiftsTable.id })
    .from(shiftsTable)
    .where(and(eq(shiftsTable.organizationId, organizationId), inArray(shiftsTable.id, ids), eq(shiftsTable.isActive, true)));
  return found.length === ids.length ? null : "Choose active shifts from this organization";
};

export const saveRotation = async (
  organizationId: string,
  requesterId: string,
  rotationId: string | null,
  input: z.infer<typeof rotationSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const problem = await validatePattern(organizationId, input.pattern);
  if (problem) return fail("invalid", problem);
  try {
    if (rotationId) {
      const [updated] = await db
        .update(rotations)
        .set({ name: input.name, pattern: input.pattern, isActive: input.isActive, updatedAt: new Date() })
        .where(and(eq(rotations.id, rotationId), eq(rotations.organizationId, organizationId)))
        .returning();
      return updated ? ok(updated) : fail("not-found", "Rotation not found");
    }
    const [created] = await db
      .insert(rotations)
      .values({ organizationId, name: input.name, pattern: input.pattern, isActive: input.isActive })
      .returning();
    return ok(created);
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === "23505") return fail("conflict", "A rotation with this name already exists");
    throw error;
  }
};

export const deleteRotation = async (organizationId: string, requesterId: string, rotationId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const [inUse] = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.rotationId, rotationId), eq(assignments.organizationId, organizationId)))
    .limit(1);
  // Deleting a pattern would rewrite past rosters, so a used one is archived instead.
  if (inUse) return fail("conflict", "Employees have been on this rotation. Mark it inactive instead of deleting it");
  const [deleted] = await db
    .delete(rotations)
    .where(and(eq(rotations.id, rotationId), eq(rotations.organizationId, organizationId)))
    .returning({ id: rotations.id });
  return deleted ? ok(null) : fail("not-found", "Rotation not found");
};

// ---------- Putting employees on a rotation ----------

const loadMembers = (organizationId: string, employeeIds: string[]) =>
  db
    .select({ id: memberships.id, userId: memberships.userId, role: memberships.role, isActive: memberships.isActive })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), inArray(memberships.userId, employeeIds)));

export const assignRotation = async (organizationId: string, requesterId: string, input: z.infer<typeof assignRotationSchema>) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const [rotation] = await db
    .select({ id: rotations.id, pattern: rotations.pattern, isActive: rotations.isActive })
    .from(rotations)
    .where(and(eq(rotations.id, input.rotationId), eq(rotations.organizationId, organizationId)))
    .limit(1);
  if (!rotation?.isActive) return fail("invalid", "Choose an active rotation");
  if (input.cycleOffset >= cycleLength(rotation.pattern)) return fail("invalid", "The starting day must be within the cycle");
  const members = await loadMembers(organizationId, input.employeeIds);
  if (members.length !== input.employeeIds.length || members.some((member) => !member.isActive)) {
    return fail("invalid", "Choose active employees of this organization");
  }
  if (members.some((member) => !canManageEmployee(access.data, member.role))) return fail("forbidden");

  await db.transaction(async (tx) => {
    for (const member of members) {
      // A new rotation replaces whatever the employee was on from that date.
      await tx
        .delete(assignments)
        .where(and(eq(assignments.userOrganizationId, member.id), gte(assignments.startsOn, input.startsOn)));
      await tx
        .update(assignments)
        .set({ endsOn: addDays(input.startsOn, -1) })
        .where(
          and(
            eq(assignments.userOrganizationId, member.id),
            lte(assignments.startsOn, input.startsOn),
            or(isNull(assignments.endsOn), gte(assignments.endsOn, input.startsOn)),
          ),
        );
      await tx.insert(assignments).values({
        organizationId,
        rotationId: rotation.id,
        userOrganizationId: member.id,
        startsOn: input.startsOn,
        cycleOffset: input.cycleOffset,
      });
    }
  });
  return ok({ assigned: members.length });
};

/** Takes employees off rotation from a date; they return to their default shift. */
export const endRotation = async (organizationId: string, requesterId: string, input: z.infer<typeof endRotationSchema>) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const members = await loadMembers(organizationId, input.employeeIds);
  if (members.some((member) => !canManageEmployee(access.data, member.role))) return fail("forbidden");
  const lastDay = addDays(input.fromDate, -1);
  await db.transaction(async (tx) => {
    for (const member of members) {
      await tx.delete(assignments).where(and(eq(assignments.userOrganizationId, member.id), gte(assignments.startsOn, input.fromDate)));
      await tx
        .update(assignments)
        .set({ endsOn: lastDay })
        .where(and(eq(assignments.userOrganizationId, member.id), or(isNull(assignments.endsOn), gte(assignments.endsOn, input.fromDate))));
    }
  });
  return ok({ ended: members.length });
};

// ---------- Roster grid and overrides ----------

export const getRosterGrid = async (
  organizationId: string,
  requesterId: string,
  query: { from: string; to: string; departmentId?: string },
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const conditions: SQL[] = [eq(memberships.organizationId, organizationId), eq(memberships.isActive, true)];
  if (query.departmentId) conditions.push(eq(memberships.departmentId, query.departmentId));
  if (access.data.role === UserRole.HR) conditions.push(eq(memberships.role, UserRole.EMPLOYEE));
  // The owner appears only when they are on payroll as an employee, as in payroll itself.
  conditions.push(or(ne(memberships.role, UserRole.SUPER_ADMIN), eq(memberships.includeInPayroll, true))!);
  const people = await db
    .select({
      membershipId: memberships.id,
      employeeId: memberships.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      employeeCode: memberships.employeeCode,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .where(and(...conditions))
    .orderBy(asc(usersTable.fname), asc(usersTable.lname));
  const roster = await loadRoster(organizationId, query.from, query.to, people.map((person) => person.membershipId));
  const current = await db
    .select({ membershipId: assignments.userOrganizationId, rotationName: rotations.name, startsOn: assignments.startsOn })
    .from(assignments)
    .innerJoin(rotations, eq(rotations.id, assignments.rotationId))
    .where(
      and(
        eq(assignments.organizationId, organizationId),
        lte(assignments.startsOn, query.to),
        or(isNull(assignments.endsOn), gte(assignments.endsOn, query.from)),
      ),
    )
    .orderBy(desc(assignments.startsOn));
  return ok({
    days: eachDay(query.from, query.to),
    shifts: [...roster.shifts.values()],
    employees: people.map(({ fname, lname, ...person }) => ({
      ...person,
      employeeName: `${fname} ${lname}`.trim(),
      rotation: current.find((row) => row.membershipId === person.membershipId)?.rotationName ?? null,
      days: [...(roster.byMembership.get(person.membershipId)?.entries() ?? [])].map(([date, entry]) => ({
        date,
        shiftId: entry.shiftId,
        source: entry.source,
      })),
    })),
  });
};

/** Sets one employee's shift for one day (null = day off), or clears the override to fall back to the rotation. */
export const setRosterOverride = async (organizationId: string, requesterId: string, input: z.infer<typeof overrideSchema>) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const [member] = await loadMembers(organizationId, [input.employeeId]);
  if (!member?.isActive) return fail("not-found", "Employee not found");
  if (!canManageEmployee(access.data, member.role)) return fail("forbidden");
  if (input.clear) {
    await db.delete(overrides).where(and(eq(overrides.userOrganizationId, member.id), eq(overrides.date, input.date)));
    return ok(null);
  }
  if (input.shiftId) {
    const [shift] = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(and(eq(shiftsTable.id, input.shiftId), eq(shiftsTable.organizationId, organizationId)))
      .limit(1);
    if (!shift) return fail("invalid", "Choose a shift from this organization");
  }
  const values = { shiftId: input.shiftId ?? null, source: "manual" as const, note: input.note ?? null, createdByUserId: requesterId };
  await db
    .insert(overrides)
    .values({ organizationId, userOrganizationId: member.id, date: input.date, ...values })
    .onConflictDoUpdate({ target: [overrides.userOrganizationId, overrides.date], set: values });
  return ok(null);
};

// ---------- An employee's own schedule and shift swaps ----------

const ownMembership = async (organizationId: string, userId: string) => {
  const [row] = await db
    .select({ id: memberships.id, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId), eq(memberships.isActive, true)))
    .limit(1);
  return row ?? null;
};

const swapColumns = {
  id: swaps.id,
  date: swaps.date,
  status: swaps.status,
  reason: swaps.reason,
  reviewNote: swaps.reviewNote,
  requesterMembershipId: swaps.requesterMembershipId,
  colleagueMembershipId: swaps.colleagueMembershipId,
  createdAt: swaps.createdAt,
};

/** Swap rows with both people's names and their shifts on the day. */
type SwapRow = { id: string; date: string; status: ShiftSwapStatus; reason: string | null; reviewNote: string | null; requesterMembershipId: string; colleagueMembershipId: string; createdAt: Date };

const describeSwaps = async (organizationId: string, typed: SwapRow[]) => {
  if (typed.length === 0) return [];
  const ids = [...new Set(typed.flatMap((row) => [row.requesterMembershipId, row.colleagueMembershipId]))];
  const people = await db
    .select({ id: memberships.id, userId: memberships.userId, fname: usersTable.fname, lname: usersTable.lname })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .where(inArray(memberships.id, ids));
  const name = (id: string) => {
    const person = people.find((row) => row.id === id);
    return person ? `${person.fname} ${person.lname}`.trim() : "";
  };
  const dates = typed.map((row) => row.date).sort();
  const roster = await loadRoster(organizationId, dates[0], dates[dates.length - 1], ids);
  const shiftName = (membershipId: string, date: string) => roster.byMembership.get(membershipId)?.get(date)?.shift?.name ?? "Day off";
  return typed.map((row) => ({
    ...row,
    requesterId: people.find((person) => person.id === row.requesterMembershipId)?.userId ?? null,
    colleagueId: people.find((person) => person.id === row.colleagueMembershipId)?.userId ?? null,
    requesterName: name(row.requesterMembershipId),
    colleagueName: name(row.colleagueMembershipId),
    requesterShift: shiftName(row.requesterMembershipId, row.date),
    colleagueShift: shiftName(row.colleagueMembershipId, row.date),
  }));
};

export const getMySchedule = async (organizationId: string, requesterId: string, query: { from: string; to: string }) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const me = await ownMembership(organizationId, requesterId);
  if (!me) return fail("forbidden");
  const roster = await loadRoster(organizationId, query.from, query.to, [me.id]);
  const swapRows = await db
    .select(swapColumns)
    .from(swaps)
    .where(
      and(
        eq(swaps.organizationId, organizationId),
        or(eq(swaps.requesterMembershipId, me.id), eq(swaps.colleagueMembershipId, me.id)),
      ),
    )
    .orderBy(desc(swaps.createdAt))
    .limit(30);
  return ok({
    days: [...(roster.byMembership.get(me.id)?.entries() ?? [])].map(([date, entry]) => ({
      date,
      source: entry.source,
      shift: entry.shift,
    })),
    swaps: await describeSwaps(organizationId, swapRows),
  });
};

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** Colleagues who work a different shift than the requester on the date, for the swap form. */
export const getSwapOptions = async (organizationId: string, requesterId: string, date: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const me = await ownMembership(organizationId, requesterId);
  if (!me) return fail("forbidden");
  const people = await db
    .select({ membershipId: memberships.id, employeeId: memberships.userId, fname: usersTable.fname, lname: usersTable.lname })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.isActive, true)));
  const roster = await loadRoster(organizationId, date, date, people.map((person) => person.membershipId));
  const mine = roster.byMembership.get(me.id)?.get(date);
  return ok({
    myShift: mine?.shift ?? null,
    colleagues: people
      .filter((person) => person.membershipId !== me.id)
      .map((person) => ({ person, entry: roster.byMembership.get(person.membershipId)?.get(date) }))
      .filter(({ entry }) => entry && entry.shiftId !== (mine?.shiftId ?? null))
      .map(({ person, entry }) => ({
        employeeId: person.employeeId,
        employeeName: `${person.fname} ${person.lname}`.trim(),
        shift: entry!.shift,
      }))
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
  });
};

export const requestSwap = async (organizationId: string, requesterId: string, input: z.infer<typeof swapRequestSchema>) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  if (input.date < todayIst()) return fail("invalid", "Choose today or a future date");
  const me = await ownMembership(organizationId, requesterId);
  const colleague = await ownMembership(organizationId, input.colleagueId);
  if (!me || !colleague || me.id === colleague.id) return fail("invalid", "Choose a colleague in this organization");
  const roster = await loadRoster(organizationId, input.date, input.date, [me.id, colleague.id]);
  if (roster.byMembership.get(me.id)?.get(input.date)?.shiftId === roster.byMembership.get(colleague.id)?.get(input.date)?.shiftId) {
    return fail("invalid", "You both work the same shift that day, so there is nothing to swap");
  }
  const [open] = await db
    .select({ id: swaps.id })
    .from(swaps)
    .where(
      and(
        eq(swaps.organizationId, organizationId),
        eq(swaps.date, input.date),
        inArray(swaps.status, ["awaiting_colleague", "awaiting_manager"]),
        or(
          inArray(swaps.requesterMembershipId, [me.id, colleague.id]),
          inArray(swaps.colleagueMembershipId, [me.id, colleague.id]),
        ),
      ),
    )
    .limit(1);
  if (open) return fail("conflict", "One of you already has a swap request open for that day");
  const [created] = await db
    .insert(swaps)
    .values({ organizationId, requesterMembershipId: me.id, colleagueMembershipId: colleague.id, date: input.date, reason: input.reason ?? null })
    .returning({ id: swaps.id });
  const [person] = await db.select({ fname: usersTable.fname, lname: usersTable.lname }).from(usersTable).where(eq(usersTable.id, requesterId)).limit(1);
  await notify({
    organizationId,
    userIds: [input.colleagueId],
    type: "shift_swap_requested",
    title: `${person ? `${person.fname} ${person.lname}`.trim() : "A colleague"} asked to swap shifts with you`,
    body: `On ${input.date}`,
    link: "/my-schedule",
  });
  return ok({ id: created.id });
};

const loadSwap = async (organizationId: string, swapId: string) => {
  const [row] = await db.select(swapColumns).from(swaps).where(and(eq(swaps.id, swapId), eq(swaps.organizationId, organizationId))).limit(1);
  return row ?? null;
};

const setSwapStatus = (swapId: string, from: ShiftSwapStatus, to: ShiftSwapStatus, extra: Partial<typeof swaps.$inferInsert> = {}) =>
  db
    .update(swaps)
    .set({ status: to, updatedAt: new Date(), ...extra })
    .where(and(eq(swaps.id, swapId), eq(swaps.status, from)))
    .returning({ id: swaps.id });

const userIdsOf = async (membershipIds: string[]) =>
  (await db.select({ userId: memberships.userId }).from(memberships).where(inArray(memberships.id, membershipIds))).map((row) => row.userId);

/** The colleague agrees (it then goes to a manager) or declines. */
export const respondToSwap = async (organizationId: string, requesterId: string, swapId: string, accept: boolean) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const me = await ownMembership(organizationId, requesterId);
  const swap = await loadSwap(organizationId, swapId);
  if (!swap || !me || swap.colleagueMembershipId !== me.id) return fail("not-found", "Swap request not found");
  const [updated] = await setSwapStatus(swapId, "awaiting_colleague", accept ? "awaiting_manager" : "rejected");
  if (!updated) return fail("conflict", "This request has already been answered");
  const [requester] = await userIdsOf([swap.requesterMembershipId]);
  if (accept) {
    await notify({
      organizationId,
      userIds: await peopleManagerIds(organizationId),
      type: "shift_swap_awaiting_approval",
      title: "A shift swap needs approval",
      body: `On ${swap.date}`,
      link: "/shifts/roster",
    });
  }
  await notify({
    organizationId,
    userIds: [requester],
    type: accept ? "shift_swap_accepted" : "shift_swap_declined",
    title: accept ? "Your colleague agreed to the shift swap; it now needs a manager's approval" : "Your colleague declined the shift swap",
    body: `On ${swap.date}`,
    link: "/my-schedule",
  });
  return ok(null);
};

export const cancelSwap = async (organizationId: string, requesterId: string, swapId: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const me = await ownMembership(organizationId, requesterId);
  const swap = await loadSwap(organizationId, swapId);
  if (!swap || !me || swap.requesterMembershipId !== me.id) return fail("not-found", "Swap request not found");
  const cancelled =
    (await setSwapStatus(swapId, "awaiting_colleague", "cancelled")).length > 0 ||
    (await setSwapStatus(swapId, "awaiting_manager", "cancelled")).length > 0;
  return cancelled ? ok(null) : fail("conflict", "This request is already closed");
};

export const listSwapsForReview = async (organizationId: string, requesterId: string, status?: ShiftSwapStatus) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const rows = await db
    .select(swapColumns)
    .from(swaps)
    .where(and(eq(swaps.organizationId, organizationId), status ? eq(swaps.status, status) : undefined))
    .orderBy(desc(swaps.createdAt))
    .limit(100);
  return ok(await describeSwaps(organizationId, rows));
};

/** A manager approves: each person takes the other's shift that day, recorded as swap overrides. */
export const reviewSwap = async (
  organizationId: string,
  requesterId: string,
  swapId: string,
  input: { approve: boolean; note?: string },
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const swap = await loadSwap(organizationId, swapId);
  if (!swap) return fail("not-found", "Swap request not found");
  const people = await db
    .select({ id: memberships.id, userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(inArray(memberships.id, [swap.requesterMembershipId, swap.colleagueMembershipId]));
  if (people.some((person) => !canManageEmployee(access.data, person.role))) return fail("forbidden");
  if (people.some((person) => person.userId === requesterId) && access.data.role !== UserRole.SUPER_ADMIN) {
    return fail("forbidden", "Someone else must approve a swap you are part of");
  }

  if (!input.approve) {
    const [updated] = await setSwapStatus(swapId, "awaiting_manager", "rejected", { reviewedByUserId: requesterId, reviewNote: input.note ?? null });
    if (!updated) return fail("conflict", "This request is not waiting for approval");
  } else {
    const roster = await loadRoster(organizationId, swap.date, swap.date, [swap.requesterMembershipId, swap.colleagueMembershipId]);
    const requesterShift = roster.byMembership.get(swap.requesterMembershipId)?.get(swap.date)?.shiftId ?? null;
    const colleagueShift = roster.byMembership.get(swap.colleagueMembershipId)?.get(swap.date)?.shiftId ?? null;
    const done = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(swaps)
        .set({ status: "approved", reviewedByUserId: requesterId, reviewNote: input.note ?? null, updatedAt: new Date() })
        .where(and(eq(swaps.id, swapId), eq(swaps.status, "awaiting_manager")))
        .returning({ id: swaps.id });
      if (!updated) return false;
      for (const [membershipId, shiftId] of [
        [swap.requesterMembershipId, colleagueShift],
        [swap.colleagueMembershipId, requesterShift],
      ] as const) {
        const values = { shiftId, source: "swap" as const, note: "Shift swap", createdByUserId: requesterId };
        await tx
          .insert(overrides)
          .values({ organizationId, userOrganizationId: membershipId, date: swap.date, ...values })
          .onConflictDoUpdate({ target: [overrides.userOrganizationId, overrides.date], set: values });
      }
      return true;
    });
    if (!done) return fail("conflict", "This request is not waiting for approval");
  }
  await notify({
    organizationId,
    userIds: people.map((person) => person.userId),
    type: input.approve ? "shift_swap_approved" : "shift_swap_rejected",
    title: input.approve ? "Your shift swap was approved" : "Your shift swap was not approved",
    body: input.note || `On ${swap.date}`,
    link: "/my-schedule",
  });
  return ok(null);
};
