import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import type { Profile, UserRole } from "@/lib/types";
import { commerceError } from "@/lib/commerce/http";
import { commerceScopes, sessionRole } from "@/lib/commerce/contracts";
import { getSupabasePublishableKey, isSupabaseConfigured } from "@/lib/security/env";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

const PROFILE_SELECT = "id,full_name,email,role,department,region,is_active,created_at,updated_at";

export type CommerceAuthContext = {
  accessToken: string;
  user: User;
  profile: Profile;
  supabase: SupabaseClient;
};

export function createCommerceSupabaseClient(accessToken?: string) {
  if (!isSupabaseConfigured()) return null;
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabasePublishableKey(),
    {
      ...serverSupabaseClientOptions(),
      ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {})
    }
  );
}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

export async function authenticateCommerceToken(accessToken: string): Promise<CommerceAuthContext | NextResponse> {
  const supabase = createCommerceSupabaseClient(accessToken);
  if (!supabase) {
    return commerceError(503, "DATABASE_NOT_CONFIGURED", "Commerce authentication is not configured.");
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return commerceError(401, "SESSION_EXPIRED", "The employee session is missing or expired.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select(PROFILE_SELECT)
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError || !profile) {
    return commerceError(403, "FORBIDDEN", "The employee profile is not available.");
  }
  if (!profile.is_active) {
    return commerceError(403, "PROFILE_INACTIVE", "The employee profile is inactive.");
  }
  if (!["employee", "manager", "admin", "super_admin_dev"].includes(String(profile.role))) {
    return commerceError(403, "FORBIDDEN", "The employee role cannot access Commerce.");
  }

  return {
    accessToken,
    user: userData.user,
    profile: profile as Profile,
    supabase
  };
}

export async function requireCommerceAuth(request: Request) {
  const token = bearerToken(request);
  if (!token) return commerceError(401, "AUTHENTICATION_REQUIRED", "A valid employee Bearer token is required.");
  return authenticateCommerceToken(token);
}

export function commerceSessionPayload(
  context: Pick<CommerceAuthContext, "user" | "profile">,
  expiresAt?: string | null
) {
  const technicalRole = context.profile.role as UserRole;
  return {
    userId: context.profile.id,
    email: context.profile.email,
    fullName: context.profile.full_name,
    role: sessionRole(technicalRole),
    technicalRole,
    scopes: commerceScopes(technicalRole),
    expiresAt: expiresAt ?? new Date((context.user as User & { exp?: number }).exp
      ? Number((context.user as User & { exp?: number }).exp) * 1000
      : Date.now() + 60 * 60 * 1000).toISOString()
  };
}

export async function revokeCommerceSession(accessToken: string) {
  const service = createSupabaseServiceRoleClient();
  if (!service) return { error: new Error("Commerce logout is not configured.") };
  return service.auth.admin.signOut(accessToken, "local");
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJson(entry)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(normalizeJson(value));
}

export function commerceRequestFingerprint(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createCommerceShareToken() {
  return randomBytes(32).toString("base64url");
}

export function hashCommerceShareToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function signCommerceIntake(rawBody: string, timestamp: string, secret: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyCommerceIntakeSignature(
  rawBody: string,
  headers: Headers,
  options: { now?: number; maxSkewSeconds?: number; secret?: string } = {}
) {
  const secret = options.secret ?? process.env.COMMERCE_INTAKE_HMAC_SECRET ?? "";
  if (secret.length < 32) return { ok: false as const, reason: "unconfigured" as const };
  const timestamp = headers.get("x-quiksol-timestamp")?.trim() ?? "";
  const supplied = (headers.get("x-quiksol-signature")?.trim() ?? "").replace(/^sha256=/i, "");
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const maxSkew = options.maxSkewSeconds ?? 300;
  if (!Number.isInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > maxSkew) {
    return { ok: false as const, reason: "timestamp" as const };
  }
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return { ok: false as const, reason: "signature" as const };
  const expected = signCommerceIntake(rawBody, timestamp, secret);
  const valid = timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
  return valid
    ? { ok: true as const }
    : { ok: false as const, reason: "signature" as const };
}
