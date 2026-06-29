import { NextResponse } from "next/server";
import { z } from "zod";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logPublicSecurityEvent } from "@/lib/auth/public-security";
import { logger } from "@/lib/logger/logger";
import { requestIp, rateLimitResponse } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { isMissingSchemaError, missingMigrationMessage, schemaErrorMetadata } from "@/lib/supabase/schema-errors";
import {
  generatePasswordResetToken,
  hashPasswordResetCode,
  hashPasswordResetToken,
  normalizeResetEmail,
  secureHashEquals
} from "@/lib/security/password-reset";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const verifySchema = z.object({
  email: z.string().trim().email().max(254),
  code: z.string().trim().regex(/^[A-Za-z]{4}[0-9]{4}$/)
});
const INVALID_MESSAGE = "El codigo es invalido, vencio o alcanzo el limite de intentos.";
const REQUIRED_MIGRATION = "20260629000000_enterprise_mvp.sql";

export async function POST(request: Request) {
  const context = getLoggerContextFromRequest(request);
  const route = "/api/auth/password-reset/verify";
  const ipAddress = requestIp(request);
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  await logger.info({
    ...context,
    route,
    module: "auth",
    action: "password_reset_verify_started",
    message: "Password reset code verification started.",
    status: "started",
    metadata: { ipAddress }
  });

  try {
    const body = await request.json().catch(() => null);
    const parsed = verifySchema.safeParse(body);
    if (!parsed.success) {
      await logger.warn({
        ...context,
        route,
        module: "auth",
        action: "password_reset_verify_validation_failed",
        message: "Password reset verification validation failed.",
        status: "failed",
        metadata: parsed.error.flatten()
      });
      return NextResponse.json({ error: INVALID_MESSAGE }, { status: 400 });
    }

    const email = normalizeResetEmail(parsed.data.email);
    const emailDomain = email.split("@")[1] ?? "unknown";
    const rate = await checkPersistentRateLimit({
      action: "password_reset_verify",
      identifier: `${ipAddress}:${email}`,
      limit: 10,
      windowSeconds: 15 * 60,
      blockSeconds: 15 * 60
    });
    if (!rate.allowed) {
      await logger.security({
        ...context,
        route,
        module: "security",
        action: "password_reset_verify_rate_limited",
        message: "Password reset verification rate limit was triggered.",
        status: "failed",
        metadata: { emailDomain, resetAt: rate.resetAt, persistent: rate.persistent }
      });
      return rateLimitResponse(rate.resetAt);
    }

    const service = createSupabaseServiceRoleClient();
    if (!service) {
      await logger.error({
        ...context,
        route,
        module: "auth",
        action: "password_reset_service_unconfigured",
        message: "Password reset service-role client is not configured.",
        status: "failed"
      });
      return NextResponse.json({ error: "El servicio de recuperacion no esta configurado." }, { status: 503 });
    }

    const resetResult = await service
      .from("password_reset_codes")
      .select("id, user_id, code_hash, expires_at, attempts, max_attempts, used_at")
      .ilike("email", email)
      .is("used_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (resetResult.error) {
      if (isMissingSchemaError(resetResult.error)) {
        await logger.error({
          ...context,
          route,
          module: "auth",
          action: "password_reset_schema_missing",
          message: "Password reset schema is missing.",
          status: "failed",
          metadata: schemaErrorMetadata(resetResult.error, REQUIRED_MIGRATION),
          error: resetResult.error
        });
        return NextResponse.json({ error: missingMigrationMessage("recuperacion de contrasena") }, { status: 503 });
      }
      throw resetResult.error;
    }

    const reset = resetResult.data;
    const expired = !reset || new Date(reset.expires_at).getTime() <= Date.now();
    const exhausted = !reset || reset.attempts >= reset.max_attempts;
    if (expired || exhausted) {
      await logger.warn({
        ...context,
        route,
        module: "auth",
        action: "password_reset_verify_invalid",
        message: "Password reset verification failed because the code is expired, absent or exhausted.",
        status: "failed",
        metadata: { emailDomain, expired, exhausted }
      });
      return NextResponse.json({ error: INVALID_MESSAGE }, { status: 400 });
    }

    const nextAttempts = reset.attempts + 1;
    const expectedHash = hashPasswordResetCode(parsed.data.code, email);
    const valid = secureHashEquals(reset.code_hash, expectedHash);
    if (!valid) {
      const attemptResult = await service.from("password_reset_codes").update({ attempts: nextAttempts }).eq("id", reset.id);
      if (attemptResult.error) {
        await logger.warn({
          ...context,
          route,
          module: "auth",
          action: "password_reset_attempt_update_failed",
          message: "Unable to update password reset attempts.",
          status: "failed",
          metadata: { emailDomain, resetId: reset.id },
          error: attemptResult.error
        });
      }
      if (nextAttempts >= reset.max_attempts) {
        await logPublicSecurityEvent({
          traceId: context.traceId,
          requestId: context.requestId,
          route,
          eventType: "password_reset_attempts_exhausted",
          severity: "high",
          ipAddress,
          userAgent,
          metadata: { resetId: reset.id }
        });
      }
      return NextResponse.json({ error: INVALID_MESSAGE, attemptsRemaining: Math.max(reset.max_attempts - nextAttempts, 0) }, { status: 400 });
    }

    const resetToken = generatePasswordResetToken();
    const updateResult = await service
      .from("password_reset_codes")
      .update({
        attempts: nextAttempts,
        verified_at: new Date().toISOString(),
        verification_token_hash: hashPasswordResetToken(resetToken, email)
      })
      .eq("id", reset.id);
    if (updateResult.error) throw updateResult.error;

    await logger.info({
      ...context,
      route,
      module: "auth",
      action: "password_reset_verify_completed",
      message: "Password reset code verification completed.",
      status: "completed",
      metadata: { emailDomain, resetId: reset.id }
    });

    return NextResponse.json({ verified: true, resetToken });
  } catch (error) {
    const missingSecret = error instanceof Error && error.message.includes("PASSWORD_RESET_SECRET");
    await logger.error({
      ...context,
      route,
      module: "auth",
      action: "password_reset_verify_failed",
      message: "Password reset verification failed.",
      status: "failed",
      error
    });
    return NextResponse.json(
      { error: missingSecret ? "El servicio de recuperacion no esta configurado." : "No se pudo verificar el codigo." },
      { status: missingSecret ? 503 : 500 }
    );
  }
}
