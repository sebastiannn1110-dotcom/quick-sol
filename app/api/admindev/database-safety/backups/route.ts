import { NextResponse } from "next/server";
import { assertCriticalSameOrigin, requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";
import { createDatabaseBackup, databaseBackupFileName, DatabaseBackupError, removePreparedDatabaseBackup, retainDatabaseBackup } from "@/lib/superadmin/database-safety";
import { createSupabaseStorageBackupSource } from "@/lib/superadmin/database-safety-storage";
import { databaseSafetyErrorResponse, databaseSafetyRateLimit } from "@/lib/superadmin/database-safety-api";

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
  let manifestId: string | null = null;
  try {
    const now = new Date();
    const { data: begun, error: beginError } = await context.service.rpc("begin_database_backup_manifest_v2", {
      input_actor_id: context.user.id,
      input_file_name: databaseBackupFileName(now)
    });
    if (beginError || !begun) throw beginError ?? new Error("BACKUP_MANIFEST_BEGIN_FAILED");
    const begunRow = Array.isArray(begun) ? begun[0] : begun;
    manifestId = String(begunRow.id);
    const snapshot = {
      schemaVersion: String(begunRow.schema_version ?? ""),
      migrationVersion: String(begunRow.migration_version ?? ""),
      dataVersion: Number(begunRow.data_version),
      storageVersion: Number(begunRow.storage_version),
      catalogVersion: String(begunRow.catalog_version ?? ""),
      schemaInventoryHash: String(begunRow.schema_inventory_hash ?? ""),
      tableCount: Number(begunRow.table_count)
    };
    if (
      !snapshot.schemaVersion
      || !snapshot.migrationVersion
      || !Number.isSafeInteger(snapshot.dataVersion)
      || snapshot.dataVersion <= 0
      || !Number.isSafeInteger(snapshot.storageVersion)
      || snapshot.storageVersion <= 0
      || !snapshot.catalogVersion
      || !/^[0-9a-f]{64}$/.test(snapshot.schemaInventoryHash)
      || !Number.isSafeInteger(snapshot.tableCount)
      || snapshot.tableCount <= 0
    ) throw new Error("BACKUP_MANIFEST_BEGIN_FAILED");
    prepared = await createDatabaseBackup({
      ...snapshot,
      now,
      storageSource: createSupabaseStorageBackupSource(context.service)
    });
    const manifest = prepared.manifest;
    const { data, error } = await context.service.rpc("record_database_backup_created_v2", {
      input_actor_id: context.user.id,
      input_manifest_id: manifestId,
      input_bundle_sha256: manifest.sha256,
      input_bundle_size_bytes: manifest.sizeBytes,
      input_database_project: manifest.databaseProject,
      input_schema_version: manifest.schemaVersion,
      input_migration_version: manifest.migrationVersion,
      input_database_sha256: manifest.database.sha256,
      input_database_size_bytes: manifest.database.sizeBytes,
      input_table_count: manifest.tableCount,
      input_storage_manifest_sha256: manifest.storage.manifestSha256,
      input_storage_object_count: manifest.storage.objectCount,
      input_storage_size_bytes: manifest.storage.sizeBytes,
      input_storage_object_keys: prepared.storageObjectKeys,
      input_evidence_hash: manifest.evidenceHash
    });
    if (error || !data) throw error ?? new Error("BACKUP_MANIFEST_REGISTRATION_FAILED");
    const row = Array.isArray(data) ? data[0] : data;
    await retainDatabaseBackup(manifestId, context.user.id, prepared);
    prepared = null;
    return superadminJson({
      backupId: manifestId,
      manifest,
      expiresAt: row.expires_at,
      status: "created",
      deleteLocked: true,
      downloadUrl: `/api/admindev/database-safety/backups/${manifestId}/download`,
      manifestUrl: `/api/admindev/database-safety/backups/${manifestId}/manifest`
    });
  } catch (error) {
    if (prepared) await removePreparedDatabaseBackup(prepared).catch(() => undefined);
    if (manifestId) {
      try {
        await context.service.rpc("fail_database_backup_manifest_v2", {
          input_actor_id: context.user.id,
          input_manifest_id: manifestId,
          input_failure_code: error instanceof DatabaseBackupError ? error.code : "BACKUP_GENERATION_FAILED"
        });
      } catch {
        // The safe API response remains authoritative; backup content is removed below.
      }
    }
    if (error instanceof DatabaseBackupError) {
      return superadminJson({ error: error.code, deleteLocked: true }, { status: 409 });
    }
    return databaseSafetyErrorResponse(error, "BACKUP_GENERATION_FAILED");
  }
}
