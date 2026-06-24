import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";
import { measureAsync } from "@/lib/logger/performance";
import { buildPlatformAnalytics } from "@/lib/platform/analytics";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";
import { safeQuery } from "@/lib/supabase/supabase-safe";
import type { PlatformRecord, Profile, UploadBatch } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const logContext: LogContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: "GET"
  };

  try {
    const analytics = await measureAsync(
      "analytics_query",
      "analytics",
      logContext,
      async () => {
        if (context.isDemoMode) {
          const data = await getDemoPlatformData();
          if (!data.records.length) {
            await logger.warn({
              ...logContext,
              module: "analytics",
              action: "analytics_empty_result",
              message: "Employee analytics returned no records.",
              status: "completed",
              metadata: { source: "demo" }
            });
          }
          return buildPlatformAnalytics(data);
        }

        const [recordsResult, uploadsResult, profilesResult] = await Promise.all([
          safeQuery<PlatformRecord[]>(
            "business_records",
            logContext,
            () =>
              context.supabase!
                .from("business_records")
                .select("*, profiles(full_name,email,department,region,role)")
                .is("archived_at", null)
                .limit(5000),
            { filters: { archived_at: null }, limit: 5000, scope: "employee_analytics" }
          ),
          safeQuery<UploadBatch[]>(
            "upload_batches",
            logContext,
            () =>
              context.supabase!
                .from("upload_batches")
                .select("*, profiles(full_name,email,department,region,role)")
                .order("created_at", { ascending: false })
                .limit(1000),
            { orderBy: "created_at_desc", limit: 1000, scope: "employee_analytics" }
          ),
          safeQuery<Profile[]>(
            "profiles",
            logContext,
            () => context.supabase!.from("profiles").select("*").eq("is_active", true),
            { filters: { is_active: true }, scope: "employee_analytics" }
          )
        ]);

        const firstError = recordsResult.error ?? uploadsResult.error ?? profilesResult.error;
        if (firstError) throw firstError;
        const records = (recordsResult.data ?? []) as PlatformRecord[];
        if (!records.length) {
          await logger.warn({
            ...logContext,
            module: "analytics",
            action: "analytics_empty_result",
            message: "Employee analytics returned no records.",
            status: "completed"
          });
        }

        return buildPlatformAnalytics({
          records,
          uploads: (uploadsResult.data ?? []) as UploadBatch[],
          profiles: (profilesResult.data ?? []) as Profile[]
        });
      },
      { scope: "employee_analytics" },
      { slowAction: "slow_query_detected" }
    );

    await logger.info({
      ...logContext,
      module: "analytics",
      action: "employee_analytics_loaded",
      message: "Employee analytics loaded.",
      status: "completed",
      metadata: {
        totalRecords: analytics.totals.totalRecords,
        totalUploads: analytics.totals.totalUploads
      }
    });
    await logger.info({
      ...logContext,
      module: "analytics",
      action: "category_analytics_loaded",
      message: "Category analytics loaded.",
      status: "completed",
      metadata: { categoriesDetected: analytics.totals.categoriesDetected }
    });

    return NextResponse.json({ analytics });
  } catch (error) {
    await logger.error({
      ...logContext,
      module: "analytics",
      action: "analytics_query_failed",
      message: "Unable to load employee analytics.",
      status: "failed",
      error
    });
    return NextResponse.json({ error: "Unable to load analytics." }, { status: 500 });
  }
}
