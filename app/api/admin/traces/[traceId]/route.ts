import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";
import { IMPORT_ERRORS_SAFE_VIEW } from "@/lib/security/business-records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ traceId: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const { traceId } = await params;
  if (context.isDemoMode) return NextResponse.json({ traceId, events: [] });

  const [logs, performanceLogs, importErrors, securityEvents] = await Promise.all([
    context.supabase!.from("system_logs").select("*").eq("trace_id", traceId).order("created_at"),
    context.supabase!.from("performance_logs").select("*").eq("trace_id", traceId).order("created_at"),
    context.supabase!.from(IMPORT_ERRORS_SAFE_VIEW).select("id,trace_id,upload_batch_id,upload_sheet_id,row_index,column_name,error_type,message,severity,created_at").eq("trace_id", traceId).order("created_at"),
    context.supabase!.from("security_events").select("*").eq("trace_id", traceId).order("created_at")
  ]);

  if (logs.error || performanceLogs.error || importErrors.error || securityEvents.error) {
    return NextResponse.json({ error: "Unable to load trace timeline." }, { status: 500 });
  }

  const events = [
    ...(logs.data ?? []).map((event) => ({ source: "system_logs", ...event })),
    ...(performanceLogs.data ?? []).map((event) => ({ source: "performance_logs", ...event })),
    ...(importErrors.data ?? []).map((event) => ({ source: "import_errors", ...event })),
    ...(securityEvents.data ?? []).map((event) => ({ source: "security_events", ...event }))
  ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return NextResponse.json({ traceId, events });
}
