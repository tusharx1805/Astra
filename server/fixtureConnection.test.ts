import { afterEach, describe, expect, it } from "vitest";
import { buildEncryptedConnectionMetadata, validateReadOnlyStatement } from "./fixtureConnection";

afterEach(() => { delete process.env.CONNECTION_ENCRYPTION_KEY; });

describe("fixture connection safety", () => {
  it("accepts bounded SELECT statements and rejects writes", () => {
    expect(validateReadOnlyStatement("SELECT * FROM customers").ok).toBe(true);
    expect(validateReadOnlyStatement("DELETE FROM customers").ok).toBe(false);
    expect(validateReadOnlyStatement("ALTER TABLE customers ADD COLUMN x INT").ok).toBe(false);
  });

  it("does not persist credential metadata without the production key", () => {
    const result = buildEncryptedConnectionMetadata({ workspaceId: 1, name: "Analytics", host: "localhost", port: 5432, databaseName: "analytics", username: "readonly", password: "secret", sslMode: "require" });
    expect(result.persisted).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
