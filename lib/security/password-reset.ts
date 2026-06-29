import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";

export const passwordResetEmailSchema = z.string().trim().email().max(254);

export const newPasswordSchema = z
  .string()
  .min(12, "La contrasena debe tener al menos 12 caracteres.")
  .max(128)
  .regex(/[a-z]/, "Incluye al menos una letra minuscula.")
  .regex(/[A-Z]/, "Incluye al menos una letra mayuscula.")
  .regex(/[0-9]/, "Incluye al menos un numero.");

export function normalizeResetEmail(email: string) {
  return email.trim().toLowerCase();
}

export function generatePasswordResetCode() {
  const letters = Array.from({ length: 4 }, () => LETTERS[randomInt(0, LETTERS.length)]).join("");
  const digits = Array.from({ length: 4 }, () => DIGITS[randomInt(0, DIGITS.length)]).join("");
  return `${letters}${digits}`;
}

export function generatePasswordResetToken() {
  return randomBytes(32).toString("base64url");
}

export function getPasswordResetSecret() {
  const secret = process.env.PASSWORD_RESET_SECRET?.trim();
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV !== "production") return "quiksol-development-password-reset-secret-change-me";
  throw new Error("PASSWORD_RESET_SECRET must contain at least 32 characters.");
}

function digest(value: string, email: string, purpose: "code" | "token", secret = getPasswordResetSecret()) {
  return createHmac("sha256", secret)
    .update(`${purpose}:${normalizeResetEmail(email)}:${value}`)
    .digest("hex");
}

export function hashPasswordResetCode(code: string, email: string, secret?: string) {
  return digest(code.trim().toUpperCase(), email, "code", secret);
}

export function hashPasswordResetToken(token: string, email: string, secret?: string) {
  return digest(token.trim(), email, "token", secret);
}

export function secureHashEquals(actualHash: string | null | undefined, expectedHash: string) {
  if (!actualHash || actualHash.length !== expectedHash.length) return false;
  return timingSafeEqual(Buffer.from(actualHash, "utf8"), Buffer.from(expectedHash, "utf8"));
}

export function passwordResetExpiresAt(now = Date.now()) {
  const requestedMinutes = Number(process.env.PASSWORD_RESET_CODE_TTL_MINUTES || 15);
  const minutes = Number.isFinite(requestedMinutes) ? Math.min(Math.max(requestedMinutes, 5), 30) : 15;
  return new Date(now + minutes * 60_000);
}

export function passwordResetMaxAttempts() {
  const requested = Number(process.env.PASSWORD_RESET_MAX_ATTEMPTS || 5);
  return Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 3), 10) : 5;
}

export function passwordResetCooldownSeconds() {
  const requested = Number(process.env.PASSWORD_RESET_RESEND_SECONDS || 60);
  return Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 30), 300) : 60;
}
