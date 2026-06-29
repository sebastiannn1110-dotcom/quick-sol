import { NextResponse } from "next/server";
import { z } from "zod";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logger } from "@/lib/logger/logger";
import { requestIp, rateLimitResponse } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { isMissingSchemaError, missingMigrationMessage, schemaErrorMetadata } from "@/lib/supabase/schema-errors";
import {
  hashPasswordResetToken,
  newPasswordSchema,
  normalizeResetEmail,
  secureHashEquals
} from "@/lib/security/password-reset";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const confirmSchema = z.object({
  email: z.string().trim().email().max(254),
  resetToken: z.string().trim().min(32).max(200),
  password: newPasswordSchema
});
const INVALID_MESSAGE = "La autorizacion de recuperacion es invalida o vencio.";
const REQUIRED_MIGRATION = "20260629000000_enterprise_mvp.sql";

export async function POST(request: Request) {
  const context = getLoggerContextFromRequest(request);
  const route = "/api/auth/password-reset/confirm";
  const ipAddress = requestIp(request);
  await logger.info({
    ...context,
    route,
    module: "auth",
    action: "password_reset_confirm_started",
    message: "Password reset confirmation started.",
    status: "started",
    metadata: { ipAddress }
  });

  try {
    const body = await request.json().catch(() => null);
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) {
      await logger.warn({
        ...context,
        route,
        module: "auth",
        action: "password_reset_confirm_validation_failed",
        message: "Password reset confirmation validation failed.",
        status: "failed",
        metadata: parsed.error.flatten()
      });
      return NextResponse.json({ error: "La nueva contrasena no cumple los requisitos.", issues: parsed.error.flatten() }, { status: 400 });
    }

    const email = normalizeResetEmail(parsed.data.email);
    const emailDomain = email.split("@")[1] ?? "unknown";
    const rate = await checkPersistentRateLimit({
      action: "password_reset_confirm",
      identifier: `${ipAddress}:${email}`,
      limit: 5,
      windowSeconds: 15 * 60,
      blockSeconds: 15 * 60
    });
    if (!rate.allowed) {
      await logger.security({
        ...context,
        route,
        module: "security",
        action: "password_reset_confirm_rate_limited",
        message: "Password reset confirmation rate limit was triggered.",
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
      .select("id, user_id, verification_token_hash, verified_at, expires_at, used_at")
      .ilike("email", email)
      .not("verified_at", "is", null)
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
    const tokenHash = hashPasswordResetToken(parsed.data.resetToken, email);
    const valid = Boolean(
      reset?.user_id &&
      reset.verified_at &&
      new Date(reset.expires_at).getTime() > Date.now() &&
      secureHashEquals(reset.verification_token_hash, tokenHash)
    );
    if (!valid || !reset?.user_id) {
      await logger.warn({
        ...context,
        route,
        module: "auth",
        action: "password_reset_confirm_invalid",
        message: "Password reset confirmation token is invalid or expired.",
        status: "failed",
        metadata: { emailDomain }
      });
      return NextResponse.json({ error: INVALID_MESSAGE }, { status: 400 });
    }

    const { error: updateError } = await service.auth.admin.updateUserById(reset.user_id, {
      password: parsed.data.password
    });
    if (updateError) {
      await logger.error({
        ...context,
        route,
        module: "auth",
        action: "password_reset_auth_update_failed",
        message: "Unable to update Supabase auth password.",
        status: "failed",
        metadata: { emailDomain, resetId: reset.id },
        error: updateError
      });
      return NextResponse.json({ error: "No se pudo actualizar la contrasena. Intenta de nuevo." }, { status: 502 });
    }

    const completedAt = new Date().toISOString();
    const [markUsedResult, auditResult] = await Promise.all([
      service.from("password_reset_codes").update({ used_at: completedAt, verification_token_hash: null }).eq("id", reset.id),
      service.from("audit_logs").insert({
        actor_id: reset.user_id,
        actor_email: email,
        action: "password_reset_completed",
        entity_type: "profile",
        entity_id: reset.user_id,
        ip_address: ipAddress,
        user_agent: request.headers.get("user-agent"),
        metadata: { resetId: reset.id }
      })
    ]);
    if (markUsedResult.error || auditResult.error) {
      await logger.warn({
        ...context,
        route,
        module: "auth",
        action: "password_reset_post_update_log_failed",
        message: "Password reset completed but post-update logging failed.",
        status: "failed",
        metadata: { emailDomain, resetId: reset.id },
        error: markUsedResult.error ?? auditResult.error
      });
    }

    await logger.info({
      ...context,
      route,
      module: "auth",
      action: "password_reset_confirm_completed",
      message: "Password reset confirmation completed.",
      status: "completed",
      metadata: { emailDomain, resetId: reset.id }
    });

    return NextResponse.json({ success: true, message: "Tu contrasena fue actualizada." });
  } catch (error) {
    const missingSecret = error instanceof Error && error.message.includes("PASSWORD_RESET_SECRET");
    await logger.error({
      ...context,
      route,
      module: "auth",
      action: "password_reset_confirm_failed",
      message: "Password reset confirmation failed.",
      status: "failed",
      error
    });
    return NextResponse.json(
      { error: missingSecret ? "El servicio de recuperacion no esta configurado." : "No se pudo cambiar la contrasena." },
      { status: missingSecret ? 503 : 500 }
    );
  }
}
