import { S3Client } from "bun";

import { env } from "@/utils/env";

const PRESIGN_SECONDS = 24 * 3600;

export const isR2Configured = () =>
  Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET);

let client: S3Client | undefined;

const getClient = () => {
  if (!isR2Configured()) throw new Error("Cloudflare R2 is not configured");
  client ??= new S3Client({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: "auto",
  });
  return client;
};

/** Uploads a private PDF to R2 and returns a time-limited download URL. */
export const uploadPdf = async (key: string, pdf: Buffer) => {
  const r2 = getClient();
  await r2.write(key, pdf, { type: "application/pdf" });
  return r2.presign(key, { expiresIn: PRESIGN_SECONDS, method: "GET" });
};

export const putPrivateObject = async (key: string, data: Uint8Array | ArrayBuffer | Buffer, type: string) => {
  await getClient().write(key, data, { type });
};

export const deleteObject = async (key: string) => {
  await getClient().delete(key);
};

export const presignDownload = (key: string, expiresIn = 300) =>
  getClient().presign(key, { expiresIn, method: "GET" });
