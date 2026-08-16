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
      context.supabase.from("database_backup_manifests").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      context.supabase.from("database_destruction_operations").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle()
    ]);
    return superadminJson({
      snapshot,
      latestBackup: latestBackup.data ?? null,
      latestOperation: latestOperation.data ?? null,
      config: superadminConfigStatus(),
      storageWarning: "Respaldo limitado al schema public: NO incluye archivos físicos de Supabase Storage ni un backup independiente de Supabase Auth."
    });
  } catch (error) {
    return databaseSafetyErrorResponse(error, "DATABASE_SAFETY_STATUS_FAILED");
  }
}
