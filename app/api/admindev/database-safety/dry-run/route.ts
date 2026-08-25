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
    const { data, error } = await context.service.rpc("database_safety_dry_run_v2", {
      input_actor_id: context.user.id
    });
    if (error || !data) throw error ?? new Error("DRY_RUN_MISSING");
    const result = data as {
      dataVersion: number;
      storageVersion: number;
      catalogVersion: string;
      schemaInventoryHash: string;
      wouldDelete: Array<{ action: "DELETE" | "PRESERVE" }>;
      wouldPreserve: Array<{ action: "DELETE" | "PRESERVE" }>;
      storageScope: unknown[];
      authScope: string;
      unclassifiedResources: string[];
    };
    return superadminJson({
      dryRun: true,
      modifiedRows: 0,
      dataVersion: result.dataVersion,
      storageVersion: result.storageVersion,
      catalogVersion: result.catalogVersion,
      schemaInventoryHash: result.schemaInventoryHash,
      wouldDelete: result.wouldDelete,
      wouldPreserve: result.wouldPreserve,
      storageScope: result.storageScope,
      authScope: result.authScope,
      unclassifiedResources: result.unclassifiedResources,
      storageFilesIncluded: true,
      deleteLocked: true
    });
  } catch (error) {
    return databaseSafetyErrorResponse(error, "DRY_RUN_FAILED");
  }
}
