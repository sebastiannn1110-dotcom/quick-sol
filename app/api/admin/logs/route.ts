import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const { searchParams } = new URL(request.url);
  const level = searchParams.get("level");
  const moduleName = searchParams.get("module");
  const traceId = searchParams.get("traceId");
  const uploadBatchId = searchParams.get("uploadBatchId");
  const user = searchParams.get("user");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");
  const queryText = searchParams.get("query");

  if (context.isDemoMode) return NextResponse.json({ logs: [], count: 0 });

  let query = context.supabase!
    .from("system_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(500);

  if (level) query = query.eq("level", level);
  if (moduleName) query = query.eq("module", moduleName);
  if (traceId) query = query.eq("trace_id", traceId);
  if (uploadBatchId) query = query.eq("upload_batch_id", uploadBatchId);
  if (user) {
    query = UUID_RE.test(user)
      ? query.eq("user_id", user)
      : query.ilike("user_email", `%${user.replace(/[%_]/g, "")}%`);
  }
  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo) query = query.lte("created_at", `${dateTo}T23:59:59.999Z`);
  if (queryText) query = query.or(`action.ilike.%${queryText}%,message.ilike.%${queryText}%`);

  const { data, error, count } = await query;
  if (error) {
    await logger.error({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      method: "GET",
      module: "admin",
      action: "admin_logs_query_failed",
      message: "Unable to load system logs.",
      status: "failed",
      error,
      metadata: { level, moduleName, traceId, uploadBatchId, user, dateFrom, dateTo, hasQuery: Boolean(queryText) }
    });
    return NextResponse.json({ error: "Unable to load system logs." }, { status: 500 });
  }

  return NextResponse.json({ logs: data ?? [], count: count ?? 0 });
}
