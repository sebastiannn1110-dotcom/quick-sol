import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { cleanUuid } from "@/lib/opportunity-finder/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ errorCode: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  const jobId = cleanUuid((await params).id);
  if (!jobId) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const search = new URL(request.url).searchParams;
  const offset = Math.max(Number(search.get("offset") ?? 0) || 0, 0);
  const limit = Math.min(Math.max(Number(search.get("limit") ?? 100) || 100, 1), 250);
  const owned = await context.supabase.from("opportunity_finder_jobs").select("id").eq("id", jobId).eq("created_by", context.profile.id).maybeSingle();
  if (owned.error) return NextResponse.json({ errorCode: "JOB_READ_FAILED" }, { status: 500 });
  if (!owned.data) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const { data, error, count } = await context.supabase
    .from("opportunity_finder_rejected_rows")
    .select("id,file_id,side,file_name,sheet_name,source_row,source_row_hidden,reason_code,field_name,source_column,safe_raw_value", { count: "exact" })
    .eq("job_id", jobId)
    .order("source_row", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ errorCode: "RESULTS_READ_FAILED" }, { status: 500 });
  return NextResponse.json({
    rejectedRows: (data ?? []).map((row) => ({
      id: row.id,
      fileId: row.file_id,
      side: row.side,
      fileName: row.file_name,
      sheetName: row.sheet_name,
      sourceRow: row.source_row,
      hidden: row.source_row_hidden,
      reasonCode: row.reason_code,
      fieldName: row.field_name,
      sourceColumn: row.source_column,
      safeRawValue: row.safe_raw_value
    })),
    page: { offset, limit, total: count ?? 0 }
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
