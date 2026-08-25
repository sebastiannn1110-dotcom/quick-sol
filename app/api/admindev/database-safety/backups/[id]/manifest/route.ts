import { NextResponse } from "next/server";
import { requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const { data, error } = await context.service
    .from("database_backup_manifests")
    .select("*")
    .eq("id", id)
    .eq("created_by", context.user.id)
    .maybeSingle();
  if (error || !data) return superadminJson({ error: "BACKUP_MANIFEST_NOT_FOUND" }, { status: 404 });

  const manifest = {
    backupVersion: 2,
    createdAt: data.created_at,
    databaseProject: data.database_project,
    schemaVersion: data.schema_version,
    migrationVersion: data.migration_version,
    dataVersion: data.data_version,
    format: data.format,
    sha256: data.sha256,
    sizeBytes: data.size_bytes,
    tableCount: data.table_count,
    fileName: data.file_name,
    catalogVersion: data.catalog_version,
    schemaInventoryHash: data.schema_inventory_hash,
    storageVersion: data.storage_version,
    evidenceHash: data.evidence_hash,
    restoreListVerified: data.restore_list_verified,
    restoreVerified: data.restore_verified,
    database: {
      scope: "public",
      sha256: data.database_sha256,
      sizeBytes: data.database_size_bytes
    },
    storage: {
      filesIncluded: data.storage_files_included,
      manifestSha256: data.storage_manifest_sha256,
      objectCount: data.storage_object_count,
      sizeBytes: data.storage_size_bytes,
      scope: data.backup_scope?.storage ?? [],
      restoreProcedure: "extract-tar-and-upload-verified-object-manifest"
    },
    auth: data.auth_scope,
    migrations: "PRESERVED_NOT_INCLUDED"
  };
  const response = superadminJson(manifest);
  response.headers.set("Content-Disposition", `attachment; filename="${String(data.file_name).replace(/\.(dump|tar)$/, "")}.manifest.json"`);
  return response;
}
