import { NextResponse } from "next/server";
import { assertCriticalSameOrigin, requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";
import { databaseSafetyErrorResponse, databaseSafetyRateLimit } from "@/lib/superadmin/database-safety-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const limited = await databaseSafetyRateLimit(context, "cancel", 10, 60 * 60);
  if (limited) return limited;
  const { id } = await params;
  const { data, error } = await context.service.rpc("cancel_database_destruction_v2", {
    input_actor_id: context.user.id,
    input_operation_id: id
  });
  if (error) return databaseSafetyErrorResponse(error, "CANCEL_FAILED");
  return superadminJson({ cancelled: Boolean(data) });
}
