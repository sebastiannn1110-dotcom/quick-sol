import { createHash, createHmac, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/auth/context";
import { requireRole } from "@/lib/auth/context";
import { getSupabasePublishableKey } from "@/lib/security/env";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_DEV_ROLE } from "@/lib/auth/roles";

export { SUPER_ADMIN_DEV_ROLE };
export const CRITICAL_CACHE_CONTROL = "no-store, max-age=0";

export type SuperadminContext = AuthContext & {
  user: NonNullable<AuthContext["user"]>;
  supabase: NonNullable<AuthContext["supabase"]>;
  service: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;
};

export function protectSuperadminResponse(response: NextResponse) {
  response.headers.set("Cache-Control", CRITICAL_CACHE_CONTROL);
  response.headers.set("Pragma", "no-cache");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return response;
}

export function superadminJson(body: unknown, init?: ResponseInit) {
  return protectSuperadminResponse(NextResponse.json(body, init));
}

export function assertCriticalSameOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin) return superadminJson({ error: "CSRF_ORIGIN_REQUIRED" }, { status: 403 });

  let supplied: URL;
  try {
    supplied = new URL(origin);
  } catch {
    return superadminJson({ error: "CSRF_ORIGIN_INVALID" }, { status: 403 });
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const expectedHost = forwardedHost || requestUrl.host;
  const expectedProtocol = forwardedProto ? `${forwardedProto}:` : requestUrl.protocol;
  if (supplied.host !== expectedHost || supplied.protocol !== expectedProtocol) {
    return superadminJson({ error: "CSRF_ORIGIN_MISMATCH" }, { status: 403 });
  }
  return null;
}

export function superadminConfigStatus() {
  return {
    route: "/admindev",
    authorization: "supabase_auth_profile_role",
    requiredRole: SUPER_ADMIN_DEV_ROLE,
    bootstrapPasswordConfigured: Boolean(process.env.QUIKSOL_ADMIN_PROVISIONING_PASSWORD),
    auditSecretConfigured: Boolean(process.env.DATABASE_SAFETY_AUDIT_SECRET),
    backupDatabaseConfigured: Boolean(process.env.QUIKSOL_BACKUP_DATABASE_URL),
    mfaCapable: true,
    mfaRequired: false
  };
}

export async function requireSuperadmin(request: Request): Promise<SuperadminContext | NextResponse> {
  const context = await requireRole(request, [SUPER_ADMIN_DEV_ROLE]);
  if (context instanceof NextResponse) return protectSuperadminResponse(context);
  if (context.isDemoMode || !context.user || !context.supabase) {
    return superadminJson({ error: "SUPER_ADMIN_DEV_SESSION_REQUIRED" }, { status: 401 });
  }

  const service = createSupabaseServiceRoleClient();
  if (!service) return superadminJson({ error: "SERVICE_ROLE_NOT_CONFIGURED" }, { status: 503 });
  return { ...context, user: context.user, supabase: context.supabase, service };
}

export async function reauthenticateSuperAdmin(context: SuperadminContext, password: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabasePublishableKey();
  const email = context.user.email;
  if (!url || !key || !email || !password) return false;

  const verifier = createClient(url, key, serverSupabaseClientOptions());
  const { data, error } = await verifier.auth.signInWithPassword({ email, password });
  const verified = !error && data.user?.id === context.user.id;
  await verifier.auth.signOut({ scope: "local" }).catch(() => undefined);
  return verified;
}

export async function superadminSessionBinding(context: SuperadminContext) {
  const { data, error } = await context.supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (error || !accessToken) return null;
  return createHash("sha256")
    .update(`quiksol-database-safety-v1:${context.user.id}:${accessToken}`)
    .digest("hex");
}

export function superadminIpHash(context: SuperadminContext) {
  const secret = process.env.DATABASE_SAFETY_AUDIT_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(context.requestMeta.ipAddress || "unknown")
    .digest("hex");
}

export function challengeHash(challenge: string) {
  return createHash("sha256").update(challenge).digest("hex");
}

export function createDestructionChallenge() {
  return randomBytes(32).toString("base64url");
}
