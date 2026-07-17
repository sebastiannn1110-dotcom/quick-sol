import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/context";
import { buildStockNeedsResult, type CoverageStatus, type StockNeedsFilters, type StockNeedsImportJob, type StockNeedsProfile, type StockNeedsRecord } from "@/lib/stock-needs/stock-needs";

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

  const scanLimit = Math.min(Math.max((filters.offset ?? 0) + (filters.limit ?? 50), 500), 5000);
  let recordsQuery = context.supabase
    .from("business_records")
    .select("id,upload_batch_id,category,raw_data,normalized_data,has_errors,errors,mpn,mpn_quoted,customer,client,supplier,supplier_name,manufacturer,clean_mfg,qty,req_qty,on_hand,earliest_shipping_date,lead_time_weeks,upload_batches(original_file_name,detected_category,status,created_at)")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(scanLimit);

  if (filters.uploadBatchId) recordsQuery = recordsQuery.eq("upload_batch_id", filters.uploadBatchId);

  const recordsResult = await recordsQuery;
  if (recordsResult.error) return NextResponse.json({ error: "Unable to load stock and needs." }, { status: 500 });

  const records = (recordsResult.data ?? []) as unknown as StockNeedsRecord[];
  const uploadIds = Array.from(new Set(records.map((record) => record.upload_batch_id).filter(Boolean)));
  let profiles: StockNeedsProfile[] = [];
  let importJobs: StockNeedsImportJob[] = [];

  if (uploadIds.length) {
    const [profilesResult, jobsResult] = await Promise.all([
      context.supabase
        .from("file_schema_profiles")
        .select("upload_batch_id,detected_template,detected_mappings_json,column_count")
        .in("upload_batch_id", uploadIds),
      context.supabase
        .from("import_jobs")
        .select("upload_batch_id,status")
        .in("upload_batch_id", uploadIds)
        .order("updated_at", { ascending: false })
    ]);

    profiles = profilesResult.error ? [] : (profilesResult.data ?? []) as StockNeedsProfile[];
    importJobs = jobsResult.error ? [] : (jobsResult.data ?? []) as StockNeedsImportJob[];
  }

  return NextResponse.json(buildStockNeedsResult({ records, profiles, importJobs, filters }));
}
