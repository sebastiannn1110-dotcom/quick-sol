import { NextResponse } from "next/server";
import { assertCriticalSameOrigin, requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";
import { databaseSafetyErrorResponse, databaseSafetyRateLimit } from "@/lib/superadmin/database-safety-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const limited = await databaseSafetyRateLimit(context, "dry_run", 10, 10 * 60);
  if (limited) return limited;
  try {
    const { data, error } = await context.supabase.rpc("database_safety_dry_run");
    if (error || !data) throw error ?? new Error("DRY_RUN_MISSING");
    const tables = (data as { tables: Array<{ action: "DELETE" | "PRESERVE" }> }).tables;
    return superadminJson({
      dryRun: true,
      modifiedRows: 0,
      dataVersion: (data as { dataVersion: number }).dataVersion,
      wouldDelete: tables.filter((table) => table.action === "DELETE"),
      wouldPreserve: tables.filter((table) => table.action === "PRESERVE"),
      storageFilesIncluded: false
    });
  } catch (error) {
    return databaseSafetyErrorResponse(error, "DRY_RUN_FAILED");
  }
}
