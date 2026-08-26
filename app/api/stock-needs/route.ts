import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/context";
import {
  isSummaryDataReadError,
  isSummaryUnavailableError,
  readStockNeedsSnapshotWithFence,
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

const STOCK_NEEDS_RPC = "get_stock_needs_snapshot_page_v1";
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
  const startedAt = Date.now();
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
    const fenced = await readStockNeedsSnapshotWithFence(
      context.supabase,
      { uploadBatchId: filters.uploadBatchId },
      () => context.supabase!.rpc(STOCK_NEEDS_RPC, {
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
      durationMs: Date.now() - startedAt,
      metadata: {
        rpcName: STOCK_NEEDS_RPC,
        stage: "response",
        preStatus: fenced.before.status,
        postStatus: fenced.after.status,
        summaryStatus: fenced.after.status,
        currentVersion: fenced.after.currentVersion,
        requiredVersion: fenced.after.requiredVersion,
        rpcDurationMs: fenced.rpcDurationMs,
        totalDurationMs: Date.now() - startedAt,
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
      const expectedHttp = summaryUnavailableHttpStatus(error.state);
      await logger.warn({
        ...logContext,
        action: `stock_needs_summary_${error.reason}`,
        message: "Stock needs summary is unavailable at a readiness fence.",
        status: "failed",
        statusCode: expectedHttp,
        durationMs: Date.now() - startedAt,
        metadata: {
          internalCode: "STOCK_NEEDS_READINESS_CHANGED",
          rpcName: STOCK_NEEDS_RPC,
          stage: error.reason,
          preStatus: error.before?.status ?? (error.reason === "pre_read" ? error.state.status : null),
          postStatus: error.after?.status ?? null,
          summaryStatus: error.state.status,
          currentVersion: error.state.currentVersion,
          requiredVersion: error.state.requiredVersion,
          rpcDurationMs: error.rpcDurationMs,
          totalDurationMs: Date.now() - startedAt,
          pendingCount: error.state.pendingCount,
          totalScopes: error.state.totalScopes,
          reason: error.reason,
          expectedHttp,
          retryable: error.state.retryable,
          scopedUpload: Boolean(filters.uploadBatchId)
        }
      });
      return NextResponse.json(summaryUnavailablePayload(error.state), {
        status: summaryUnavailableHttpStatus(error.state),
        headers: summaryResponseHeaders(error.state)
      });
    }
    if (isSummaryDataReadError(error)) {
      const internalCode = error.kind === "rpc"
        ? "STOCK_NEEDS_RPC_FAILED"
        : error.kind === "transport"
          ? "STOCK_NEEDS_TRANSPORT_FAILED"
          : "STOCK_NEEDS_DATA_SHAPE_INVALID";
      await logger.error({
        ...logContext,
        action: error.kind === "shape"
          ? "stock_needs_data_shape_invalid"
          : error.kind === "transport"
            ? "stock_needs_transport_failed"
            : "stock_needs_rpc_failed",
        message: error.message,
        status: "failed",
        statusCode: 500,
        durationMs: Date.now() - startedAt,
        metadata: {
          internalCode,
          dbCode: error.dbCode,
          errorCategory: error.category,
          errorClass: error.errorClass,
          detailsPresent: error.detailsPresent,
          hintPresent: error.hintPresent,
          rpcName: STOCK_NEEDS_RPC,
          stage: error.stage,
          preStatus: error.before?.status ?? null,
          postStatus: error.after?.status ?? null,
          currentVersion: error.after?.currentVersion ?? error.before?.currentVersion ?? null,
          requiredVersion: error.after?.requiredVersion ?? error.before?.requiredVersion ?? null,
          rpcDurationMs: error.rpcDurationMs,
          totalDurationMs: Date.now() - startedAt,
          expectedHttp: 500,
          retryable: error.retryable
        },
        error
      });
      return NextResponse.json({ error: "Unable to load stock and needs." }, { status: 500 });
    }
    await logger.error({
      ...logContext,
      action: "stock_needs_unexpected_failure",
      message: "Unexpected stock needs summary read failure.",
      status: "failed",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      metadata: {
        internalCode: "STOCK_NEEDS_UNEXPECTED_FAILURE",
        rpcName: STOCK_NEEDS_RPC,
        stage: "unknown",
        preStatus: null,
        postStatus: null,
        currentVersion: null,
        requiredVersion: null,
        rpcDurationMs: null,
        totalDurationMs: Date.now() - startedAt,
        expectedHttp: 500,
        retryable: false
      },
      error
    });
    return NextResponse.json({ error: "Unable to load stock and needs." }, { status: 500 });
  }
}
