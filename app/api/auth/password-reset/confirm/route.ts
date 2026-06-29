import { NextResponse } from "next/server";
import { z } from "zod";
import { requestIp, rateLimitResponse } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
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

export async function POST(request: Request) {
  const ipAddress = requestIp(request);
  const body = await request.json().catch(() => null);
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "La nueva contrasena no cumple los requisitos.", issues: parsed.error.flatten() }, { status: 400 });

  const email = normalizeResetEmail(parsed.data.email);
  const rate = await checkPersistentRateLimit({
    action: "password_reset_confirm",
    identifier: `${ipAddress}:${email}`,
    limit: 5,
    windowSeconds: 15 * 60,
    blockSeconds: 15 * 60
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ error: "El servicio de recuperacion no esta configurado." }, { status: 503 });

  const { data: reset } = await service
    .from("password_reset_codes")
    .select("id, user_id, verification_token_hash, verified_at, expires_at, used_at")
    .ilike("email", email)
    .not("verified_at", "is", null)
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const tokenHash = hashPasswordResetToken(parsed.data.resetToken, email);
  const valid = Boolean(
    reset?.user_id &&
    reset.verified_at &&
    new Date(reset.expires_at).getTime() > Date.now() &&
    secureHashEquals(reset.verification_token_hash, tokenHash)
  );
  if (!valid || !reset?.user_id) return NextResponse.json({ error: INVALID_MESSAGE }, { status: 400 });

  const { error: updateError } = await service.auth.admin.updateUserById(reset.user_id, {
    password: parsed.data.password
  });
  if (updateError) return NextResponse.json({ error: "No se pudo actualizar la contrasena. Intenta de nuevo." }, { status: 502 });

  const completedAt = new Date().toISOString();
  await Promise.all([
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

  return NextResponse.json({ success: true, message: "Tu contrasena fue actualizada." });
}
