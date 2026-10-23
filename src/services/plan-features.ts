/**
 * What a plan can include. A paid plan unlocks only its features; the free trial, and organizations
 * with no paid plan, get every feature (read-only after the trial is handled by billing access).
 *
 * Every API module is either here or in CORE_PATHS (plan-features.test.ts fails otherwise), so a
 * new module has to be put on the plan checklist or declared core.
 */
export const PLAN_FEATURES = {
  attendance: {
    label: "Attendance",
    requires: [],
    // Kiosks, face check-in, corrections and the shift roster only feed attendance.
    paths: ["/attendance", "/kiosk-device", "/face-template", "/regularization", "/roster"],
  },
  overtime: { label: "Overtime", requires: ["attendance"], paths: ["/overtime"] },
  leave: { label: "Leave", requires: [], paths: ["/leave"] },
  // Pay is worked out from attendance, so payroll cannot run without it.
  payroll: { label: "Payroll", requires: ["attendance"], paths: ["/payroll"] },
  statutory: { label: "Statutory (PF, ESI, PT, TDS)", requires: ["payroll"], paths: ["/statutory", "/tax-declarations"] },
  loans: { label: "Loans & advances", requires: ["payroll"], paths: ["/recoverable"] },
  // Claims can be paid outside payroll, so expenses stand alone.
  expenses: { label: "Expense claims", requires: [], paths: ["/expenses"] },
  settlements: { label: "Full & final settlement", requires: ["payroll"], paths: ["/settlements"] },
  bonus: { label: "Bonus & gratuity", requires: ["payroll"], paths: ["/bonus"] },
  accounting: { label: "Accounting export", requires: ["payroll"], paths: ["/accounting"] },
  documents: { label: "Employee documents", requires: [], paths: [/^\/employee-record\/[^/]+\/documents(\/|$)/] },
  assets: { label: "Assets", requires: [], paths: ["/assets"] },
  reports: { label: "Reports & insights", requires: [], paths: ["/report", "/insights"] },
} as const satisfies Record<string, { label: string; requires: readonly string[]; paths: readonly (string | RegExp)[] }>;

export type PlanFeature = keyof typeof PLAN_FEATURES;
export const ALL_FEATURES = Object.keys(PLAN_FEATURES) as PlanFeature[];

/** Modules every organization has, whatever the plan. Payroll settings stay open: weekly offs also drive attendance. */
export const CORE_PATHS = [
  "/auth", "/user", "/organization", "/employee", "/department", "/shift", "/holiday", "/employee-record",
  "/payroll-settings", "/audit-log", "/notification", "/announcements", "/platform", "/billing", "/onboarding",
  "/files", "/branches", "/messaging",
];

/** The features plus everything they need, in catalog order; unknown names are dropped. */
export const withRequirements = (features: readonly string[]): PlanFeature[] => {
  const result = new Set<PlanFeature>();
  const add = (feature: string) => {
    if (!(feature in PLAN_FEATURES) || result.has(feature as PlanFeature)) return;
    result.add(feature as PlanFeature);
    PLAN_FEATURES[feature as PlanFeature].requires.forEach(add);
  };
  features.forEach(add);
  return ALL_FEATURES.filter((feature) => result.has(feature));
};

/** The feature that owns an API path (without the /api/v1 prefix), or null for core modules. */
export const featureForPath = (path: string): PlanFeature | null => {
  for (const feature of ALL_FEATURES) {
    for (const prefix of PLAN_FEATURES[feature].paths) {
      if (typeof prefix === "string" ? path === prefix || path.startsWith(`${prefix}/`) : prefix.test(path)) return feature;
    }
  }
  return null;
};

/**
 * An organization's features. Only a paid plan restricts them: during the trial (including a plan assigned
 * with status "trial") and without any paid period, everything is on.
 */
export const featuresOf = (row: {
  accessState: string;
  paidUntil: string | null;
  subscriptionStatus: string | null;
  planFeatures: string[] | null;
}): PlanFeature[] =>
  row.accessState === "trial" || !row.paidUntil || !row.planFeatures || row.subscriptionStatus === "trial"
    ? ALL_FEATURES
    : withRequirements(row.planFeatures);

export const featureMissingMessage = (feature: PlanFeature) =>
  `${PLAN_FEATURES[feature].label} is not included in your organization's plan. The owner can change the plan from the Billing page.`;
