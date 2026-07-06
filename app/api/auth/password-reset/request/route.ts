import { NextResponse } from "next/server";
import { z } from "zod";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logger } from "@/lib/logger/logger";
import { getEmailProviderDiagnostics, sendEmail } from "@/lib/email/email-service";
import { requestIp, rateLimitResponse } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { isMissingSchemaError, missingMigrationMessage, schemaErrorMetadata } from "@/lib/supabase/schema-errors";
import {
  generatePasswordResetCode,
  hashPasswordResetCode,
  normalizeResetEmail,
  passwordResetCooldownSeconds,
  passwordResetExpiresAt,
  passwordResetMaxAttempts
} from "@/lib/security/password-reset";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({ email: z.string().trim().email().max(254) });
const GENERIC_MESSAGE = "Si el correo esta registrado, enviaremos un codigo de recuperacion.";
const REQUIRED_MIGRATION = "20260629000000_enterprise_mvp.sql";

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!name || !domain) return "invalid-email";
  return `${name.slice(0, 2)}***@${domain}`;
}

function resetConsoleLog(level: "info" | "warn" | "error", action: string, metadata: Record<string, unknown>) {
  console[level](action, metadata);
}

function resetEmailHtml(code: string, expiresAt: Date) {
  return `
    <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.6;max-width:560px">
      <h2 style="margin-bottom:8px">Recuperacion de contrasena de Quiksol</h2>
      <p>Usa este codigo para continuar:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px;background:#f1f5f9;padding:14px 18px;display:inline-block">${code}</p>
      <p>El codigo vence a las ${expiresAt.toISOString()} y solo puede utilizarse una vez.</p>
      <p><strong>No compartas este codigo.</strong> El equipo de Quiksol nunca te lo pedira.</p>
      <p style="font-size:12px;color:#64748b">Si no solicitaste este cambio, ignora este correo y avisa a tu administrador.</p>
    </div>
  `;
}

export async function POST(request: Request) {
  const loggerContext = getLoggerContextFromRequest(request);
  const route = "/api/auth/password-reset/request";
  const ipAddress = requestIp(request);
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  resetConsoleLog("info", "password_reset_request_started", {
    traceId: loggerContext.traceId,
    route,
    ipAddress
  });
  await logger.info({
    ...loggerContext,
    route,
    module: "auth",
    action: "password_reset_request_started",
    message: "Password reset request started.",
    status: "started",
    metadata: { ipAddress }
  });

  try {
    const body = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      resetConsoleLog("warn", "password_reset_request_validation_failed", {
        traceId: loggerContext.traceId,
        issues: parsed.error.flatten()
      });
      await logger.warn({
        ...loggerContext,
        route,
        module: "auth",
        action: "password_reset_request_validation_failed",
        message: "Password reset request validation failed.",
        status: "failed",
        metadata: parsed.error.flatten()
      });
      return NextResponse.json({ error: "Escribe un correo valido." }, { status: 400 });
    }

    const email = normalizeResetEmail(parsed.data.email);
    const emailDomain = email.split("@")[1] ?? "unknown";
    resetConsoleLog("info", "password_reset_email_normalized", {
      traceId: loggerContext.traceId,
      email: maskEmail(email),
      emailDomain
    });
    const [ipRate, emailRate] = await Promise.all([
      checkPersistentRateLimit({ action: "password_reset_request_ip", identifier: ipAddress, limit: 8, windowSeconds: 15 * 60, blockSeconds: 15 * 60 }),
      checkPersistentRateLimit({ action: "password_reset_request_email", identifier: email, limit: 4, windowSeconds: 15 * 60, blockSeconds: 15 * 60 })
    ]);
    if (!ipRate.allowed) {
      resetConsoleLog("warn", "password_reset_ip_rate_limited", {
        traceId: loggerContext.traceId,
        resetAt: ipRate.resetAt
      });
      await logger.security({
        ...loggerContext,
        route,
        module: "security",
        action: "password_reset_ip_rate_limited",
        message: "Password reset request IP rate limit was triggered.",
        status: "failed",
        metadata: { resetAt: ipRate.resetAt, persistent: ipRate.persistent }
      });
      return rateLimitResponse(ipRate.resetAt);
    }
    if (!emailRate.allowed) {
      resetConsoleLog("warn", "password_reset_email_rate_limited", {
        traceId: loggerContext.traceId,
        email: maskEmail(email),
        emailDomain,
        resetAt: emailRate.resetAt
      });
      await logger.warn({
        ...loggerContext,
        route,
        module: "auth",
        action: "password_reset_email_rate_limited",
        message: "Password reset request email rate limit was triggered.",
        status: "failed",
        metadata: { emailDomain, resetAt: emailRate.resetAt, persistent: emailRate.persistent }
      });
      return NextResponse.json({ message: GENERIC_MESSAGE }, { status: 202 });
    }

    const service = createSupabaseServiceRoleClient();
    if (!service) {
      resetConsoleLog("error", "password_reset_service_unconfigured", { traceId: loggerContext.traceId });
      await logger.error({
        ...loggerContext,
        route,
        module: "auth",
        action: "password_reset_service_unconfigured",
        message: "Password reset service-role client is not configured.",
        status: "failed"
      });
      return NextResponse.json({ error: "El servicio de recuperacion no esta configurado." }, { status: 503 });
    }

    const cooldownSeconds = passwordResetCooldownSeconds();
    const cooldownStart = new Date(Date.now() - cooldownSeconds * 1000).toISOString();
    const recentResult = await service
      .from("password_reset_codes")
      .select("id")
      .ilike("email", email)
      .gte("created_at", cooldownStart)
      .is("used_at", null)
      .limit(1)
      .maybeSingle();
    if (recentResult.error) {
      if (isMissingSchemaError(recentResult.error)) {
        resetConsoleLog("error", "password_reset_schema_missing", {
          traceId: loggerContext.traceId,
          requiredMigration: REQUIRED_MIGRATION,
          errorMessage: recentResult.error.message
        });
        await logger.error({
          ...loggerContext,
          route,
          module: "auth",
          action: "password_reset_schema_missing",
          message: "Password reset schema is missing.",
          status: "failed",
          metadata: schemaErrorMetadata(recentResult.error, REQUIRED_MIGRATION),
          error: recentResult.error
        });
        return NextResponse.json({ error: missingMigrationMessage("recuperacion de contrasena") }, { status: 503 });
      }
      throw recentResult.error;
    }
    if (recentResult.data) {
      resetConsoleLog("info", "password_reset_cooldown_active", {
        traceId: loggerContext.traceId,
        email: maskEmail(email),
        emailDomain,
        cooldownSeconds
      });
      await logger.info({
        ...loggerContext,
        route,
        module: "auth",
        action: "password_reset_cooldown_active",
        message: "Password reset request ignored because cooldown is active.",
        status: "completed",
        metadata: { emailDomain, cooldownSeconds }
      });
      return NextResponse.json({ message: GENERIC_MESSAGE, cooldownSeconds }, { status: 202 });
    }

    const profileResult = await service
      .from("profiles")
      .select("id, email, full_name, is_active")
      .ilike("email", email)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (profileResult.error) throw profileResult.error;
    resetConsoleLog("info", "password_reset_user_lookup_done", {
      traceId: loggerContext.traceId,
      email: maskEmail(email),
      emailDomain,
      found: Boolean(profileResult.data),
      activeOnly: true
    });

    if (profileResult.data) {
      const profile = profileResult.data;
      const code = generatePasswordResetCode();
      const expiresAt = passwordResetExpiresAt();
      const closeOpenCodesResult = await service
        .from("password_reset_codes")
        .update({ used_at: new Date().toISOString() })
        .eq("user_id", profile.id)
        .is("used_at", null);
      if (closeOpenCodesResult.error) {
        resetConsoleLog("warn", "password_reset_previous_codes_close_failed", {
          traceId: loggerContext.traceId,
          email: maskEmail(email),
          emailDomain,
          errorMessage: closeOpenCodesResult.error.message
        });
        await logger.warn({
          ...loggerContext,
          route,
          module: "auth",
          action: "password_reset_previous_codes_close_failed",
          message: "Unable to close previous password reset codes.",
          status: "failed",
          metadata: { emailDomain },
          error: closeOpenCodesResult.error
        });
      }

      const { data: resetRow, error: insertError } = await service
        .from("password_reset_codes")
        .insert({
          user_id: profile.id,
          email,
          code_hash: hashPasswordResetCode(code, email),
          expires_at: expiresAt.toISOString(),
          max_attempts: passwordResetMaxAttempts(),
          ip_address: ipAddress,
          user_agent: userAgent
        })
        .select("id")
        .single();

      if (insertError || !resetRow) {
        resetConsoleLog("error", "password_reset_code_insert_failed", {
          traceId: loggerContext.traceId,
          email: maskEmail(email),
          emailDomain,
          errorMessage: insertError?.message
        });
        await logger.error({
          ...loggerContext,
          route,
          module: "auth",
          action: "password_reset_code_insert_failed",
          message: "Unable to persist password reset code.",
          status: "failed",
          metadata: insertError ? schemaErrorMetadata(insertError, REQUIRED_MIGRATION) : { emailDomain },
          error: insertError
        });
        return NextResponse.json({ error: "No se pudo preparar el codigo de recuperacion." }, { status: 500 });
      }

      resetConsoleLog("info", "password_reset_code_created", {
        traceId: loggerContext.traceId,
        email: maskEmail(email),
        emailDomain,
        resetId: resetRow.id,
        expiresAt: expiresAt.toISOString()
      });
      await logger.info({
        ...loggerContext,
        route,
        module: "auth",
        action: "password_reset_code_created",
        message: "Password reset code was created.",
        status: "completed",
        metadata: { email: maskEmail(email), emailDomain, resetId: resetRow.id, expiresAt: expiresAt.toISOString() }
      });

      const emailDiagnostics = getEmailProviderDiagnostics();
      resetConsoleLog("info", "password_reset_email_provider_selected", {
        traceId: loggerContext.traceId,
        email: maskEmail(email),
        provider: emailDiagnostics.provider,
        emailFrom: emailDiagnostics.emailFrom,
        canSendRealEmail: emailDiagnostics.canSendRealEmail,
        warnings: emailDiagnostics.warnings
      });
      await logger.info({
        ...loggerContext,
        route,
        module: "auth",
        action: "password_reset_email_provider_selected",
        message: "Password reset email provider selected.",
        status: "completed",
        metadata: {
          email: maskEmail(email),
          emailDomain,
          provider: emailDiagnostics.provider,
          emailFrom: emailDiagnostics.emailFrom,
          canSendRealEmail: emailDiagnostics.canSendRealEmail,
          warnings: emailDiagnostics.warnings
        }
      });

      resetConsoleLog("info", "password_reset_email_send_started", {
        traceId: loggerContext.traceId,
        email: maskEmail(profile.email),
        provider: emailDiagnostics.provider,
        emailFrom: emailDiagnostics.emailFrom
      });
      const result = await sendEmail({
        to: [profile.email],
        subject: "[Quiksol] Codigo de recuperacion de contrasena",
        html: resetEmailHtml(code, expiresAt)
      });
      resetConsoleLog(result.status === "sent" ? "info" : "error", result.status === "sent" ? "password_reset_email_sent" : "password_reset_email_failed", {
        traceId: loggerContext.traceId,
        email: maskEmail(profile.email),
        provider: result.provider,
        status: result.status,
        emailFrom: emailDiagnostics.emailFrom,
        resetId: resetRow.id,
        errorMessage: result.errorMessage
      });
      await logger.info({
        ...loggerContext,
        route,
        module: "auth",
        action: "password_reset_code_requested",
        message: "Password reset request processed.",
        status: result.status === "sent" ? "completed" : "failed",
        metadata: {
          emailDomain,
          provider: result.provider,
          status: result.status,
          resetId: resetRow.id,
          errorMessage: result.errorMessage
        }
      });
    } else {
      resetConsoleLog("info", "password_reset_user_not_found", {
        traceId: loggerContext.traceId,
        email: maskEmail(email),
        emailDomain
      });
      await logger.info({
        ...loggerContext,
        route,
        module: "auth",
        action: "password_reset_user_not_found",
        message: "Password reset request completed with generic response.",
        status: "completed",
        metadata: { emailDomain }
      });
    }

    return NextResponse.json({ message: GENERIC_MESSAGE, cooldownSeconds }, { status: 202 });
  } catch (error) {
    const missingSecret = error instanceof Error && error.message.includes("PASSWORD_RESET_SECRET");
    resetConsoleLog("error", "password_reset_request_failed", {
      traceId: loggerContext.traceId,
      errorMessage: error instanceof Error ? error.message : "Unknown password reset error."
    });
    await logger.error({
      ...loggerContext,
      route,
      module: "auth",
      action: "password_reset_request_failed",
      message: "Password reset request failed.",
      status: "failed",
      error
    });
    return NextResponse.json(
      { error: missingSecret ? "El servicio de recuperacion no esta configurado." : "No se pudo procesar la solicitud de recuperacion." },
      { status: missingSecret ? 503 : 500 }
    );
  }
}
