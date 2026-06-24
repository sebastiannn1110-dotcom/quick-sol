import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";

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
    context.supabase!.from("import_errors").select("*").eq("trace_id", traceId).order("created_at"),
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
