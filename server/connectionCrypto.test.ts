import { describe, expect, it, afterEach } from "vitest";
import { decryptConnectionPassword, encryptConnectionPassword } from "./connectionCrypto";

afterEach(() => { delete process.env.CONNECTION_ENCRYPTION_KEY; });

describe("connection credential encryption", () => {
  it("round-trips server-only credentials without storing plaintext", () => {
    process.env.CONNECTION_ENCRYPTION_KEY = "fixture-development-key";
    const payload = encryptConnectionPassword("not-for-client");
    expect(payload).not.toContain("not-for-client");
    expect(decryptConnectionPassword(payload)).toBe("not-for-client");
  });

  it("fails closed when the production key is missing", () => {
    expect(() => encryptConnectionPassword("secret")).toThrow("CONNECTION_ENCRYPTION_KEY");
  });
});
