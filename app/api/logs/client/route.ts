import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logger } from "@/lib/logger/logger";
import { sanitizeForLog } from "@/lib/logger/sanitize";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const clientLogSchema = z.object({
  traceId: z.string().uuid().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  action: z.string().min(1).max(120),
  message: z.string().min(1).max(500),
  route: z.string().max(300).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const PUBLIC_LOG_ROUTES = new Set(["/forgot-password", "/reset-password", "/login"]);

export async function POST(request: Request) {
  const rawPayload = await request.json().catch(() => null);
  const parsed = clientLogSchema.safeParse(rawPayload);
  const requestedRoute = parsed.success ? parsed.data.route : undefined;
  if (parsed.success && requestedRoute && PUBLIC_LOG_ROUTES.has(requestedRoute)) {
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
    return new NextResponse(null, { status: 204 });
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
    return rateLimitResponse(rate.resetAt);
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
    return NextResponse.json({ error: "Invalid log payload." }, { status: 400 });
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
    metadata: parsed.data.metadata
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

  return NextResponse.json({ ok: true });
}
