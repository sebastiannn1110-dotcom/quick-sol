import { NextResponse } from "next/server";
import { assertCriticalSameOrigin, requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";
import { DatabaseBackupError, discardRetainedDatabaseBackup, verifyRetainedDatabaseBackup } from "@/lib/superadmin/database-safety";
import { databaseSafetyRateLimit } from "@/lib/superadmin/database-safety-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const limited = await databaseSafetyRateLimit(context, "verify_backup", 5, 60 * 60);
  if (limited) return limited;
  try {
    const { id } = await params;
    const backup = await verifyRetainedDatabaseBackup(id, context.user.id);
    const { data, error } = await context.service.rpc("verify_database_backup_manifest_v2", {
      input_actor_id: context.user.id,
      input_manifest_id: id,
      input_evidence_hash: backup.manifest.evidenceHash
    });
    if (error || !data) throw error ?? new DatabaseBackupError("BACKUP_VERIFICATION_FAILED");
    return superadminJson({
      backupId: id,
      status: "verified",
      sha256: backup.manifest.sha256,
      sizeBytes: backup.manifest.sizeBytes,
      restoreListVerified: true,
      restoreVerified: true,
      storageFilesIncluded: true,
      deleteLocked: true
    });
  } catch (error) {
    const { id } = await params;
    await discardRetainedDatabaseBackup(id, context.user.id);
    const code = error instanceof DatabaseBackupError ? error.code : "BACKUP_VERIFICATION_FAILED";
    return superadminJson({ error: code, deleteLocked: true }, { status: 409 });
  }
}
