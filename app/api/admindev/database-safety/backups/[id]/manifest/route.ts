import { NextResponse } from "next/server";
import { requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const { data, error } = await context.supabase
    .from("database_backup_manifests")
    .select("*")
    .eq("id", id)
    .eq("created_by", context.user.id)
    .maybeSingle();
  if (error || !data) return superadminJson({ error: "BACKUP_MANIFEST_NOT_FOUND" }, { status: 404 });

  const manifest = {
    backupVersion: 1,
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
    restoreListVerified: data.restore_list_verified,
    storageFilesIncluded: false
  };
  const response = superadminJson(manifest);
  response.headers.set("Content-Disposition", `attachment; filename="${String(data.file_name).replace(/\.dump$/, "")}.manifest.json"`);
  return response;
}
