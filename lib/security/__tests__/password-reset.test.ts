import { describe, expect, it } from "vitest";
import {
  generatePasswordResetCode,
  generatePasswordResetToken,
  getPasswordResetSecret,
  hashPasswordResetCode,
  hashPasswordResetToken,
  newPasswordSchema,
  normalizeResetEmail,
  secureHashEquals
} from "@/lib/security/password-reset";

const SECRET = "test-password-reset-secret-with-more-than-32-characters";

describe("password reset security helpers", () => {
  it("generates four letters followed by four digits", () => {
    expect(generatePasswordResetCode()).toMatch(/^[A-Z]{4}[0-9]{4}$/);
  });

  it("normalizes email and compares only hashes", () => {
    const email = normalizeResetEmail(" User@Example.COM ");
    const hash = hashPasswordResetCode("ABCD1234", email, SECRET);
    expect(email).toBe("user@example.com");
    expect(hash).not.toContain("ABCD1234");
    expect(secureHashEquals(hash, hashPasswordResetCode("abcd1234", email, SECRET))).toBe(true);
    expect(secureHashEquals(hash, hashPasswordResetCode("WXYZ9876", email, SECRET))).toBe(false);
  });

  it("creates one-time reset tokens with a separate hash purpose", () => {
    const token = generatePasswordResetToken();
    const tokenHash = hashPasswordResetToken(token, "user@example.com", SECRET);
    const codeHash = hashPasswordResetCode(token, "user@example.com", SECRET);
    expect(token.length).toBeGreaterThan(30);
    expect(tokenHash).not.toBe(codeHash);
  });

  it("requires a strong replacement password", () => {
    expect(newPasswordSchema.safeParse("weak-password").success).toBe(false);
    expect(newPasswordSchema.safeParse("StrongPassword2026").success).toBe(true);
  });

  it("fails closed in production when the reset secret is missing", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSecret = process.env.PASSWORD_RESET_SECRET;

    try {
      process.env.NODE_ENV = "production";
      delete process.env.PASSWORD_RESET_SECRET;
      expect(() => getPasswordResetSecret()).toThrow("PASSWORD_RESET_SECRET");
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalSecret === undefined) delete process.env.PASSWORD_RESET_SECRET;
      else process.env.PASSWORD_RESET_SECRET = originalSecret;
    }
  });
});
