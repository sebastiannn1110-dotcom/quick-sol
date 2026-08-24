import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logger } from "@/lib/logger/logger";
import { sanitizeForLog } from "@/lib/logger/sanitize";
import { checkRateLimit, rateLimitResponse, requestIp } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F]/;
const safeLogText = (minimum: number, maximum: number) =>
  z.string().min(minimum).max(maximum).refine(
    (value) => !CONTROL_CHARACTER_RE.test(value),
    "Control characters are not allowed."
  );

const clientLogSchema = z.object({
  traceId: z.string().uuid().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  action: safeLogText(1, 120),
  message: safeLogText(1, 500),
  route: safeLogText(0, 300).optional(),
  metadata: z.record(safeLogText(1, 40), z.union([safeLogText(0, 160), z.number().finite(), z.boolean(), z.null()])).optional()
}).strict().superRefine((value, context) => {
  if (value.metadata && Object.keys(value.metadata).length > 12) {
    context.addIssue({ code: "custom", message: "Too many metadata fields.", path: ["metadata"] });
  }
});

const PUBLIC_LOG_ROUTES = new Set(["/forgot-password", "/reset-password", "/login"]);
const PUBLIC_LOG_ACTIONS = new Set(["page_view", "react_error_boundary_triggered"]);
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };
const MAX_BODY_BYTES = 4096;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

function containsForbiddenPublicContent(value: unknown) {
  const payload = value && typeof value === "object" ? value as { message?: unknown; metadata?: unknown } : {};
  const serialized = JSON.stringify({ message: payload.message, metadata: payload.metadata });
  return /(?:bearer\s+|eyJ[a-zA-Z0-9_-]{8,}\.|password|access[_-]?token|refresh[_-]?token|service[_-]?role|raw[_-]?data|normalized[_-]?data|storage[_-]?path|[^\s@]+@[^\s@]+\.[^\s@]+)/i.test(serialized);
}

function genericRateLimitResponse(resetAt: number) {
  return NextResponse.json(
    { error: "Too many requests. Please wait and try again." },
    {
      status: 429,
      headers: { ...PRIVATE_HEADERS, "Retry-After": `${Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))}` }
    }
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: PRIVATE_HEADERS });
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415, headers: PRIVATE_HEADERS });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Log payload is too large." }, { status: 413, headers: PRIVATE_HEADERS });
  }
  const bodyText = await request.text().catch(() => "");
  if (Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Log payload is too large." }, { status: 413, headers: PRIVATE_HEADERS });
  }
  const rawPayload = (() => {
    try { return JSON.parse(bodyText) as unknown; } catch { return null; }
  })();
  const parsed = clientLogSchema.safeParse(rawPayload);
  const rawRequestedRoute = rawPayload && typeof rawPayload === "object" && "route" in rawPayload
    ? (rawPayload as { route?: unknown }).route
    : undefined;
  const requestedRoute = parsed.success
    ? parsed.data.route
    : typeof rawRequestedRoute === "string" ? rawRequestedRoute : undefined;
  if (requestedRoute && PUBLIC_LOG_ROUTES.has(requestedRoute)) {
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid public log payload." }, { status: 422, headers: PRIVATE_HEADERS });
    }
    if (!PUBLIC_LOG_ACTIONS.has(parsed.data.action) || parsed.data.level === "debug" || containsForbiddenPublicContent(parsed.data)) {
      return NextResponse.json({ error: "Invalid public log payload." }, { status: 422, headers: PRIVATE_HEADERS });
    }
    const rate = await checkPersistentRateLimit({
      action: "public_client_log",
      identifier: requestIp(request),
      limit: 30,
      windowSeconds: 60,
      blockSeconds: 120,
      alwaysEnforce: true
    });
    if (!rate.allowed) return genericRateLimitResponse(rate.resetAt);
    if (process.env.NODE_ENV === "production" && !rate.persistent) {
      return NextResponse.json(
        { error: "Public logging is temporarily unavailable." },
        { status: 503, headers: PRIVATE_HEADERS }
      );
    }
    const baseContext = getLoggerContextFromRequest(request);
    const metadata = sanitizeForLog({
      ...((parsed.data.metadata ?? {}) as Record<string, unknown>),
      publicLog: true
    }) as Record<string, unknown>;
    await logger[parsed.data.level]({
      ...baseContext,
      route: requestedRoute,
      module: "frontend",
      action: parsed.data.action,
      message: parsed.data.message,
      status: "completed",
      metadata
    });
    return new NextResponse(null, { status: 204, headers: PRIVATE_HEADERS });
  }

  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const rate = checkRateLimit({
    key: `client-log:${context.profile.id}`,
    limit: 120,
    windowMs: 60 * 1000
  });

  const baseContext = getLoggerContextFromRequest(request);
  if (!rate.allowed) {
    await logger.security({
      ...baseContext,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      module: "security",
      action: "rate_limit_triggered",
      message: "Client log rate limit was triggered.",
      status: "failed",
      metadata: { resetAt: rate.resetAt }
    });
    const response = rateLimitResponse(rate.resetAt);
    response.headers.set("Cache-Control", PRIVATE_HEADERS["Cache-Control"]);
    return response;
  }
  if (!parsed.success) {
    await logger.warn({
      ...baseContext,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      module: "frontend",
      action: "client_log_rejected",
      message: "Client log payload failed validation.",
      status: "failed",
      metadata: parsed.error.flatten()
    });
    return NextResponse.json({ error: "Invalid log payload." }, { status: 400, headers: PRIVATE_HEADERS });
  }

  const traceId = parsed.data.traceId ?? baseContext.traceId;
  await logger[parsed.data.level]({
    ...baseContext,
    traceId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: parsed.data.route ?? baseContext.route,
    module: "frontend",
    action: parsed.data.action,
    message: parsed.data.message,
    status: "completed",
    metadata: sanitizeForLog(parsed.data.metadata ?? {}) as Record<string, unknown>
  });

  if (!context.isDemoMode) {
    await context.supabase!.from("client_logs").insert({
      trace_id: traceId,
      level: parsed.data.level,
      action: parsed.data.action,
      message: parsed.data.message,
      user_id: context.profile.id,
      route: parsed.data.route ?? baseContext.route,
      ip_address: context.requestMeta.ipAddress,
      user_agent: context.requestMeta.userAgent,
      metadata: sanitizeForLog(parsed.data.metadata ?? {})
    });
  }

  return NextResponse.json({ ok: true }, { headers: PRIVATE_HEADERS });
}
