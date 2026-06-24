import { NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Profile, UserRole } from "@/lib/types";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logger } from "@/lib/logger/logger";
import { isDemoModeAllowed, isSupabaseConfigured } from "@/lib/security/env";
import { requestIp } from "@/lib/security/rateLimit";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export interface AuthContext {
  user: User | null;
  profile: Profile;
  supabase: SupabaseClient | null;
  isDemoMode: boolean;
  requestMeta: {
    ipAddress: string;
    userAgent: string;
    route: string;
    traceId: string;
    requestId: string;
  };
}

export const DEMO_PROFILE: Profile = {
  id: "00000000-0000-4000-8000-000000000001",
  full_name: "Demo Admin",
  email: "admin@quiksol.local",
  role: "admin",
  department: "Operations",
  region: "Global",
  is_active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString()
};

function forbidden(message = "Forbidden") {
  return NextResponse.json({ error: message }, { status: 403 });
}

function unauthorized(message = "Authentication required") {
  return NextResponse.json({ error: message }, { status: 401 });
}

function serviceUnavailable(message = "Supabase is not configured") {
  return NextResponse.json({ error: message }, { status: 503 });
}

export async function getAuthContext(request: Request): Promise<AuthContext | NextResponse> {
  const loggerContext = getLoggerContextFromRequest(request);
  const requestMeta = {
    ipAddress: requestIp(request),
    userAgent: request.headers.get("user-agent") ?? "unknown",
    route: new URL(request.url).pathname,
    traceId: loggerContext.traceId,
    requestId: loggerContext.requestId!
  };

  if (!isSupabaseConfigured()) {
    if (isDemoModeAllowed()) {
      await logger.warn({
        ...loggerContext,
        module: "auth",
        action: "demo_auth_context_used",
        message: "Supabase is not configured; using development demo auth context.",
        status: "completed"
      });
      return {
        user: null,
        profile: DEMO_PROFILE,
        supabase: null,
        isDemoMode: true,
        requestMeta
      };
    }
    await logger.error({
      ...loggerContext,
      module: "auth",
      action: "supabase_not_configured",
      message: "Supabase environment variables are missing.",
      status: "failed"
    });
    return serviceUnavailable();
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return serviceUnavailable();

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser();

  if (userError || !user) {
    await logger.warn({
      ...loggerContext,
      module: "auth",
      action: "session_missing",
      message: "Request is missing a valid Supabase session.",
      status: "failed",
      error: userError
    });
    return unauthorized();
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    await logger.security({
      ...loggerContext,
      userId: user.id,
      userEmail: user.email,
      module: "auth",
      action: "role_missing",
      message: "Authenticated user has no accessible profile.",
      status: "failed",
      error: profileError
    });
    return forbidden("Profile is missing or inaccessible.");
  }

  if (!profile.is_active) {
    await logger.security({
      ...loggerContext,
      userId: user.id,
      userEmail: profile.email,
      userRole: profile.role,
      module: "auth",
      action: "inactive_user_blocked",
      message: "Inactive user attempted to access the platform.",
      status: "failed"
    });
    return forbidden("Your user is inactive.");
  }

  await logger.debug({
    ...loggerContext,
    userId: user.id,
    userEmail: profile.email,
    userRole: profile.role,
    module: "auth",
    action: "role_loaded",
    message: "User role loaded.",
    status: "success"
  });

  return {
    user,
    profile: profile as Profile,
    supabase,
    isDemoMode: false,
    requestMeta
  };
}

export async function requireRole(
  request: Request,
  allowedRoles: UserRole[]
): Promise<AuthContext | NextResponse> {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  if (!allowedRoles.includes(context.profile.role)) {
    await logger.security({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "auth",
      action: "role_guard_failed",
      message: "Role guard denied access.",
      status: "failed",
      metadata: { allowedRoles, actualRole: context.profile.role }
    });
    await logSecurityEvent(context, "failed_permission_check", "high", {
      allowedRoles,
      actualRole: context.profile.role
    });
    return forbidden("You do not have permission to access this resource.");
  }

  return context;
}

export async function requireAdmin(request: Request) {
  return requireRole(request, ["admin"]);
}

export async function logAuditEvent(
  context: AuthContext,
  action: string,
  entityType?: string,
  entityId?: string | null,
  metadata?: Record<string, unknown>
) {
  await logger.audit({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "admin",
    action,
    message: `Audit event recorded: ${action}`,
    status: "completed",
    metadata: { entityType, entityId, ...metadata }
  });

  if (context.isDemoMode) return;

  const service = createSupabaseServiceRoleClient();
  if (!service) return;

  await service.from("audit_logs").insert({
    actor_id: context.profile.id,
    actor_email: context.profile.email,
    action,
    entity_type: entityType ?? null,
    entity_id: entityId ?? null,
    ip_address: context.requestMeta.ipAddress,
    user_agent: context.requestMeta.userAgent,
    metadata: metadata ?? null
  });
}

export async function logSecurityEvent(
  context: AuthContext,
  eventType: string,
  severity: "low" | "medium" | "high" | "critical",
  metadata?: Record<string, unknown>
) {
  await logger.security({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "security",
    action: eventType,
    message: `Security event recorded: ${eventType}`,
    status: "failed",
    metadata
  });

  if (context.isDemoMode) return;

  const service = createSupabaseServiceRoleClient();
  if (!service) return;

  await service.from("security_events").insert({
    actor_id: context.profile.id,
    actor_email: context.profile.email,
    trace_id: context.requestMeta.traceId,
    event_type: eventType,
    severity,
    route: context.requestMeta.route,
    ip_address: context.requestMeta.ipAddress,
    user_agent: context.requestMeta.userAgent,
    metadata: metadata ?? null
  });
}
