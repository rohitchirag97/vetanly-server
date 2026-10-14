import { randomUUID } from "node:crypto";

import { and, count, desc, eq } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import { employeeDocumentsTable } from "@/drizzle/schema";
import { authorizeEmployeeRecord } from "@/services/access.services";
import { deleteObject, isR2Configured, presignDownload, putPrivateObject } from "@/utils/r2";
import { fail, ok, type ServiceResult } from "@/utils/result";
import {
  EMPLOYEE_UPLOAD_TYPES,
  type documentFieldsSchema,
} from "@/validator/employee-record.validator";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENTS_PER_EMPLOYEE = 30;

// The declared MIME type is client-controlled, so the file's own signature decides.
const SIGNATURES: { type: string; ext: string; bytes: number[] }[] = [
  { type: "application/pdf", ext: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { type: "image/jpeg", ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/png", ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
];

const detectType = (data: Uint8Array) =>
  SIGNATURES.find(({ bytes }) => bytes.every((byte, index) => data[index] === byte));

const columns = {
  id: employeeDocumentsTable.id,
  docType: employeeDocumentsTable.docType,
  name: employeeDocumentsTable.name,
  contentType: employeeDocumentsTable.contentType,
  sizeBytes: employeeDocumentsTable.sizeBytes,
  uploadedBy: employeeDocumentsTable.uploadedBy,
  createdAt: employeeDocumentsTable.createdAt,
};

export type EmployeeDocument = {
  id: string;
  docType: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: Date;
};

export const listEmployeeDocuments = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
): Promise<ServiceResult<EmployeeDocument[]>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;

  return ok(
    await db
      .select(columns)
      .from(employeeDocumentsTable)
      .where(
        and(
          eq(employeeDocumentsTable.organizationId, organizationId),
          eq(employeeDocumentsTable.userId, employeeId),
        ),
      )
      .orderBy(desc(employeeDocumentsTable.createdAt))
      .limit(100),
  );
};

export const uploadEmployeeDocument = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  fields: z.infer<typeof documentFieldsSchema>,
  file: File,
): Promise<ServiceResult<EmployeeDocument>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;
  if (!access.data.isManager && !EMPLOYEE_UPLOAD_TYPES.includes(fields.docType)) {
    return fail("forbidden", "Only an admin can upload this type of document");
  }
  if (!isR2Configured()) return fail("invalid", "File storage is not configured");
  if (file.size === 0) return fail("invalid", "The file is empty");
  if (file.size > MAX_DOCUMENT_BYTES) return fail("invalid", "The file must be 5 MB or smaller");

  const data = new Uint8Array(await file.arrayBuffer());
  const detected = detectType(data);
  if (!detected) return fail("invalid", "Only PDF, JPG and PNG files are allowed");

  const [{ total }] = await db
    .select({ total: count() })
    .from(employeeDocumentsTable)
    .where(
      and(
        eq(employeeDocumentsTable.organizationId, organizationId),
        eq(employeeDocumentsTable.userId, employeeId),
      ),
    );
  if (total >= MAX_DOCUMENTS_PER_EMPLOYEE) {
    return fail("invalid", "Document limit reached for this employee");
  }

  const storageKey = `employee-documents/${organizationId}/${employeeId}/${randomUUID()}.${detected.ext}`;
  await putPrivateObject(storageKey, data, detected.type);

  try {
    const [document] = await db
      .insert(employeeDocumentsTable)
      .values({
        organizationId,
        userId: employeeId,
        docType: fields.docType,
        name: (fields.name || file.name || "Document").slice(0, 150),
        storageKey,
        contentType: detected.type,
        sizeBytes: file.size,
        uploadedBy: requesterId,
      })
      .returning(columns);
    return ok(document);
  } catch (error) {
    await deleteObject(storageKey).catch(() => undefined);
    throw error;
  }
};

const findDocument = (organizationId: string, employeeId: string, documentId: string) =>
  db
    .select()
    .from(employeeDocumentsTable)
    .where(
      and(
        eq(employeeDocumentsTable.id, documentId),
        eq(employeeDocumentsTable.organizationId, organizationId),
        eq(employeeDocumentsTable.userId, employeeId),
      ),
    )
    .limit(1)
    .then(([document]) => document);

export const getEmployeeDocumentUrl = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  documentId: string,
): Promise<ServiceResult<{ url: string; name: string }>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;
  const document = await findDocument(organizationId, employeeId, documentId);
  if (!document) return fail("not-found", "Document not found");
  if (!isR2Configured()) return fail("invalid", "File storage is not configured");
  return ok({ url: presignDownload(document.storageKey), name: document.name });
};

export const deleteEmployeeDocument = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  documentId: string,
): Promise<ServiceResult<null>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;
  const document = await findDocument(organizationId, employeeId, documentId);
  if (!document) return fail("not-found", "Document not found");
  if (!access.data.isManager && document.uploadedBy !== requesterId) return fail("forbidden");

  await db.delete(employeeDocumentsTable).where(eq(employeeDocumentsTable.id, document.id));
  if (isR2Configured()) await deleteObject(document.storageKey).catch(() => undefined);
  return ok(null);
};
