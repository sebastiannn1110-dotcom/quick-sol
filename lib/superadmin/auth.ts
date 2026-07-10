import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger/logger";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { requestIp } from "@/lib/security/rateLimit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

const COOKIE_NAME = "__quiksol_superadmin";

export const superadminLoginSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(500)
});

interface SuperadminSessionPayload {
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
}

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

function fromBase64url(input: string) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sessionSecret() {
  return process.env.SUPERADMIN_SESSION_SECRET || "";
}

function ttlMinutes() {
  const value = Number(process.env.SUPERADMIN_SESSION_TTL_MINUTES || 60);
  return Number.isFinite(value) && value > 0 ? value : 60;
}

function maxLoginAttempts() {
  const value = Number(process.env.SUPERADMIN_MAX_LOGIN_ATTEMPTS || 5);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

function lockoutMinutes() {
  const value = Number(process.env.SUPERADMIN_LOCKOUT_MINUTES || 15);
  return Number.isFinite(value) && value > 0 ? value : 15;
}

function sign(value: string) {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function safeCompare(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createScryptPasswordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
  return `scrypt$16384$8$1$${salt}$${hash}`;
}

function verifyPasswordHash(password: string, configuredHash: string) {
  if (configuredHash.startsWith("scrypt$")) {
    const [, n, r, p, salt, expected] = configuredHash.split("$");
    if (!n || !r || !p || !salt || !expected) return false;
    const actual = scryptSync(password, salt, 64, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024
    }).toString("hex");
    return safeCompare(actual, expected);
  }

  if (configuredHash.startsWith("sha256:")) {
    const expected = configuredHash.slice("sha256:".length);
    const actual = createHash("sha256").update(password).digest("hex");
    return safeCompare(actual, expected);
  }

  return false;
}

export function superadminConfigStatus() {
  return {
    route: process.env.SUPERADMIN_ROUTE || "/admindev",
    hasUsername: Boolean(process.env.SUPERADMIN_USERNAME),
    hasPasswordHash: Boolean(process.env.SUPERADMIN_PASSWORD_HASH),
    hasTemporaryPassword: Boolean(process.env.SUPERADMIN_PASSWORD),
    hasSessionSecret: Boolean(sessionSecret()),
    ttlMinutes: ttlMinutes(),
    maxLoginAttempts: maxLoginAttempts(),
    lockoutMinutes: lockoutMinutes()
  };
}

export function isSuperadminConfigured() {
  const status = superadminConfigStatus();
  return status.hasUsername && status.hasSessionSecret && (status.hasPasswordHash || status.hasTemporaryPassword);
}

function verifyCredentials(username: string, password: string) {
  const expectedUsername = process.env.SUPERADMIN_USERNAME || "";
  if (!expectedUsername || !safeCompare(username, expectedUsername)) return false;
  const hash = process.env.SUPERADMIN_PASSWORD_HASH;
  if (hash) return verifyPasswordHash(password, hash);
  const temporaryPassword = process.env.SUPERADMIN_PASSWORD || "";
  return Boolean(temporaryPassword) && safeCompare(password, temporaryPassword);
}

export async function attemptSuperadminLogin(request: Request, username: string, password: string) {
  const ipAddress = requestIp(request);
  const rate = await checkPersistentRateLimit({
    action: "superadmin_login",
    identifier: ipAddress,
    limit: maxLoginAttempts(),
    windowSeconds: lockoutMinutes() * 60,
    blockSeconds: lockoutMinutes() * 60
  });

  if (!rate.allowed) {
    await logger.security({
      traceId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      route: new URL(request.url).pathname,
      method: request.method,
      ipAddress,
      userAgent: request.headers.get("user-agent") ?? "unknown",
      module: "security",
      action: "superadmin_login_rate_limited",
      message: "Superadmin login was rate limited.",
      status: "failed",
      metadata: { usernameProvided: Boolean(username), resetAt: rate.resetAt }
    });
    return { ok: false as const, status: 429, error: "Too many attempts. Try again later." };
  }

  if (!isSuperadminConfigured()) return { ok: false as const, status: 503, error: "Superadmin is not configured." };
  const ok = verifyCredentials(username, password);
  await logger[ok ? "audit" : "security"]({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: new URL(request.url).pathname,
    method: request.method,
    ipAddress,
    userAgent: request.headers.get("user-agent") ?? "unknown",
    module: "security",
    action: ok ? "superadmin_login_success" : "superadmin_login_failed",
    message: ok ? "Superadmin login succeeded." : "Superadmin login failed.",
    status: ok ? "completed" : "failed",
    metadata: { username }
  });
  return ok ? { ok: true as const } : { ok: false as const, status: 401, error: "Invalid credentials." };
}

export function createSuperadminSessionValue() {
  const now = Math.floor(Date.now() / 1000);
  const payload: SuperadminSessionPayload = {
    sub: process.env.SUPERADMIN_USERNAME || "superadmin",
    iat: now,
    exp: now + ttlMinutes() * 60,
    nonce: randomBytes(16).toString("hex")
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function setSuperadminCookie(response: NextResponse, value: string) {
  response.cookies.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: ttlMinutes() * 60
  });
}

export function clearSuperadminCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0
  });
}

function cookieValue(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  return cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) ?? "";
}

export function verifySuperadminSession(request: Request) {
  if (!sessionSecret()) return null;
  const value = cookieValue(request);
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature || !safeCompare(sign(encoded), signature)) return null;
  try {
    const payload = JSON.parse(fromBase64url(encoded)) as SuperadminSessionPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function requireSuperadmin(request: Request) {
  const session = verifySuperadminSession(request);
  if (!session) {
    await logger.security({
      traceId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      route: new URL(request.url).pathname,
      method: request.method,
      ipAddress: requestIp(request),
      userAgent: request.headers.get("user-agent") ?? "unknown",
      module: "security",
      action: "superadmin_permission_denied",
      message: "Superadmin session is missing or invalid.",
      status: "failed"
    });
    return NextResponse.json({ error: "Superadmin session required." }, { status: 401 });
  }

  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ error: "Service role client is not configured." }, { status: 503 });
  return { session, service };
}
