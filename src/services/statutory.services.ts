import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  employeeStatutoryProfilesTable as profiles,
  organizationStatutorySettingsTable as orgSettings,
  payrollItemsTable,
  payrollRunsTable,
  UserRole,
  userOrganizationsTable,
  usersTable,
} from "@/drizzle/schema";
import { branchCondition, canManageMember, PEOPLE_MANAGER_ROLES, OWNER_ROLES, requireRole } from "@/services/access.services";
import {
  EMPTY_YTD,
  financialYearOf,
  type EmployeeStatutory,
  type StatutorySettings,
  type YearToDate,
} from "@/services/statutory-calc";
import { decryptSecret, encryptSecret } from "@/utils/crypto";
import { fail, ok } from "@/utils/result";
import type {
  updateEmployeeStatutorySchema,
  updateStatutorySettingsSchema,
} from "@/validator/statutory.validator";

const num = (value: string | null | undefined, fallback: number) =>
  value === null || value === undefined ? fallback : Number(value);

const DEFAULT_SETTINGS: StatutorySettings = {
  pfEnabled: false,
  pfWageCeiling: 15_000,
  pfCapWages: true,
  esiEnabled: false,
  esiWageCeiling: 21_000,
  ptEnabled: false,
  ptState: null,
  ptFlatAmount: null,
  tdsEnabled: false,
};

export const loadStatutorySettings = async (organizationId: string) => {
  const [row] = await db
    .select()
    .from(orgSettings)
    .where(eq(orgSettings.organizationId, organizationId))
    .limit(1);
  if (!row) return { calc: DEFAULT_SETTINGS, identity: null };
  return {
    calc: {
      pfEnabled: row.pfEnabled,
      pfWageCeiling: num(row.pfWageCeiling, 15_000),
      pfCapWages: row.pfCapWages,
      esiEnabled: row.esiEnabled,
      esiWageCeiling: num(row.esiWageCeiling, 21_000),
      ptEnabled: row.ptEnabled,
      ptState: row.ptState,
      ptFlatAmount: row.ptFlatAmount === null ? null : Number(row.ptFlatAmount),
      tdsEnabled: row.tdsEnabled,
    } satisfies StatutorySettings,
    identity: {
      pfEstablishmentCode: row.pfEstablishmentCode,
      esiEstablishmentCode: row.esiEstablishmentCode,
      tan: row.tan,
      employerPan: row.employerPan,
      employerAddress: row.employerAddress,
    },
  };
};

export const isStatutoryActive = (settings: StatutorySettings) =>
  settings.pfEnabled || settings.esiEnabled || settings.ptEnabled || settings.tdsEnabled;

export const getStatutorySettings = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const { calc, identity } = await loadStatutorySettings(organizationId);
  return ok({
    ...calc,
    pfEstablishmentCode: identity?.pfEstablishmentCode ?? null,
    esiEstablishmentCode: identity?.esiEstablishmentCode ?? null,
    tan: identity?.tan ?? null,
    employerPan: identity?.employerPan ?? null,
    employerAddress: identity?.employerAddress ?? null,
  });
};

export const saveStatutorySettings = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof updateStatutorySettingsSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, OWNER_ROLES);
  if (!access.ok) return access;
  const values = {
    pfEnabled: input.pfEnabled,
    pfWageCeiling: input.pfWageCeiling.toFixed(2),
    pfCapWages: input.pfCapWages,
    pfEstablishmentCode: input.pfEstablishmentCode ?? null,
    esiEnabled: input.esiEnabled,
    esiWageCeiling: input.esiWageCeiling.toFixed(2),
    esiEstablishmentCode: input.esiEstablishmentCode ?? null,
    ptEnabled: input.ptEnabled,
    ptState: input.ptEnabled ? input.ptState ?? null : null,
    ptFlatAmount: input.ptFlatAmount === null || input.ptFlatAmount === undefined ? null : input.ptFlatAmount.toFixed(2),
    tdsEnabled: input.tdsEnabled,
    tan: input.tan ?? null,
    employerPan: input.employerPan ?? null,
    employerAddress: input.employerAddress ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(orgSettings)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: orgSettings.organizationId, set: values });
  return getStatutorySettings(organizationId, requesterId);
};

const maskPan = (pan: string | null) => (pan ? `XXXXX${pan.slice(5)}` : null);

const readPan = (stored: string | null) => {
  if (!stored) return null;
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
};

export const listEmployeeStatutory = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const rows = await db
    .select({
      employeeId: userOrganizationsTable.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      employeeCode: userOrganizationsTable.employeeCode,
      uan: profiles.uan,
      esiNumber: profiles.esiNumber,
      panEncrypted: profiles.panEncrypted,
      gender: profiles.gender,
      pfApplicable: profiles.pfApplicable,
      esiApplicable: profiles.esiApplicable,
      taxRegime: profiles.taxRegime,
      declaredDeductions: profiles.declaredDeductions,
    })
    .from(userOrganizationsTable)
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .leftJoin(profiles, eq(profiles.userOrganizationId, userOrganizationsTable.id))
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.isActive, true),
        access.data.role === UserRole.HR
          ? eq(userOrganizationsTable.role, UserRole.EMPLOYEE)
          : undefined,
        branchCondition(access.data),
      ),
    )
    .orderBy(usersTable.fname, usersTable.lname);
  return ok(
    rows.map(({ fname, lname, panEncrypted, declaredDeductions, ...row }) => ({
      ...row,
      employeeName: `${fname} ${lname}`.trim(),
      panMasked: maskPan(readPan(panEncrypted)),
      pfApplicable: row.pfApplicable ?? true,
      esiApplicable: row.esiApplicable ?? true,
      taxRegime: row.taxRegime ?? ("new" as const),
      declaredDeductions: Number(declaredDeductions ?? 0),
    })),
  );
};

export const saveEmployeeStatutory = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  input: z.infer<typeof updateEmployeeStatutorySchema>,
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const [member] = await db
    .select({ id: userOrganizationsTable.id, role: userOrganizationsTable.role, branchId: userOrganizationsTable.branchId })
    .from(userOrganizationsTable)
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.userId, employeeId),
      ),
    )
    .limit(1);
  if (!member) return fail("not-found", "Employee not found in this organization");
  if (!canManageMember(access.data, member)) return fail("forbidden");

  const values: Partial<typeof profiles.$inferInsert> = { updatedAt: new Date() };
  if (input.uan !== undefined) values.uan = input.uan || null;
  if (input.esiNumber !== undefined) values.esiNumber = input.esiNumber || null;
  if (input.gender !== undefined) values.gender = input.gender || null;
  if (input.pfApplicable !== undefined) values.pfApplicable = input.pfApplicable;
  if (input.esiApplicable !== undefined) values.esiApplicable = input.esiApplicable;
  if (input.taxRegime !== undefined) values.taxRegime = input.taxRegime;
  if (input.declaredDeductions !== undefined) values.declaredDeductions = input.declaredDeductions.toFixed(2);
  if (input.pan !== undefined) values.panEncrypted = input.pan ? encryptSecret(input.pan) : null;

  await db
    .insert(profiles)
    .values({ organizationId, userOrganizationId: member.id, ...values })
    .onConflictDoUpdate({ target: profiles.userOrganizationId, set: values });
  return ok({ saved: true });
};

export type EmployeeStatutoryDetail = EmployeeStatutory & {
  uan: string | null;
  esiNumber: string | null;
  pan: string | null;
};

const DEFAULT_EMPLOYEE: EmployeeStatutoryDetail = {
  pfApplicable: true,
  esiApplicable: true,
  gender: null,
  taxRegime: "new",
  declaredDeductions: 0,
  uan: null,
  esiNumber: null,
  pan: null,
};

/** Server-only: includes the real PAN. Keyed by membership id. */
export const loadEmployeeStatutoryMap = async (organizationId: string, membershipIds?: string[]) => {
  const rows = await db
    .select()
    .from(profiles)
    .where(
      and(
        eq(profiles.organizationId, organizationId),
        membershipIds ? inArray(profiles.userOrganizationId, membershipIds) : undefined,
      ),
    );
  const map = new Map<string, EmployeeStatutoryDetail>();
  for (const row of rows) {
    map.set(row.userOrganizationId, {
      pfApplicable: row.pfApplicable,
      esiApplicable: row.esiApplicable,
      gender: row.gender,
      taxRegime: row.taxRegime,
      declaredDeductions: Number(row.declaredDeductions),
      uan: row.uan,
      esiNumber: row.esiNumber,
      pan: readPan(row.panEncrypted),
    });
  }
  return { get: (id: string) => map.get(id) ?? DEFAULT_EMPLOYEE };
};

/** Gross, TDS and professional tax from other finalized runs of the same financial year. */
export const loadYearToDate = async (organizationId: string, periodStart: string, periodEnd: string) => {
  const year = financialYearOf(periodEnd);
  const rows = await db
    .select({
      userOrganizationId: payrollItemsTable.userOrganizationId,
      gross: payrollItemsTable.grossPay,
      statutory: payrollItemsTable.statutory,
    })
    .from(payrollItemsTable)
    .innerJoin(
      payrollRunsTable,
      and(
        eq(payrollRunsTable.id, payrollItemsTable.runId),
        eq(payrollRunsTable.organizationId, payrollItemsTable.organizationId),
      ),
    )
    .where(
      and(
        eq(payrollItemsTable.organizationId, organizationId),
        eq(payrollRunsTable.status, "finalized"),
        gte(payrollRunsTable.periodStart, year.from),
        lt(payrollRunsTable.periodEnd, periodStart),
      ),
    );
  const totals = new Map<string, YearToDate>();
  for (const row of rows) {
    const current = totals.get(row.userOrganizationId) ?? { ...EMPTY_YTD };
    current.gross += Number(row.gross);
    current.tds += row.statutory?.tds ?? 0;
    current.professionalTax += row.statutory?.professionalTax ?? 0;
    totals.set(row.userOrganizationId, current);
  }
  return { get: (id: string) => totals.get(id) ?? EMPTY_YTD };
};
