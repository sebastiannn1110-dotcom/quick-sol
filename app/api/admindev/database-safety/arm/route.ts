import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertCriticalSameOrigin,
  challengeHash,
  createDestructionChallenge,
  reauthenticateSuperAdmin,
  requireSuperadmin,
  superadminIpHash,
  superadminJson,
  superadminSessionBinding
} from "@/lib/superadmin/auth";
import { DATABASE_DESTRUCTION_PHRASE } from "@/lib/superadmin/database-safety-policy";
import { databaseSafetyErrorResponse, databaseSafetyRateLimit } from "@/lib/superadmin/database-safety-api";

const schema = z.object({
  backupId: z.string().uuid(),
  phrase: z.string().max(100),
  password: z.string().min(1).max(500),
  downloadConfirmed: z.literal(true)
}).strict();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const limited = await databaseSafetyRateLimit(context, "arm_and_reauthenticate", 3, 60 * 60);
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.phrase !== DATABASE_DESTRUCTION_PHRASE) {
    return superadminJson({ error: "CONFIRMATION_INVALID", deleteLocked: true }, { status: 400 });
  }
  if (!process.env.DATABASE_SAFETY_AUDIT_SECRET) {
    return superadminJson({ error: "AUDIT_SECRET_NOT_CONFIGURED", deleteLocked: true }, { status: 503 });
  }
  if (!(await reauthenticateSuperAdmin(context, parsed.data.password))) {
    return superadminJson({ error: "REAUTHENTICATION_FAILED", deleteLocked: true }, { status: 401 });
  }
  if (process.env.DATABASE_SAFETY_REQUIRE_AAL2 === "true") {
    const { data } = await context.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data?.currentLevel !== "aal2") {
      return superadminJson({ error: "MFA_AAL2_REQUIRED", deleteLocked: true }, { status: 403 });
    }
  }
  const sessionBinding = await superadminSessionBinding(context);
  const ipHash = superadminIpHash(context);
  if (!sessionBinding || !ipHash) {
    return superadminJson({ error: "SESSION_BINDING_FAILED", deleteLocked: true }, { status: 409 });
  }

  const challenge = createDestructionChallenge();
  const { data, error } = await context.service.rpc("arm_database_destruction_v2", {
    input_actor_id: context.user.id,
    input_backup_manifest_id: parsed.data.backupId,
    input_challenge_hash: challengeHash(challenge),
    input_session_binding_hash: sessionBinding,
    input_ip_hash: ipHash
  });
  if (error || !data) return databaseSafetyErrorResponse(error, "DESTRUCTION_ARM_FAILED");
  const operation = Array.isArray(data) ? data[0] : data;
  return superadminJson({
    operationId: operation.id,
    challenge,
    status: operation.status,
    notBefore: operation.not_before,
    expiresAt: operation.challenge_expires_at,
    countdownSeconds: 30
  });
}
