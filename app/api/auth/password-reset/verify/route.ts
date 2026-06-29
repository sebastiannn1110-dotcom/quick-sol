import { NextResponse } from "next/server";
import { z } from "zod";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logPublicSecurityEvent } from "@/lib/auth/public-security";
import { requestIp, rateLimitResponse } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
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

export async function POST(request: Request) {
  const context = getLoggerContextFromRequest(request);
  const route = "/api/auth/password-reset/verify";
  const ipAddress = requestIp(request);
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  const body = await request.json().catch(() => null);
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: INVALID_MESSAGE }, { status: 400 });

  const email = normalizeResetEmail(parsed.data.email);
  const rate = await checkPersistentRateLimit({
    action: "password_reset_verify",
    identifier: `${ipAddress}:${email}`,
    limit: 10,
    windowSeconds: 15 * 60,
    blockSeconds: 15 * 60
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ error: "El servicio de recuperacion no esta configurado." }, { status: 503 });

  const { data: reset } = await service
    .from("password_reset_codes")
    .select("id, user_id, code_hash, expires_at, attempts, max_attempts, used_at")
    .ilike("email", email)
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const expired = !reset || new Date(reset.expires_at).getTime() <= Date.now();
  const exhausted = !reset || reset.attempts >= reset.max_attempts;
  if (expired || exhausted) return NextResponse.json({ error: INVALID_MESSAGE }, { status: 400 });

  const nextAttempts = reset.attempts + 1;
  const expectedHash = hashPasswordResetCode(parsed.data.code, email);
  const valid = secureHashEquals(reset.code_hash, expectedHash);
  if (!valid) {
    await service.from("password_reset_codes").update({ attempts: nextAttempts }).eq("id", reset.id);
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
  await service
    .from("password_reset_codes")
    .update({
      attempts: nextAttempts,
      verified_at: new Date().toISOString(),
      verification_token_hash: hashPasswordResetToken(resetToken, email)
    })
    .eq("id", reset.id);

  return NextResponse.json({ verified: true, resetToken });
}
