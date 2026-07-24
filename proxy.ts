import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { REQUEST_HEADER, TRACE_HEADER, createRequestId, createTraceId } from "@/lib/logger/context";
import { logger } from "@/lib/logger/logger";

const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password"];
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/clients",
  "/opportunities",
  "/stock-needs",
  "/executive-search",
  "/mpn-comparator",
  "/upload",
  "/records",
  "/analytics",
  "/categories",
  "/chat",
  "/profile",
  "/admin"
];
const MANAGER_ADMIN_PREFIXES = ["/admin/clients", "/admin/opportunities", "/admin/stock-needs"];

function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && getSupabasePublishableKey()
  );
}

function isDemoModeAllowed() {
  return process.env.NODE_ENV !== "production" && !isSupabaseConfigured();
}

function getSupabasePublishableKey() {
  const candidates = [
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ];

  return candidates.find(isValidSupabasePublicKey)?.trim() ?? "";
}

function isValidSupabasePublicKey(value: string | undefined) {
  const key = value?.trim();
  return Boolean(key && (key.startsWith("sb_publishable_") || key.startsWith("eyJ")));
}

function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function managerCanAccessAdminPath(pathname: string) {
  return MANAGER_ADMIN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function logUnauthorizedAdminAttempt(request: NextRequest, profileId: string | null) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;

  const service = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false }
    }
  );

  await service.from("security_events").insert({
    actor_id: profileId,
    event_type: "unauthorized_admin_access_attempt",
    severity: "high",
    route: request.nextUrl.pathname,
    ip_address: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: request.headers.get("user-agent"),
    metadata: { source: "middleware" }
  });
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const startedAt = performance.now();
  const traceId = request.headers.get(TRACE_HEADER) || createTraceId();
  const requestId = request.headers.get(REQUEST_HEADER) || createRequestId();
  const baseLog = {
    traceId,
    requestId,
    route: pathname,
    method: request.method
  };

  await logger.info({
    ...baseLog,
    module: "api",
    action: "request_started",
    message: "Request started",
    status: "started",
    metadata: {
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent")
    }
  });

  if (pathname === "/dashboard") {
    const clientsUrl = request.nextUrl.clone();
    clientsUrl.pathname = "/clients";
    for (const key of Array.from(clientsUrl.searchParams.keys())) {
      if (!["error", "lang", "locale"].includes(key)) clientsUrl.searchParams.delete(key);
    }
    return NextResponse.redirect(clientsUrl);
  }

  if (!isProtectedPath(pathname) && !isPublicPath(pathname)) {
    const response = NextResponse.next();
    response.headers.set(TRACE_HEADER, traceId);
    response.headers.set(REQUEST_HEADER, requestId);
    return response;
  }

  if (isDemoModeAllowed()) {
    const response = NextResponse.next();
    response.headers.set(TRACE_HEADER, traceId);
    response.headers.set(REQUEST_HEADER, requestId);
    await logger.info({
      ...baseLog,
      module: "api",
      action: "request_completed",
      message: "Request completed in demo mode",
      status: "completed",
      durationMs: Math.round(performance.now() - startedAt),
      metadata: { statusCode: 200 }
    });
    return response;
  }

  if (!isSupabaseConfigured()) {
    if (isPublicPath(pathname)) return NextResponse.next();
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("error", "supabase_not_configured");
    await logger.error({
      ...baseLog,
      module: "auth",
      action: "request_failed",
      message: "Supabase is not configured for protected route.",
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt)
    });
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next({
    request
  });
  response.headers.set(TRACE_HEADER, traceId);
  response.headers.set(REQUEST_HEADER, requestId);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabasePublishableKey(),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        }
      }
    }
  );

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user && !isPublicPath(pathname)) {
    await logger.warn({
      ...baseLog,
      module: "auth",
      action: "unauthorized_request",
      message: "Unauthenticated request blocked.",
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt)
    });
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (!user) return response;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, is_active")
    .eq("id", user.id)
    .single();

  if (!profile?.is_active) {
    await logger.security({
      ...baseLog,
      userId: user.id,
      module: "auth",
      action: "inactive_user_blocked",
      message: "Inactive user blocked by proxy.",
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt)
    });
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("error", "inactive_user");
    return NextResponse.redirect(loginUrl);
  }

  if (
    pathname.startsWith("/admin") &&
    profile.role !== "admin" &&
    !(profile.role === "manager" && managerCanAccessAdminPath(pathname))
  ) {
    await logger.security({
      ...baseLog,
      userId: profile.id,
      userRole: profile.role,
      module: "auth",
      action: "employee_admin_access_blocked",
      message: "Non-admin attempted to access admin route.",
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt)
    });
    await logUnauthorizedAdminAttempt(request, profile.id);
    const clientsUrl = request.nextUrl.clone();
    clientsUrl.pathname = "/clients";
    clientsUrl.searchParams.set("error", "admin_forbidden");
    return NextResponse.redirect(clientsUrl);
  }

  if (pathname === "/login") {
    const clientsUrl = request.nextUrl.clone();
    clientsUrl.pathname = "/clients";
    clientsUrl.search = "";
    return NextResponse.redirect(clientsUrl);
  }

  if (pathname.startsWith("/admin")) {
    await logger.audit({
      ...baseLog,
      userId: profile.id,
      userRole: profile.role,
      module: "auth",
      action: "admin_route_access_attempt",
      message: "Admin route access granted.",
      status: "success",
      durationMs: Math.round(performance.now() - startedAt)
    });
  }

  await logger.info({
    ...baseLog,
    userId: profile.id,
    userRole: profile.role,
    module: "api",
    action: "request_completed",
    message: "Request completed",
    status: "completed",
    durationMs: Math.round(performance.now() - startedAt),
    metadata: { statusCode: 200 }
  });

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"]
};
