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
    return superadminJson({
      backupId: id,
      status: "verified",
      sha256: backup.manifest.sha256,
      sizeBytes: backup.manifest.sizeBytes,
      restoreListVerified: true,
      deleteLocked: true
    });
  } catch (error) {
    const { id } = await params;
    await discardRetainedDatabaseBackup(id, context.user.id);
    const code = error instanceof DatabaseBackupError ? error.code : "BACKUP_VERIFICATION_FAILED";
    return superadminJson({ error: code, deleteLocked: true }, { status: 409 });
  }
}
