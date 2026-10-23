export type KioskReviewConfig = {
  kioskId?: string;
  pairingCode?: string;
  enrollmentCode?: string;
};

/**
 * Google Play review access: one demo kiosk with fixed pairing and manager codes that are never
 * consumed, so app reviewers can always get past pairing. Returns that kiosk's id when `code` is
 * its review code for `kind`, otherwise null. Unset config disables it.
 */
export const reviewKioskFor = (config: KioskReviewConfig, kind: "pair" | "enroll", code: string) => {
  const expected = kind === "pair" ? config.pairingCode : config.enrollmentCode;
  return config.kioskId && expected && code === expected ? config.kioskId : null;
};
