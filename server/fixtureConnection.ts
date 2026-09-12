import { encryptConnectionPassword, hasConnectionEncryptionKey } from "./connectionCrypto";

export function validateReadOnlyStatement(statement: string) {
  const normalized = statement.trim().replace(/;+$|\s+/g, " ").toLowerCase();
  if (!/^select\b/.test(normalized)) return { ok: false as const, reason: "Only SELECT statements are permitted." };
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call)\b/.test(normalized)) return { ok: false as const, reason: "Write, DDL, and procedure statements are blocked." };
  return { ok: true as const, normalized };
}

export function buildEncryptedConnectionMetadata(input: { workspaceId: number; name: string; host: string; port: number; databaseName: string; username: string; password: string; sslMode: string; }) {
  if (!hasConnectionEncryptionKey()) return { persisted: false as const, mode: "fixture" as const, message: "Connection metadata is not persisted until CONNECTION_ENCRYPTION_KEY is supplied." };
  return { persisted: true as const, record: { workspaceId: input.workspaceId, name: input.name, type: "postgresql", host: input.host, port: input.port, databaseName: input.databaseName, username: input.username, encryptedPassword: encryptConnectionPassword(input.password), sslMode: input.sslMode } };
}
