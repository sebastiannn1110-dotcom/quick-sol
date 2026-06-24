import { NextResponse } from "next/server";
import { z } from "zod";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logger } from "@/lib/logger/logger";
import { maskEmail, sanitizeForLog } from "@/lib/logger/sanitize";
import { checkRateLimit, rateLimitResponse, requestIp } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const authLogSchema = z.object({
  action: z.enum(["login_success", "login_failed", "logout", "password_reset_requested"]),
  route: z.string().max(300).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export async function POST(request: Request) {
  const ipAddress = requestIp(request);
  const loggerContext = getLoggerContextFromRequest(request);
  const rate = checkRateLimit({
    key: `auth-log:${ipAddress}`,
    limit: 40,
    windowMs: 60 * 1000
  });
  if (!rate.allowed) {
    await logger.security({
      ...loggerContext,
      module: "security",
      action: "rate_limit_triggered",
      message: "Auth log rate limit was triggered.",
      status: "failed",
      metadata: { ipAddress, resetAt: rate.resetAt }
    });
    return rateLimitResponse(rate.resetAt);
  }
  const parsed = authLogSchema.safeParse(await request.json());
  if (!parsed.success) {
    await logger.warn({
      ...loggerContext,
      module: "auth",
      action: "auth_log_rejected",
      message: "Auth log payload failed validation.",
      status: "failed",
      metadata: parsed.error.flatten()
    });
    return NextResponse.json({ error: "Invalid auth log payload." }, { status: 400 });
  }

  const email = String(parsed.data.metadata?.email ?? "");
  const metadata = sanitizeForLog({
    ...parsed.data.metadata,
    email: email ? maskEmail(email) : undefined,
    ipAddress,
    userAgent: request.headers.get("user-agent") ?? "unknown"
  }) as Record<string, unknown>;
  const isFailure = parsed.data.action === "login_failed";
  const log = isFailure ? logger.warn : logger.audit;

  await log({
    ...loggerContext,
    route: parsed.data.route ?? loggerContext.route,
    method: "POST",
    module: "auth",
    action: parsed.data.action,
    message: `Auth event recorded: ${parsed.data.action}`,
    status: isFailure ? "failed" : "completed",
    metadata
  });

  return NextResponse.json({ ok: true });
}
