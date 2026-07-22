import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/context";
import { loadStockNeedsInput } from "@/lib/stock-needs/data-source";
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
  const coverageStatus = rawCoverage && COVERAGE_STATUSES.has(rawCoverage as CoverageStatus) ? rawCoverage as CoverageStatus : null;
  return {
    q: cleanText(searchParams.get("q")),
    customer: cleanText(searchParams.get("customer")),
    supplier: cleanText(searchParams.get("supplier")),
    manufacturer: cleanText(searchParams.get("manufacturer")),
    status: cleanText(searchParams.get("status"), 60),
    coverageStatus,
    uploadBatchId: cleanUuid(searchParams.get("uploadBatchId")),
    limit: Math.min(Math.max(Number(searchParams.get("limit") ?? 50) || 50, 1), 200),
    offset: Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0)
  };
}

export async function GET(request: Request) {
  const context = await requireRole(request, ["admin", "manager"]);
  if (context instanceof NextResponse) return context;

  const filters = parseFilters(request);
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json(buildStockNeedsResult({ records: [], filters }));
  }

  try {
    const input = await loadStockNeedsInput(context.supabase, {
      filters,
      maxUploads: 20,
      recordsPerUploadLimit: filters.uploadBatchId ? 10000 : 5000
    });

    return NextResponse.json(buildStockNeedsResult({ records: input.records, profiles: input.profiles, importJobs: input.importJobs, filters }));
  } catch {
    return NextResponse.json({ error: "Unable to load stock and needs." }, { status: 500 });
  }
}
