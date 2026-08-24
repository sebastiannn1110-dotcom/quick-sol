import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";
import { IMPORT_ERRORS_SAFE_VIEW } from "@/lib/security/business-records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const { searchParams } = new URL(request.url);
  const uploadBatchId = searchParams.get("uploadBatchId");

  if (context.isDemoMode) return NextResponse.json({ errors: [] });

  let query = context.supabase!
    .from(IMPORT_ERRORS_SAFE_VIEW)
    .select("id,upload_batch_id,upload_sheet_id,row_index,column_name,error_type,message,severity,created_at,trace_id,upload_batches,upload_sheets")
    .order("created_at", { ascending: false })
    .limit(500);

  if (uploadBatchId) query = query.eq("upload_batch_id", uploadBatchId);

  const { data, error } = await query;

  if (error) return NextResponse.json({ error: "Unable to load import errors." }, { status: 500 });
  return NextResponse.json({ errors: data ?? [] }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
