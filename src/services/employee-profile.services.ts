import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import { employeeProfilesTable } from "@/drizzle/schema";
import { authorizeEmployeeRecord } from "@/services/access.services";
import { ok, type ServiceResult } from "@/utils/result";
import { decryptSecret, encryptSecret, maskAccountNumber } from "@/utils/crypto";
import type { profileSchema } from "@/validator/employee-record.validator";

const columns = {
  dateOfBirth: employeeProfilesTable.dateOfBirth,
  addressLine1: employeeProfilesTable.addressLine1,
  addressLine2: employeeProfilesTable.addressLine2,
  city: employeeProfilesTable.city,
  state: employeeProfilesTable.state,
  postalCode: employeeProfilesTable.postalCode,
  country: employeeProfilesTable.country,
  emergencyContactName: employeeProfilesTable.emergencyContactName,
  emergencyContactRelation: employeeProfilesTable.emergencyContactRelation,
  emergencyContactPhone: employeeProfilesTable.emergencyContactPhone,
  bankAccountHolder: employeeProfilesTable.bankAccountHolder,
  bankName: employeeProfilesTable.bankName,
  bankAccountNumber: employeeProfilesTable.bankAccountLast4,
  bankIfsc: employeeProfilesTable.bankIfsc,
  upiId: employeeProfilesTable.upiId,
  updatedAt: employeeProfilesTable.updatedAt,
};

export type EmployeeProfile = Record<keyof typeof columns, string | Date | null>;

const empty = (): EmployeeProfile =>
  Object.fromEntries(Object.keys(columns).map((key) => [key, null])) as EmployeeProfile;

const withMask = (profile: EmployeeProfile): EmployeeProfile => ({
  ...profile,
  bankAccountNumber: maskAccountNumber(profile.bankAccountNumber as string | null),
});

/** Real account number for payouts. Server-side only; never expose it through an endpoint. */
export const getBankAccountNumberForPayout = async (organizationId: string, employeeId: string) => {
  const [row] = await db
    .select({ value: employeeProfilesTable.bankAccountNumber })
    .from(employeeProfilesTable)
    .where(
      and(
        eq(employeeProfilesTable.organizationId, organizationId),
        eq(employeeProfilesTable.userId, employeeId),
      ),
    )
    .limit(1);
  return row?.value ? decryptSecret(row.value) : null;
};

export const getEmployeeProfile = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
): Promise<ServiceResult<EmployeeProfile>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;

  const [profile] = await db
    .select(columns)
    .from(employeeProfilesTable)
    .where(
      and(
        eq(employeeProfilesTable.organizationId, organizationId),
        eq(employeeProfilesTable.userId, employeeId),
      ),
    )
    .limit(1);
  return ok(profile ? withMask(profile) : empty());
};

export const saveEmployeeProfile = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  input: z.infer<typeof profileSchema>,
): Promise<ServiceResult<EmployeeProfile>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;

  const { bankAccountNumber, ...rest } = input;
  const values = {
    ...rest,
    ...(bankAccountNumber === undefined
      ? {}
      : {
          bankAccountNumber: bankAccountNumber ? encryptSecret(bankAccountNumber) : null,
          bankAccountLast4: bankAccountNumber ? bankAccountNumber.slice(-4) : null,
        }),
    updatedAt: new Date(),
    updatedBy: requesterId,
  };
  const [profile] = await db
    .insert(employeeProfilesTable)
    .values({ organizationId, userId: employeeId, ...values })
    .onConflictDoUpdate({
      target: [employeeProfilesTable.organizationId, employeeProfilesTable.userId],
      set: values,
    })
    .returning(columns);
  return ok(withMask(profile));
};
