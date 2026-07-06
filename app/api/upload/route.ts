import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { handleRouteError } from "@/lib/errors/errorHandler";
import { SupabaseError } from "@/lib/errors/AppError";
import { logger } from "@/lib/logger/logger";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const logContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: request.method
  };

  if (context.isDemoMode) {
    await logger.info({
      ...logContext,
      module: "upload",
      action: "uploads_loaded_demo",
      message: "Upload history loaded from demo data.",
      status: "completed"
    });
    const { uploads } = await getDemoPlatformData();
    return NextResponse.json({ uploads });
  }

  const query = context.supabase!
    .from("upload_batches")
    .select("*, profiles(full_name,email,department,region,role)")
    .order("created_at", { ascending: false })
    .limit(100);

  const { data, error } = await query;
  if (error) {
    return handleRouteError(new SupabaseError("Unable to load uploads.", { table: "upload_batches" }), logContext, {
      module: "upload",
      action: "uploads_load_failed"
    });
  }

  return NextResponse.json({ uploads: data ?? [] });
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const logContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: request.method
  };

  try {
    await logger.info({
      ...logContext,
      module: "upload",
      action: "legacy_upload_blocked",
      message: "Legacy upload endpoint was called. Use direct-to-storage background import endpoints.",
      status: "completed"
    });

    return NextResponse.json({
      error: "Legacy uploads are disabled for large-file safety.",
      message: "Use /api/upload/initiate, upload directly to storage, then call /api/upload/finalize."
    }, { status: 409 });
  } catch (error) {
    return handleRouteError(error, logContext, {
      module: "upload",
      action: "legacy_upload_block_failed",
      fallbackMessage: "Use the background upload flow for Excel or CSV files."
    });
  }
}
