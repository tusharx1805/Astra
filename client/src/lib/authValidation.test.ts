import { describe, expect, it } from "vitest";
import { classifyAuthError, friendlyAuthError } from "./authErrors";
import { passwordStrength, safeNextPath, validateLogin, validatePassword, validateSignup } from "./authValidation";

const valid = { fullName: "Ada Lovelace", username: "Ada_L", email: "ada@example.com", password: "Engines1843", confirmPassword: "Engines1843" };

describe("signup validation", () => {
  it("accepts a valid form (username is case-insensitive)", () => {
    expect(validateSignup(valid)).toEqual({});
  });

  it.each([
    [{ email: "not-an-email" }, "email", "valid email"],
    [{ email: "" }, "email", "Enter your email"],
    [{ password: "short1", confirmPassword: "short1" }, "password", "at least 8"],
    [{ password: "onlyletters", confirmPassword: "onlyletters" }, "password", "letter and one number"],
    [{ confirmPassword: "Engines1844" }, "confirmPassword", "do not match"],
    [{ username: "ab" }, "username", "3–30"],
    [{ username: "has space" }, "username", "3–30"],
    [{ fullName: "   " }, "fullName", "full name"],
  ])("rejects %o", (override, field, message) => {
    const errors = validateSignup({ ...valid, ...override });
    expect(errors[field as keyof typeof errors]).toContain(message);
  });

  it("caps password length at the bcrypt limit", () => {
    expect(validatePassword(`A1${"x".repeat(80)}`)).toContain("at most 72");
  });

  it("scores password strength", () => {
    expect(passwordStrength("abc").label).toBe("Too short");
    expect(passwordStrength("abcdefgh").score).toBe(1);
    expect(passwordStrength("Abcdefg1").score).toBe(2);
    expect(passwordStrength("Abcdefg1!long").score).toBe(4);
  });
});

describe("login validation", () => {
  it("requires both fields", () => {
    expect(validateLogin({ email: "", password: "" })).toEqual({ email: "Enter your email address.", password: "Enter your password." });
  });
});

describe("safeNextPath (post-login redirect)", () => {
  it.each([
    ["/datasets/13", "/datasets/13"],
    ["%2Fpipelines%3Ftab%3Druns", "/pipelines?tab=runs"],
    [null, "/"],
    ["https://evil.example", "/"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["/login", "/"],
    ["/signup?next=/x", "/"],
    ["javascript:alert(1)", "/"],
  ])("%s → %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe("Supabase error mapping", () => {
  it.each([
    [{ code: "invalid_credentials", message: "Invalid login credentials" }, "invalid_credentials"],
    [{ message: "Email not confirmed" }, "email_not_confirmed"],
    [{ code: "user_already_exists", message: "User already registered" }, "email_exists"],
    [{ code: "weak_password", message: "Password should be at least 10 characters" }, "weak_password"],
    [{ code: "over_email_send_rate_limit", status: 429 }, "rate_limited"],
    [{ code: "unexpected_failure", message: "Database error saving new user" }, "username_taken"],
    [{ name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 }, "network"],
    [{ code: "refresh_token_not_found" }, "session_expired"],
    [{ message: "some internal stack detail" }, "unknown"],
  ])("%o → %s", (error, kind) => {
    expect(classifyAuthError(error)).toBe(kind);
  });

  it("never exposes the raw message", () => {
    expect(friendlyAuthError({ message: "pq: relation auth.users internal detail" }).message).toBe("Something went wrong. Please try again.");
  });
});
