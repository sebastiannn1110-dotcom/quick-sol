import { NextResponse } from "next/server";
import { assertCriticalSameOrigin, requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";
import { createDatabaseBackup, DatabaseBackupError, removePreparedDatabaseBackup, retainDatabaseBackup } from "@/lib/superadmin/database-safety";
import { databaseSafetyErrorResponse, databaseSafetyRateLimit, loadDatabaseSafetySnapshot } from "@/lib/superadmin/database-safety-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1200;

export async function POST(request: Request) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const limited = await databaseSafetyRateLimit(context, "backup", 2, 60 * 60);
  if (limited) return limited;

  let prepared: Awaited<ReturnType<typeof createDatabaseBackup>> | null = null;
  try {
    const snapshot = await loadDatabaseSafetySnapshot(context);
    prepared = await createDatabaseBackup(snapshot);
    const manifest = prepared.manifest;
    const { data, error } = await context.supabase.rpc("register_database_backup_manifest", {
      input_file_name: manifest.fileName,
      input_sha256: manifest.sha256,
      input_size_bytes: manifest.sizeBytes,
      input_table_count: manifest.tableCount,
      input_database_project: manifest.databaseProject,
      input_schema_version: manifest.schemaVersion,
      input_migration_version: manifest.migrationVersion,
      input_data_version: manifest.dataVersion,
      input_restore_list_verified: true
    });
    if (error || !data) throw error ?? new Error("BACKUP_MANIFEST_REGISTRATION_FAILED");
    const row = Array.isArray(data) ? data[0] : data;
    const manifestId = String(row.id);
    await retainDatabaseBackup(manifestId, context.user.id, prepared);
    prepared = null;
    return superadminJson({
      backupId: manifestId,
      manifest,
      expiresAt: row.expires_at,
      status: "verified",
      deleteLocked: true,
      downloadUrl: `/api/admindev/database-safety/backups/${manifestId}/download`,
      manifestUrl: `/api/admindev/database-safety/backups/${manifestId}/manifest`
    });
  } catch (error) {
    if (prepared) await removePreparedDatabaseBackup(prepared).catch(() => undefined);
    if (error instanceof DatabaseBackupError) {
      return superadminJson({ error: error.code, deleteLocked: true }, { status: 409 });
    }
    return databaseSafetyErrorResponse(error, "BACKUP_GENERATION_FAILED");
  }
}
