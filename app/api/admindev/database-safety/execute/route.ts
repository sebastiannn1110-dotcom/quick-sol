import { NextResponse } from "next/server";
import { z } from "zod";
import { assertCriticalSameOrigin, challengeHash, requireSuperadmin, superadminJson, superadminSessionBinding } from "@/lib/superadmin/auth";
import { databaseSafetyErrorResponse, databaseSafetyRateLimit, safeDatabaseError } from "@/lib/superadmin/database-safety-api";
import { databaseSafetyDeleteEnabled } from "@/lib/superadmin/database-safety-policy";
import { createSupabaseStorageBackupSource, purgeBusinessStorage } from "@/lib/superadmin/database-safety-storage";

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
  if (!databaseSafetyDeleteEnabled()) {
    return superadminJson({ error: "DELETE_KILL_SWITCH_DISABLED", deleteLocked: true }, { status: 423 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return superadminJson({ error: "INVALID_DESTRUCTION_REQUEST" }, { status: 400 });
  const sessionBinding = await superadminSessionBinding(context);
  if (!sessionBinding) return superadminJson({ error: "SESSION_BINDING_FAILED" }, { status: 409 });

  const { data, error } = await context.service.rpc("execute_database_business_purge_v2", {
    input_actor_id: context.user.id,
    input_operation_id: parsed.data.operationId,
    input_challenge_hash: challengeHash(parsed.data.challenge),
    input_session_binding_hash: sessionBinding
  });
  if (error || !data) {
    const safeCode = safeDatabaseError(error);
    const validationFailure = safeCode !== "DATABASE_SAFETY_OPERATION_FAILED";
    if (!validationFailure) {
      try {
        await context.service.rpc("fail_database_destruction_v2", {
          input_actor_id: context.user.id,
          input_operation_id: parsed.data.operationId,
          input_failure_code: "DELETE_TRANSACTION_FAILED"
        });
      } catch {
        // The original error remains authoritative and is returned as a safe code.
      }
    }
    return databaseSafetyErrorResponse(error, "DELETE_TRANSACTION_FAILED");
  }
  const { data: claimed, error: claimError } = await context.service.rpc("claim_database_storage_cleanup_v2", {
    input_actor_id: context.user.id,
    input_operation_id: parsed.data.operationId
  });
  if (claimError) return databaseSafetyErrorResponse(claimError, "STORAGE_CLEANUP_CLAIM_FAILED");
  if (!claimed) {
    const { data: existing } = await context.service
      .from("database_destruction_operations")
      .select("status,storage_status,result")
      .eq("id", parsed.data.operationId)
      .eq("created_by", context.user.id)
      .maybeSingle();
    if (existing?.status === "completed") return superadminJson({ result: existing.result });
    return superadminJson({ error: "STORAGE_CLEANUP_IN_PROGRESS", recoveryPending: true, deleteLocked: true }, { status: 409 });
  }

  const { data: operation } = await context.service
    .from("database_destruction_operations")
    .select("backup_manifest_id")
    .eq("id", parsed.data.operationId)
    .eq("created_by", context.user.id)
    .single();
  const { data: manifest } = await context.service
    .from("database_backup_manifests")
    .select("storage_object_keys")
    .eq("id", operation?.backup_manifest_id ?? "")
    .eq("created_by", context.user.id)
    .single();
  if (!operation || !manifest || !Array.isArray(manifest.storage_object_keys)) {
    await context.service.rpc("finish_database_storage_cleanup_v2", {
      input_actor_id: context.user.id,
      input_operation_id: parsed.data.operationId,
      input_success: false,
      input_deleted_objects: 0,
      input_safe_error_code: "STORAGE_MANIFEST_MISSING"
    });
    return superadminJson({ error: "STORAGE_MANIFEST_MISSING", recoveryPending: true, deleteLocked: true }, { status: 409 });
  }

  try {
    const storageResult = await purgeBusinessStorage(
      createSupabaseStorageBackupSource(context.service),
      manifest.storage_object_keys.map(String)
    );
    const { data: completed, error: finishError } = await context.service.rpc("finish_database_storage_cleanup_v2", {
      input_actor_id: context.user.id,
      input_operation_id: parsed.data.operationId,
      input_success: true,
      input_deleted_objects: storageResult.deletedObjects,
      input_safe_error_code: null
    });
    if (finishError || !completed) return databaseSafetyErrorResponse(finishError, "STORAGE_CLEANUP_FINALIZE_FAILED");
    const row = Array.isArray(completed) ? completed[0] : completed;
    return superadminJson({ result: row.result });
  } catch {
    await context.service.rpc("finish_database_storage_cleanup_v2", {
      input_actor_id: context.user.id,
      input_operation_id: parsed.data.operationId,
      input_success: false,
      input_deleted_objects: 0,
      input_safe_error_code: "STORAGE_DELETE_FAILED"
    });
    return superadminJson({ error: "STORAGE_DELETE_FAILED", recoveryPending: true, deleteLocked: true }, { status: 409 });
  }
}
