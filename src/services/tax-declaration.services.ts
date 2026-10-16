import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  employeeStatutoryProfilesTable as profiles,
  organizationsTable,
  taxDeclarationItemsTable as items,
  taxDeclarationSettingsTable as settingsTable,
  taxDeclarationsTable as declarations,
  userOrganizationsTable as memberships,
  UserRole,
  usersTable,
  type SalaryComponent,
  type TaxDeclarationSection,
  type TaxRegime,
} from "@/drizzle/schema";
import {
  ALL_ROLES,
  canManageMember,
  getEmployeeMembership,
  MANAGER_ROLES,
  PEOPLE_MANAGER_ROLES,
  requireRole,
  type ActiveMembership,
} from "@/services/access.services";
import { detectType, MAX_DOCUMENT_BYTES } from "@/services/employee-document.services";
import { managerIds, notify, peopleManagerIds } from "@/services/notification.services";
import { computeProfessionalTax, financialYearOf } from "@/services/statutory-calc";
import { loadStatutorySettings } from "@/services/statutory.services";
import {
  annualSalaryFigures,
  compareRegimes,
  computeDeclarationTotals,
  SECTIONS,
  type DeclarationItemInput,
} from "@/services/tax-declaration-calc";
import { isFileStorageAvailable, removeFile, signedDownloadUrl, storeFile } from "@/utils/file-storage";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  declarationItemSchema,
  reviewDeclarationItemSchema,
  saveDeclarationSchema,
  taxDeclarationSettingsSchema,
} from "@/validator/tax-declaration.validator";

/**
 * Income-tax declarations, one per employee per financial year:
 * - Declaration phase (until declarationClosesOn, or the proof deadline when not set): the employee
 *   picks a regime and adds, changes or removes items.
 * - Until the proof deadline: proofs can be uploaded; HR, admins or the owner accept, adjust or reject each item.
 * - Payroll uses declared amounts until the proof deadline and verified amounts after it.
 * Reviewing follows the expense-claim rule: HR handles employees only, never admins or themselves.
 */

type Phase = "declaration" | "proofs" | "closed";

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export const currentFinancialYear = () => financialYearOf(todayIst()).label;

const fyStartYear = (label: string) => Number(label.slice(0, 4));

const defaultSettings = (financialYear: string) => ({
  financialYear,
  declarationClosesOn: null as string | null,
  // Most employers collect proofs in January and February.
  proofDeadline: `${fyStartYear(financialYear) + 1}-02-28`,
});

const loadSettings = async (organizationId: string, financialYear: string) => {
  const [row] = await db
    .select({
      financialYear: settingsTable.financialYear,
      declarationClosesOn: settingsTable.declarationClosesOn,
      proofDeadline: settingsTable.proofDeadline,
    })
    .from(settingsTable)
    .where(and(eq(settingsTable.organizationId, organizationId), eq(settingsTable.financialYear, financialYear)))
    .limit(1);
  return row ?? defaultSettings(financialYear);
};

const phaseOf = (settings: { declarationClosesOn: string | null; proofDeadline: string }, today = todayIst()): Phase => {
  if (today > settings.proofDeadline) return "closed";
  if (settings.declarationClosesOn && today > settings.declarationClosesOn) return "proofs";
  return "declaration";
};

const itemColumns = {
  id: items.id,
  section: items.section,
  kind: items.kind,
  description: items.description,
  declaredAmount: items.declaredAmount,
  details: items.details,
  status: items.status,
  verifiedAmount: items.verifiedAmount,
  reviewNote: items.reviewNote,
  reviewedAt: items.reviewedAt,
  proofStorageKey: items.proofStorageKey,
  proofName: items.proofName,
  proofUploadedAt: items.proofUploadedAt,
};

type ItemRow = Awaited<ReturnType<typeof loadItems>>[number];

const loadItems = (declarationId: string) =>
  db.select(itemColumns).from(items).where(eq(items.declarationId, declarationId)).orderBy(asc(items.createdAt));

const toItem = ({ proofStorageKey, ...row }: ItemRow) => ({
  ...row,
  sectionLabel: SECTIONS[row.section].label,
  kindLabel: SECTIONS[row.section].kinds.find((kind) => kind.value === row.kind)?.label ?? row.kind,
  hasProof: proofStorageKey !== null,
});

const asCalcItem = (row: ItemRow): DeclarationItemInput => ({
  section: row.section,
  declaredAmount: Number(row.declaredAmount),
  verifiedAmount: row.verifiedAmount === null ? null : Number(row.verifiedAmount),
  status: row.status,
  details: row.details,
});

/** Salary figures for the HRA exemption and the regime comparison. */
const loadSalary = async (membershipId: string) => {
  const [row] = await db
    .select({
      compensationType: memberships.compensationType,
      compensationAmount: memberships.compensationAmount,
      salaryComponents: memberships.salaryComponents,
    })
    .from(memberships)
    .where(eq(memberships.id, membershipId))
    .limit(1);
  if (!row) return null;
  return annualSalaryFigures({
    compensationType: row.compensationType,
    compensationAmount: row.compensationAmount === null ? null : Number(row.compensationAmount),
    components: (row.salaryComponents ?? []) as SalaryComponent[],
  });
};

/** The full picture for one declaration: items, the deduction that counts now, and both regimes' tax. */
const buildView = async (organizationId: string, membershipId: string, financialYear: string) => {
  const settings = await loadSettings(organizationId, financialYear);
  const phase = phaseOf(settings);
  const [declaration] = await db
    .select({
      id: declarations.id,
      taxRegime: declarations.taxRegime,
      seniorSelf: declarations.seniorSelf,
      seniorParents: declarations.seniorParents,
      updatedAt: declarations.updatedAt,
    })
    .from(declarations)
    .where(and(eq(declarations.userOrganizationId, membershipId), eq(declarations.financialYear, financialYear)))
    .limit(1);
  const rows = declaration ? await loadItems(declaration.id) : [];
  const salary = await loadSalary(membershipId);
  const regime: TaxRegime = declaration?.taxRegime ?? "new";
  const totals = computeDeclarationTotals({
    regime,
    flags: { seniorSelf: declaration?.seniorSelf ?? false, seniorParents: declaration?.seniorParents ?? false },
    items: rows.map(asCalcItem),
    afterProofDeadline: phase === "closed",
    salary,
  });

  let projection: ReturnType<typeof compareRegimes> | null = null;
  if (salary) {
    const statutory = (await loadStatutorySettings(organizationId)).calc;
    const [profile] = await db
      .select({ gender: profiles.gender })
      .from(profiles)
      .where(eq(profiles.userOrganizationId, membershipId))
      .limit(1);
    const monthlyPt = computeProfessionalTax(salary.annualGross / 12, `${fyStartYear(financialYear)}-04-30`, statutory, {
      pfApplicable: true,
      esiApplicable: true,
      gender: profile?.gender ?? null,
      taxRegime: regime,
      declaredDeductions: 0,
    });
    projection = compareRegimes({
      annualGross: salary.annualGross + totals.previousEmployer.gross,
      professionalTaxYear: monthlyPt * 12,
      oldRegimeDeductions: totals.oldRegimeDeductions,
    });
  }

  return {
    financialYear,
    settings,
    phase,
    declaration: declaration ?? null,
    items: rows.map(toItem),
    totals,
    projection,
    salaryKnown: salary !== null,
  };
};

export type DeclarationView = Awaited<ReturnType<typeof buildView>>;

const activeMembership = async (organizationId: string, userId: string) => {
  const membership = await getEmployeeMembership(organizationId, userId);
  return membership?.isActive ? membership : null;
};

export const getMyDeclaration = async (
  organizationId: string,
  requesterId: string,
  financialYear: string,
): Promise<ServiceResult<DeclarationView>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const membership = await activeMembership(organizationId, requesterId);
  if (!membership) return fail("forbidden");
  return ok(await buildView(organizationId, membership.id, financialYear));
};

const requireDeclarationPhase = async (organizationId: string, financialYear: string) => {
  const phase = phaseOf(await loadSettings(organizationId, financialYear));
  return phase === "declaration"
    ? null
    : fail("conflict", phase === "proofs" ? "Declarations are closed. You can still upload proofs." : "This financial year is closed.");
};

/** Creates or updates the employee's declaration header: regime and senior-citizen flags. */
export const saveMyDeclaration = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof saveDeclarationSchema>,
): Promise<ServiceResult<DeclarationView>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const membership = await activeMembership(organizationId, requesterId);
  if (!membership) return fail("forbidden");
  const closed = await requireDeclarationPhase(organizationId, input.financialYear);
  if (closed) return closed;

  const values = {
    taxRegime: input.taxRegime,
    seniorSelf: input.seniorSelf,
    seniorParents: input.seniorParents,
    updatedAt: new Date(),
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(declarations)
      .values({ organizationId, userOrganizationId: membership.id, financialYear: input.financialYear, ...values })
      .onConflictDoUpdate({ target: [declarations.userOrganizationId, declarations.financialYear], set: values });
    // Keep the statutory profile's regime in step for the current year, as reports read it from there.
    if (input.financialYear === currentFinancialYear()) {
      await tx
        .insert(profiles)
        .values({ organizationId, userOrganizationId: membership.id, taxRegime: input.taxRegime })
        .onConflictDoUpdate({ target: profiles.userOrganizationId, set: { taxRegime: input.taxRegime, updatedAt: new Date() } });
    }
  });
  return ok(await buildView(organizationId, membership.id, input.financialYear));
};

const loadOwnDeclaration = async (organizationId: string, requesterId: string, financialYear: string) => {
  const membership = await activeMembership(organizationId, requesterId);
  if (!membership) return null;
  const [declaration] = await db
    .select({ id: declarations.id })
    .from(declarations)
    .where(and(eq(declarations.userOrganizationId, membership.id), eq(declarations.financialYear, financialYear)))
    .limit(1);
  return declaration ? { membershipId: membership.id, declarationId: declaration.id } : null;
};

const validateItem = (input: z.infer<typeof declarationItemSchema>) => {
  const section = SECTIONS[input.section];
  if (!section.kinds.some((kind) => kind.value === input.kind)) return "Choose a valid type for this section";
  if (input.section === "HRA") {
    if (!input.details.monthlyRent || input.details.monthlyRent <= 0) return "Enter the monthly rent";
    if (input.declaredAmount > 100_000 && !input.details.landlordPan) {
      return "Rent above ₹1,00,000 a year needs the landlord's PAN";
    }
  }
  return null;
};

export const addDeclarationItem = async (
  organizationId: string,
  requesterId: string,
  financialYear: string,
  input: z.infer<typeof declarationItemSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const closed = await requireDeclarationPhase(organizationId, financialYear);
  if (closed) return closed;
  const own = await loadOwnDeclaration(organizationId, requesterId, financialYear);
  if (!own) return fail("conflict", "Choose your tax regime first");
  const problem = validateItem(input);
  if (problem) return fail("invalid", problem);
  await db.insert(items).values({
    organizationId,
    declarationId: own.declarationId,
    section: input.section,
    kind: input.kind,
    description: input.description || null,
    declaredAmount: input.declaredAmount.toFixed(2),
    details: input.details,
  });
  await db.update(declarations).set({ updatedAt: new Date() }).where(eq(declarations.id, own.declarationId));
  return ok(await buildView(organizationId, own.membershipId, financialYear));
};

/** The employee's own item, still open for changes (not yet accepted or rejected). */
const loadOwnOpenItem = async (organizationId: string, requesterId: string, itemId: string) => {
  const [row] = await db
    .select({
      id: items.id,
      status: items.status,
      proofStorageKey: items.proofStorageKey,
      financialYear: declarations.financialYear,
      declarationId: declarations.id,
      membershipId: memberships.id,
      employeeId: memberships.userId,
      employeeRole: memberships.role, employeeBranchId: memberships.branchId,
    })
    .from(items)
    .innerJoin(declarations, eq(declarations.id, items.declarationId))
    .innerJoin(memberships, eq(memberships.id, declarations.userOrganizationId))
    .where(and(eq(items.id, itemId), eq(items.organizationId, organizationId)))
    .limit(1);
  if (!row || row.employeeId !== requesterId) return null;
  return row;
};

export const updateDeclarationItem = async (
  organizationId: string,
  requesterId: string,
  itemId: string,
  input: z.infer<typeof declarationItemSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const row = await loadOwnOpenItem(organizationId, requesterId, itemId);
  if (!row) return fail("not-found", "Item not found");
  const closed = await requireDeclarationPhase(organizationId, row.financialYear);
  if (closed) return closed;
  if (row.status === "accepted") return fail("conflict", "This item is already verified and can no longer change");
  const problem = validateItem(input);
  if (problem) return fail("invalid", problem);
  await db
    .update(items)
    .set({
      section: input.section,
      kind: input.kind,
      description: input.description || null,
      declaredAmount: input.declaredAmount.toFixed(2),
      details: input.details,
      // A changed item needs a fresh review.
      status: "pending",
      verifiedAmount: null,
      reviewNote: null,
      updatedAt: new Date(),
    })
    .where(eq(items.id, itemId));
  return ok(await buildView(organizationId, row.membershipId, row.financialYear));
};

export const deleteDeclarationItem = async (organizationId: string, requesterId: string, itemId: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const row = await loadOwnOpenItem(organizationId, requesterId, itemId);
  if (!row) return fail("not-found", "Item not found");
  const closed = await requireDeclarationPhase(organizationId, row.financialYear);
  if (closed) return closed;
  if (row.status === "accepted") return fail("conflict", "This item is already verified and can no longer be removed");
  await db.delete(items).where(eq(items.id, itemId));
  if (row.proofStorageKey) await removeFile(row.proofStorageKey).catch(() => undefined);
  return ok(await buildView(organizationId, row.membershipId, row.financialYear));
};

/** Proofs can be uploaded until the proof deadline, also while declarations are still open. */
export const uploadItemProof = async (organizationId: string, requesterId: string, itemId: string, file: File) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const row = await loadOwnOpenItem(organizationId, requesterId, itemId);
  if (!row) return fail("not-found", "Item not found");
  if (phaseOf(await loadSettings(organizationId, row.financialYear)) === "closed") {
    return fail("conflict", "The proof deadline has passed");
  }
  if (row.status === "accepted") return fail("conflict", "This item is already verified");
  if (!isFileStorageAvailable()) return fail("invalid", "File uploads are not available right now");
  if (file.size === 0) return fail("invalid", "The file is empty");
  if (file.size > MAX_DOCUMENT_BYTES) return fail("invalid", "The proof must be 5 MB or smaller");
  const data = new Uint8Array(await file.arrayBuffer());
  const detected = detectType(data);
  if (!detected) return fail("invalid", "Proofs must be a PDF, JPG or PNG file");

  const key = `tax-proofs/${organizationId}/${row.membershipId}/${randomUUID()}.${detected.ext}`;
  await storeFile(key, data, detected.type);
  await db
    .update(items)
    .set({
      proofStorageKey: key,
      proofName: (file.name || `Proof.${detected.ext}`).slice(0, 150),
      proofUploadedAt: new Date(),
      // A rejected item with a new proof goes back for review.
      status: "pending",
      reviewNote: null,
      updatedAt: new Date(),
    })
    .where(eq(items.id, itemId));
  if (row.proofStorageKey) await removeFile(row.proofStorageKey).catch(() => undefined);

  const [person] = await db
    .select({ fname: usersTable.fname, lname: usersTable.lname })
    .from(usersTable)
    .where(eq(usersTable.id, requesterId))
    .limit(1);
  await notify({
    organizationId,
    userIds:
      row.employeeRole === UserRole.EMPLOYEE
        ? await peopleManagerIds(organizationId, requesterId)
        : await managerIds(organizationId, requesterId),
    type: "tax_proof_uploaded",
    title: `${person ? `${person.fname} ${person.lname}`.trim() : "An employee"} uploaded a tax proof`,
    body: `Financial year ${row.financialYear}`,
    link: "/tax-declarations/review",
  });
  return ok(await buildView(organizationId, row.membershipId, row.financialYear));
};

/** Who may see or review a declaration: its owner, owners and admins, and HR for employees. */
const reviewerCanSee = (manager: ActiveMembership, employeeRole: string, employeeBranchId: string | null) =>
  PEOPLE_MANAGER_ROLES.includes(manager.role) && canManageMember(manager, { role: employeeRole, branchId: employeeBranchId });

export const getProofUrl = async (organizationId: string, requesterId: string, itemId: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const [row] = await db
    .select({ key: items.proofStorageKey, name: items.proofName, employeeId: memberships.userId, employeeRole: memberships.role, employeeBranchId: memberships.branchId })
    .from(items)
    .innerJoin(declarations, eq(declarations.id, items.declarationId))
    .innerJoin(memberships, eq(memberships.id, declarations.userOrganizationId))
    .where(and(eq(items.id, itemId), eq(items.organizationId, organizationId)))
    .limit(1);
  if (!row || (row.employeeId !== requesterId && !reviewerCanSee(access.data, row.employeeRole, row.employeeBranchId))) {
    return fail("not-found", "Item not found");
  }
  if (!row.key) return fail("not-found", "No proof has been uploaded");
  return ok({ url: signedDownloadUrl(row.key), name: row.name ?? "Proof" });
};

export const listDeclarations = async (organizationId: string, requesterId: string, financialYear: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const rows = await db
    .select({
      id: declarations.id,
      membershipId: memberships.id,
      employeeId: memberships.userId,
      employeeRole: memberships.role, employeeBranchId: memberships.branchId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      employeeCode: memberships.employeeCode,
      taxRegime: declarations.taxRegime,
      updatedAt: declarations.updatedAt,
    })
    .from(declarations)
    .innerJoin(memberships, eq(memberships.id, declarations.userOrganizationId))
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .where(and(eq(declarations.organizationId, organizationId), eq(declarations.financialYear, financialYear)));
  const visible = rows
    .filter((row) => reviewerCanSee(access.data, row.employeeRole, row.employeeBranchId));
  const itemRows = visible.length
    ? await db
        .select({ declarationId: items.declarationId, declaredAmount: items.declaredAmount, status: items.status, proof: items.proofStorageKey, section: items.section })
        .from(items)
        .where(inArray(items.declarationId, visible.map((row) => row.id)))
    : [];
  return ok({
    financialYear,
    settings: await loadSettings(organizationId, financialYear),
    declarations: visible
      .map(({ fname, lname, ...row }) => {
        const mine = itemRows.filter((item) => item.declarationId === row.id);
        return {
          ...row,
          employeeName: `${fname} ${lname}`.trim(),
          itemCount: mine.length,
          declaredTotal: mine
            .filter((item) => item.section !== "PREVIOUS_EMPLOYER")
            .reduce((sum, item) => sum + Number(item.declaredAmount), 0)
            .toFixed(2),
          awaitingReview: mine.filter((item) => item.status === "pending" && item.proof !== null).length,
          missingProofs: mine.filter((item) => item.status === "pending" && item.proof === null).length,
        };
      })
      .sort((a, b) => b.awaitingReview - a.awaitingReview || a.employeeName.localeCompare(b.employeeName)),
  });
};

const loadDeclarationForReview = async (organizationId: string, declarationId: string) => {
  const [row] = await db
    .select({
      id: declarations.id,
      membershipId: memberships.id,
      employeeId: memberships.userId,
      employeeRole: memberships.role, employeeBranchId: memberships.branchId,
      financialYear: declarations.financialYear,
      fname: usersTable.fname,
      lname: usersTable.lname,
    })
    .from(declarations)
    .innerJoin(memberships, eq(memberships.id, declarations.userOrganizationId))
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .where(and(eq(declarations.id, declarationId), eq(declarations.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
};

export const getDeclarationForReview = async (organizationId: string, requesterId: string, declarationId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const row = await loadDeclarationForReview(organizationId, declarationId);
  if (!row || !reviewerCanSee(access.data, row.employeeRole, row.employeeBranchId)) return fail("not-found", "Declaration not found");
  const view = await buildView(organizationId, row.membershipId, row.financialYear);
  return ok({ ...view, employeeId: row.employeeId, employeeName: `${row.fname} ${row.lname}`.trim(), declarationId: row.id });
};

export const reviewDeclarationItem = async (
  organizationId: string,
  requesterId: string,
  itemId: string,
  input: z.infer<typeof reviewDeclarationItemSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const [row] = await db
    .select({ declarationId: items.declarationId, declaredAmount: items.declaredAmount, financialYear: declarations.financialYear })
    .from(items)
    .innerJoin(declarations, eq(declarations.id, items.declarationId))
    .where(and(eq(items.id, itemId), eq(items.organizationId, organizationId)))
    .limit(1);
  if (!row) return fail("not-found", "Item not found");
  const declaration = await loadDeclarationForReview(organizationId, row.declarationId);
  if (!declaration || !reviewerCanSee(access.data, declaration.employeeRole, declaration.employeeBranchId)) return fail("not-found", "Item not found");
  if (declaration.employeeId === requesterId && access.data.role !== UserRole.SUPER_ADMIN) {
    return fail("forbidden", "Someone else must verify your own declaration");
  }
  const verified = input.status === "accepted" ? (input.verifiedAmount ?? Number(row.declaredAmount)) : null;
  await db
    .update(items)
    .set({
      status: input.status,
      verifiedAmount: verified === null ? null : verified.toFixed(2),
      reviewNote: input.note || null,
      reviewedByUserId: requesterId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(items.id, itemId));
  if (declaration.employeeId !== requesterId) {
    await notify({
      organizationId,
      userIds: [declaration.employeeId],
      type: `tax_item_${input.status}`,
      title: input.status === "accepted" ? "A tax declaration item was verified" : "A tax declaration item was rejected",
      body: input.note || `Financial year ${declaration.financialYear}`,
      link: "/tax-declaration",
    });
  }
  return getDeclarationForReview(organizationId, requesterId, row.declarationId);
};

export const getDeclarationSettings = async (organizationId: string, requesterId: string, financialYear: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const settings = await loadSettings(organizationId, financialYear);
  return ok({ ...settings, phase: phaseOf(settings) });
};

export const saveDeclarationSettings = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof taxDeclarationSettingsSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const { from, to } = { from: `${fyStartYear(input.financialYear)}-04-01`, to: `${fyStartYear(input.financialYear) + 1}-03-31` };
  if (input.proofDeadline < from || input.proofDeadline > to) return fail("invalid", "The proof deadline must fall within the financial year");
  if (input.declarationClosesOn && input.declarationClosesOn > input.proofDeadline) {
    return fail("invalid", "Declarations must close on or before the proof deadline");
  }
  const values = { declarationClosesOn: input.declarationClosesOn ?? null, proofDeadline: input.proofDeadline, updatedAt: new Date() };
  await db
    .insert(settingsTable)
    .values({ organizationId, financialYear: input.financialYear, ...values })
    .onConflictDoUpdate({ target: [settingsTable.organizationId, settingsTable.financialYear], set: values });
  return getDeclarationSettings(organizationId, requesterId, input.financialYear);
};

/**
 * What payroll needs for TDS in a pay period: each employee's regime, the deduction that counts on
 * that date, and income and TDS from a previous employer this year. Keyed by membership id; employees
 * without a declaration are absent, and payroll keeps their statutory profile values.
 */
export const loadDeclarationAdjustments = async (organizationId: string, periodEnd: string) => {
  const financialYear = financialYearOf(periodEnd).label;
  const settings = await loadSettings(organizationId, financialYear);
  const afterProofDeadline = periodEnd > settings.proofDeadline;
  const rows = await db
    .select({
      id: declarations.id,
      membershipId: declarations.userOrganizationId,
      taxRegime: declarations.taxRegime,
      seniorSelf: declarations.seniorSelf,
      seniorParents: declarations.seniorParents,
      compensationType: memberships.compensationType,
      compensationAmount: memberships.compensationAmount,
      salaryComponents: memberships.salaryComponents,
    })
    .from(declarations)
    .innerJoin(memberships, eq(memberships.id, declarations.userOrganizationId))
    .where(and(eq(declarations.organizationId, organizationId), eq(declarations.financialYear, financialYear)));
  const allItems = rows.length
    ? await db.select().from(items).where(inArray(items.declarationId, rows.map((row) => row.id)))
    : [];

  const adjustments = new Map<string, { regime: TaxRegime; deductions: number; previousGross: number; previousTds: number }>();
  for (const row of rows) {
    const totals = computeDeclarationTotals({
      regime: row.taxRegime,
      flags: { seniorSelf: row.seniorSelf, seniorParents: row.seniorParents },
      items: allItems
        .filter((item) => item.declarationId === row.id)
        .map((item) => ({
          section: item.section as TaxDeclarationSection,
          declaredAmount: Number(item.declaredAmount),
          verifiedAmount: item.verifiedAmount === null ? null : Number(item.verifiedAmount),
          status: item.status,
          details: item.details,
        })),
      afterProofDeadline,
      salary: annualSalaryFigures({
        compensationType: row.compensationType,
        compensationAmount: row.compensationAmount === null ? null : Number(row.compensationAmount),
        components: (row.salaryComponents ?? []) as SalaryComponent[],
      }),
    });
    adjustments.set(row.membershipId, {
      regime: row.taxRegime,
      deductions: totals.deductions,
      previousGross: totals.previousEmployer.gross,
      previousTds: totals.previousEmployer.tds,
    });
  }
  return adjustments;
};

/** Data for Form 12BB: the employee, the employer, and the declared items grouped as the form asks. */
export const loadForm12bb = async (organizationId: string, requesterId: string, declarationId: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const row = await loadDeclarationForReview(organizationId, declarationId);
  if (!row || (row.employeeId !== requesterId && !reviewerCanSee(access.data, row.employeeRole, row.employeeBranchId))) {
    return fail("not-found", "Declaration not found");
  }
  const [[organization], [profile], view] = await Promise.all([
    db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1),
    db.select({ panEncrypted: profiles.panEncrypted }).from(profiles).where(eq(profiles.userOrganizationId, row.membershipId)).limit(1),
    buildView(organizationId, row.membershipId, row.financialYear),
  ]);
  return ok({
    organizationName: organization?.name ?? "",
    employeeName: `${row.fname} ${row.lname}`.trim(),
    panStored: profile?.panEncrypted ?? null,
    view,
  });
};
