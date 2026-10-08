import crypto from "node:crypto";

const PREFIX = "astra:v1";

function keyFromEnv() {
  const raw = process.env.CONNECTION_ENCRYPTION_KEY;
  if (!raw) throw new Error("CONNECTION_ENCRYPTION_KEY is required for credential persistence.");
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptConnectionPassword(password: string) {
  if (!password) throw new Error("A connection password is required.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromEnv(), iv);
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptConnectionPassword(payload: string) {
  const [prefix, ivEncoded, tagEncoded, dataEncoded] = payload.split(".");
  if (prefix !== PREFIX || !ivEncoded || !tagEncoded || !dataEncoded) throw new Error("Invalid connection credential payload.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromEnv(), Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataEncoded, "base64url")), decipher.final()]).toString("utf8");
}

export function hasConnectionEncryptionKey() {
  return Boolean(process.env.CONNECTION_ENCRYPTION_KEY);
}
