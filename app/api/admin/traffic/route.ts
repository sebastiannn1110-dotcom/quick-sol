import { NextResponse } from "next/server";
import { requireAdmin, logAuditEvent } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { buildTrafficAnalytics } from "@/lib/traffic/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ traffic: null, demo: true });

  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range");

  try {
    const traffic = await buildTrafficAnalytics(context.supabase, range);
    await logAuditEvent(context, "admin_traffic_viewed", "system_logs", null, { range: traffic.range.key });
    return NextResponse.json({ traffic });
  } catch (error) {
    await logger.error({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      method: "GET",
      module: "admin",
      action: "admin_traffic_failed",
      message: "Unable to load admin traffic analytics.",
      status: "failed",
      error
    });
    return NextResponse.json({ error: "Unable to load traffic analytics." }, { status: 500 });
  }
}
