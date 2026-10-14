import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { env } from "@/utils/env";
import { isR2Configured, putPrivateObject, deleteObject as deleteR2Object, presignDownload } from "@/utils/r2";

/**
 * Private file storage for uploads such as receipts and employee documents.
 * Cloudflare R2 when it is configured. Without R2, development falls back to a local folder
 * served through short-lived signed links, so uploads can be tested. Production requires R2:
 * a server's local disk can be wiped on redeploy and is not shared between instances.
 */

const LOCAL_ROOT = path.resolve(process.cwd(), "storage", "uploads");
const useLocal = () => !isR2Configured() && process.env.NODE_ENV !== "production";

export const isFileStorageAvailable = () => isR2Configured() || useLocal();

const localPath = (key: string) => {
  const resolved = path.resolve(LOCAL_ROOT, key);
  // Keys are built by the server, but never let one escape the storage folder.
  if (!resolved.startsWith(LOCAL_ROOT + path.sep)) throw new Error("Invalid storage key");
  return resolved;
};

export const storeFile = async (key: string, data: Uint8Array, contentType: string) => {
  if (!useLocal()) return putPrivateObject(key, data, contentType);
  const file = localPath(key);
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, data);
};

export const removeFile = async (key: string) => {
  if (!useLocal()) return deleteR2Object(key);
  await rm(localPath(key), { force: true });
};

const sign = (key: string, expires: number) =>
  createHmac("sha256", env.JWT_SECRET).update(`file:${key}:${expires}`).digest("base64url");

/** A link that opens the file for a few minutes without the user's login token. */
export const signedDownloadUrl = (key: string, expiresInSeconds = 300) => {
  if (!useLocal()) return presignDownload(key, expiresInSeconds);
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const base = env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`;
  const params = new URLSearchParams({ key, expires: String(expires), signature: sign(key, expires) });
  return `${base}/api/v1/files/download?${params}`;
};

const CONTENT_TYPES: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png" };

/** Serves a local file for a valid, unexpired signed link; null when the link is invalid or the file is gone. */
export const readSignedLocalFile = async (query: { key?: string; expires?: string; signature?: string }) => {
  if (!useLocal() || !query.key || !query.expires || !query.signature) return null;
  const expires = Number(query.expires);
  if (!Number.isFinite(expires) || expires < Date.now() / 1000) return null;
  const expected = Buffer.from(sign(query.key, expires));
  const given = Buffer.from(query.signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const file = Bun.file(localPath(query.key));
  if (!(await file.exists())) return null;
  const extension = query.key.split(".").pop()?.toLowerCase() ?? "";
  return { file, contentType: CONTENT_TYPES[extension] ?? "application/octet-stream" };
};
