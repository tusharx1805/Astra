import { afterEach, describe, expect, it } from "vitest";
import { classifyAddress, resolveTarget } from "./pgClient";

afterEach(() => { delete process.env.ASTRA_CONNECTOR_ALLOW_PRIVATE_NETWORK; });
const lookupOf = (...addresses: string[]) => async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("Phase 9 network policy", () => {
  it("classifies addresses", () => {
    expect(["8.8.8.8", "2600:1f18::1"].map(classifyAddress)).toEqual(["public", "public"]);
    expect(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"].map(classifyAddress)).toEqual(Array(8).fill("private"));
    expect(["169.254.169.254", "0.0.0.0", "224.0.0.1", "fe80::1", "::", "not-an-ip"].map(classifyAddress)).toEqual(Array(6).fill("blocked"));
  });

  it("blocks private hosts by default, including names that resolve to them (and mixed answers)", async () => {
    await expect(resolveTarget("db.internal", "require", lookupOf("10.0.0.7"))).rejects.toThrow(/private or loopback/);
    await expect(resolveTarget("rebind.example.com", "require", lookupOf("52.1.1.1", "127.0.0.1"))).rejects.toThrow(/private or loopback/);
    await expect(resolveTarget("meta.example.com", "require", lookupOf("169.254.169.254"))).rejects.toThrow(/never connects/);
    await expect(resolveTarget("db.example.com", "require", lookupOf("52.1.1.1"))).resolves.toEqual({ address: "52.1.1.1", family: 4, private: false });
  });

  it("dev mode allows private networks but still never the metadata range, and plaintext only to private hosts", async () => {
    process.env.ASTRA_CONNECTOR_ALLOW_PRIVATE_NETWORK = "true";
    await expect(resolveTarget("db.internal", "disable", lookupOf("10.0.0.7"))).resolves.toMatchObject({ address: "10.0.0.7", private: true });
    await expect(resolveTarget("169.254.169.254", "require")).rejects.toThrow(/never connects/);
    await expect(resolveTarget("db.example.com", "disable", lookupOf("52.1.1.1"))).rejects.toThrow(/Unencrypted/);
  });

  it("pins the connection to the checked address (no second DNS lookup)", async () => {
    let calls = 0;
    const lookup = async () => { calls += 1; return [{ address: "52.1.1.1", family: 4 }]; };
    const resolved = await resolveTarget("db.example.com", "verify-full", lookup);
    expect(resolved.address).toBe("52.1.1.1");
    expect(calls).toBe(1);
  });
});
