import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "@/utils/env";

const PREFIX = "enc:v1:";
const key = Buffer.from(env.BANK_ENCRYPTION_KEY, "hex");

export const isEncrypted = (value: string) => value.startsWith(PREFIX);

/** AES-256-GCM; output is `enc:v1:<iv>:<tag>:<ciphertext>` in base64. */
export const encryptSecret = (plain: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
};

/** Use only where the real value is needed, such as a salary payout. Never return it from an API. */
export const decryptSecret = (stored: string) => {
  if (!isEncrypted(stored)) return stored;
  const [iv, tag, data] = stored.slice(PREFIX.length).split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
};

export const maskAccountNumber = (last4: string | null) => (last4 ? `••••••${last4}` : null);
