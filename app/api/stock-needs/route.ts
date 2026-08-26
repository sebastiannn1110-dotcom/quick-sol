import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/context";
import {
  isSummaryUnavailableError,
  readBusinessSummaryWithFence,
  summaryResponseHeaders,
  summaryUnavailableHttpStatus,
  summaryUnavailablePayload
} from "@/lib/performance/summary-readiness";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logger } from "@/lib/logger/logger";
import { redactSensitiveFieldsForRole } from "@/lib/security/permissions";
import { buildStockNeedsResult, type CoverageStatus, type StockNeedsFilters } from "@/lib/stock-needs/stock-needs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COVERAGE_STATUSES = new Set<CoverageStatus>(["in_stock", "partial_stock", "no_stock", "overstock", "unknown"]);

function cleanText(value: string | null, max = 120) {
  const text = value?.replace(/[^\p{L}\p{N}\s._@/-]/gu, " ").replace(/\s+/g, " ").trim() ?? "";
  return text ? text.slice(0, max) : null;
}

function cleanUuid(value: string | null) {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function parseFilters(request: Request): StockNeedsFilters {
  const searchParams = new URL(request.url).searchParams;
  const rawCoverage = cleanText(searchParams.get("coverageStatus"), 40);
  return {
    q: cleanText(searchParams.get("q")),
    customer: cleanText(searchParams.get("customer")),
    supplier: cleanText(searchParams.get("supplier")),
    manufacturer: cleanText(searchParams.get("manufacturer")),
    status: cleanText(searchParams.get("status"), 60),
    coverageStatus: rawCoverage && COVERAGE_STATUSES.has(rawCoverage as CoverageStatus) ? rawCoverage as CoverageStatus : null,
    uploadBatchId: cleanUuid(searchParams.get("uploadBatchId")),
    limit: Math.min(Math.max(Number(searchParams.get("limit") ?? 50) || 50, 1), 200),
    offset: Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0)
  };
}

export async function GET(request: Request) {
  const context = await requireRole(request, ["admin", "manager", "employee"]);
  if (context instanceof NextResponse) return context;

  const filters = parseFilters(request);
  const logContext = {
    ...getLoggerContextFromRequest(request),
    userId: context.profile.id,
    userRole: context.profile.role,
    module: "api" as const
  };
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json(redactSensitiveFieldsForRole(buildStockNeedsResult({ records: [], filters }), context.profile.role));
  }

  try {
    const fenced = await readBusinessSummaryWithFence(
      context.supabase,
      { uploadBatchId: filters.uploadBatchId },
      () => context.supabase!.rpc("get_stock_needs_page_v1", {
        p_limit: filters.limit,
        p_offset: filters.offset,
        p_q: filters.q ?? null,
        p_customer: filters.customer ?? null,
        p_supplier: filters.supplier ?? null,
        p_manufacturer: filters.manufacturer ?? null,
        p_status: filters.status ?? null,
        p_coverage: filters.coverageStatus ?? null,
        p_upload_batch_id: filters.uploadBatchId ?? null
      })
    );
    await logger.info({
      ...logContext,
      action: "stock_needs_summary_ready",
      message: "Stock needs summary passed both readiness fences.",
      status: "completed",
      metadata: {
        summaryStatus: fenced.after.status,
        currentVersion: fenced.after.currentVersion,
        requiredVersion: fenced.after.requiredVersion,
        totalScopes: fenced.after.totalScopes,
        scopedUpload: Boolean(filters.uploadBatchId)
      }
    });
    const result = fenced.result;
    return NextResponse.json(redactSensitiveFieldsForRole(result, context.profile.role), {
      headers: summaryResponseHeaders()
    });
  } catch (error) {
    if (isSummaryUnavailableError(error)) {
      await logger.warn({
        ...logContext,
        action: `stock_needs_summary_${error.reason}`,
        message: "Stock needs summary is unavailable at a readiness fence.",
        status: "failed",
        statusCode: summaryUnavailableHttpStatus(error.state),
        metadata: {
          summaryStatus: error.state.status,
          currentVersion: error.state.currentVersion,
          requiredVersion: error.state.requiredVersion,
          pendingCount: error.state.pendingCount,
          totalScopes: error.state.totalScopes,
          reason: error.reason,
          scopedUpload: Boolean(filters.uploadBatchId)
        }
      });
      return NextResponse.json(summaryUnavailablePayload(error.state), {
        status: summaryUnavailableHttpStatus(error.state),
        headers: summaryResponseHeaders(error.state)
      });
    }
    await logger.error({
      ...logContext,
      action: "stock_needs_unexpected_failure",
      message: "Unexpected stock needs summary read failure.",
      status: "failed",
      statusCode: 500,
      error
    });
    return NextResponse.json({ error: "Unable to load stock and needs." }, { status: 500 });
  }
}
