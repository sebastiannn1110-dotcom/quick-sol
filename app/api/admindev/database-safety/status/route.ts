import { NextResponse } from "next/server";
import { requireSuperadmin, superadminConfigStatus, superadminJson } from "@/lib/superadmin/auth";
import { databaseSafetyErrorResponse, loadDatabaseSafetySnapshot } from "@/lib/superadmin/database-safety-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  try {
    const [snapshot, latestBackup, latestOperation] = await Promise.all([
      loadDatabaseSafetySnapshot(context),
      context.service.from("database_backup_manifests").select("*").eq("created_by", context.user.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      context.service.from("database_destruction_operations").select("*").eq("created_by", context.user.id).order("created_at", { ascending: false }).limit(1).maybeSingle()
    ]);
    return superadminJson({
      snapshot,
      latestBackup: latestBackup.data ?? null,
      latestOperation: latestOperation.data ?? null,
      config: superadminConfigStatus(),
      scopeNotice: "Database: schema public incluido. Storage empresarial: incluido en bundle verificado. Supabase Auth, migrations y auditoría de seguridad: preservados y no incluidos."
    });
  } catch (error) {
    return databaseSafetyErrorResponse(error, "DATABASE_SAFETY_STATUS_FAILED");
  }
}
