import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";
import { measureAsync } from "@/lib/logger/performance";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { safeQuery } from "@/lib/supabase/supabase-safe";

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

  const rate = checkRateLimit({
    key: `search:${context.profile.id}`,
    limit: 120,
    windowMs: 60 * 1000
  });
  if (!rate.allowed) {
    await logger.security({
      ...logContext,
      module: "security",
      action: "rate_limit_triggered",
      message: "Search rate limit was triggered.",
      status: "failed",
      metadata: { resetAt: rate.resetAt }
    });
    return rateLimitResponse(rate.resetAt);
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query")?.trim() ?? "";
  if (!query) return NextResponse.json({ records: [], count: 0 });

  try {
    const result = await measureAsync(
      "search_query",
      "records",
      logContext,
      async () => {
        if (context.isDemoMode) {
          const { records } = await getDemoPlatformData();
          const filtered = records.filter((record) =>
            [record.searchable_text, JSON.stringify(record.normalized_data), JSON.stringify(record.raw_data)]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase())
          );
          return { records: filtered.slice(0, 50), count: filtered.length };
        }

        const { data, error, count } = await safeQuery<unknown[]>(
          "business_records",
          logContext,
          () =>
            context
              .supabase!.from("business_records")
              .select("*, profiles(full_name,email,department,region,role), upload_batches(original_file_name,detected_category,status)", {
                count: "exact"
              })
              .is("archived_at", null)
              .textSearch("searchable_text", query, { type: "websearch" })
              .limit(50),
          {
            filters: { archived_at: null, textSearch: "searchable_text" },
            queryLength: query.length,
            limit: 50
          }
        );

        if (error) throw error;
        return { records: data ?? [], count: count ?? data?.length ?? 0 };
      },
      { queryLength: query.length, limit: 50 },
      { slowAction: "slow_query_detected" }
    );

    await logger.info({
      ...logContext,
      module: "records",
      action: "search_executed",
      message: "Record search executed.",
      status: "completed",
      metadata: { queryLength: query.length, resultCount: result.count }
    });

    return NextResponse.json(result);
  } catch (error) {
    await logger.error({
      ...logContext,
      module: "records",
      action: "search_query_failed",
      message: "Unable to search records.",
      status: "failed",
      error,
      metadata: { queryLength: query.length }
    });
    return NextResponse.json({ error: "Unable to search records." }, { status: 500 });
  }
}
