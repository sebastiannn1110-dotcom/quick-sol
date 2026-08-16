import { NextResponse } from "next/server";
import { z } from "zod";
import { assertCriticalSameOrigin, challengeHash, requireSuperadmin, superadminJson, superadminSessionBinding } from "@/lib/superadmin/auth";
import { databaseSafetyErrorResponse, databaseSafetyRateLimit, safeDatabaseError } from "@/lib/superadmin/database-safety-api";

const schema = z.object({
  operationId: z.string().uuid(),
  challenge: z.string().min(32).max(200)
}).strict();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const limited = await databaseSafetyRateLimit(context, "execute", 2, 60 * 60);
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return superadminJson({ error: "INVALID_DESTRUCTION_REQUEST" }, { status: 400 });
  const sessionBinding = await superadminSessionBinding(context);
  if (!sessionBinding) return superadminJson({ error: "SESSION_BINDING_FAILED" }, { status: 409 });

  const { data, error } = await context.supabase.rpc("execute_database_business_purge", {
    input_operation_id: parsed.data.operationId,
    input_challenge_hash: challengeHash(parsed.data.challenge),
    input_session_binding_hash: sessionBinding
  });
  if (error || !data) {
    const safeCode = safeDatabaseError(error);
    const validationFailure = safeCode !== "DATABASE_SAFETY_OPERATION_FAILED";
    if (!validationFailure) {
      try {
        await context.supabase.rpc("fail_database_destruction", {
          input_operation_id: parsed.data.operationId,
          input_failure_code: "DELETE_TRANSACTION_FAILED"
        });
      } catch {
        // The original error remains authoritative and is returned as a safe code.
      }
    }
    return databaseSafetyErrorResponse(error, "DELETE_TRANSACTION_FAILED");
  }
  return superadminJson({ result: data });
}
