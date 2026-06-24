import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";
import { measureAsync } from "@/lib/logger/performance";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { safeQuery } from "@/lib/supabase/supabase-safe";
import { recordsFilterSchema } from "@/lib/excel/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function applyDemoFilters(records: Awaited<ReturnType<typeof getDemoPlatformData>>["records"], filters: ReturnType<typeof recordsFilterSchema.parse>) {
  return records.filter((record) => {
    const text = [
      record.searchable_text,
      record.customer,
      record.client,
      record.supplier,
      record.supplier_name,
      record.mpn,
      record.mpn_quoted,
      record.manufacturer,
      record.clean_mfg,
      record.po,
      record.description,
      record.generic,
      record.comments
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (filters.query && !text.includes(filters.query.toLowerCase())) return false;
    if (filters.category && record.category !== filters.category) return false;
    if (filters.uploadedBy && record.uploaded_by !== filters.uploadedBy) return false;
    if (filters.customer && !(record.customer ?? record.client ?? "").toLowerCase().includes(filters.customer.toLowerCase())) return false;
    if (filters.supplier && !(record.supplier_name ?? record.supplier ?? "").toLowerCase().includes(filters.supplier.toLowerCase())) return false;
    if (filters.mpn && !(record.mpn ?? record.mpn_quoted ?? "").toLowerCase().includes(filters.mpn.toLowerCase())) return false;
    if (filters.manufacturer && !(record.manufacturer ?? record.clean_mfg ?? "").toLowerCase().includes(filters.manufacturer.toLowerCase())) return false;
    if (filters.po && !(record.po ?? "").toLowerCase().includes(filters.po.toLowerCase())) return false;
    if (filters.country && !(record.shipping_point_country ?? "").toLowerCase().includes(filters.country.toLowerCase())) return false;
    if (filters.department && record.profiles?.department !== filters.department) return false;
    if (filters.region && record.profiles?.region !== filters.region) return false;
    if (filters.hasErrors && String(record.has_errors) !== filters.hasErrors) return false;
    if (filters.costMin !== undefined && Number(record.cost ?? 0) < filters.costMin) return false;
    if (filters.costMax !== undefined && Number(record.cost ?? 0) > filters.costMax) return false;
    if (filters.priceMin !== undefined && Number(record.price ?? 0) < filters.priceMin) return false;
    if (filters.priceMax !== undefined && Number(record.price ?? 0) > filters.priceMax) return false;
    if (filters.qtyMin !== undefined && Number(record.qty ?? record.req_qty ?? 0) < filters.qtyMin) return false;
    if (filters.qtyMax !== undefined && Number(record.qty ?? record.req_qty ?? 0) > filters.qtyMax) return false;
    if (filters.gpRateMin !== undefined && Number(record.gp_rate ?? 0) < filters.gpRateMin) return false;
    if (filters.gpRateMax !== undefined && Number(record.gp_rate ?? 0) > filters.gpRateMax) return false;
    return true;
  });
}

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
    key: `records:${context.profile.id}`,
    limit: 120,
    windowMs: 60 * 1000
  });
  if (!rate.allowed) {
    await logger.security({
      ...logContext,
      module: "security",
      action: "rate_limit_triggered",
      message: "Records rate limit was triggered.",
      status: "failed",
      metadata: { resetAt: rate.resetAt }
    });
    return rateLimitResponse(rate.resetAt);
  }

  const { searchParams } = new URL(request.url);
  const parsedFilters = recordsFilterSchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsedFilters.success) {
    await logger.warn({
      ...logContext,
      module: "records",
      action: "records_filter_validation_failed",
      message: "Records filter validation failed.",
      status: "failed",
      metadata: parsedFilters.error.flatten()
    });
    return NextResponse.json({ error: "Invalid record filters." }, { status: 400 });
  }
  const filters = parsedFilters.data;
  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;
  const filterMetadata = {
    page: filters.page,
    pageSize: filters.pageSize,
    activeFilters: Object.entries(filters)
      .filter(([, value]) => value !== undefined && value !== "" && value !== null)
      .map(([key]) => key)
  };

  if (context.isDemoMode) {
    const result = await measureAsync(
      "records_query",
      "records",
      logContext,
      async () => {
        const data = await getDemoPlatformData();
        const filtered = applyDemoFilters(data.records, filters);
        return {
          records: filtered.slice(from, to + 1),
          employees: data.profiles,
          count: filtered.length,
          page: filters.page,
          pageSize: filters.pageSize
        };
      },
      { ...filterMetadata, source: "demo" },
      { slowAction: "slow_query_detected" }
    );
    return NextResponse.json(result);
  }

  let query = context.supabase!
    .from("business_records")
    .select("*, profiles(full_name,email,department,region,role), upload_batches(original_file_name,detected_category,status)", {
      count: "exact"
    })
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (filters.query) query = query.textSearch("searchable_text", filters.query, { type: "websearch" });
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.uploadedBy) query = query.eq("uploaded_by", filters.uploadedBy);
  if (filters.customer) query = query.ilike("customer", `%${filters.customer}%`);
  if (filters.supplier) query = query.or(`supplier.ilike.%${filters.supplier}%,supplier_name.ilike.%${filters.supplier}%`);
  if (filters.mpn) query = query.or(`mpn.ilike.%${filters.mpn}%,mpn_quoted.ilike.%${filters.mpn}%`);
  if (filters.manufacturer) query = query.or(`manufacturer.ilike.%${filters.manufacturer}%,clean_mfg.ilike.%${filters.manufacturer}%`);
  if (filters.lineId) query = query.ilike("line_id", `%${filters.lineId}%`);
  if (filters.po) query = query.ilike("po", `%${filters.po}%`);
  if (filters.country) query = query.ilike("shipping_point_country", `%${filters.country}%`);
  if (filters.hasErrors) query = query.eq("has_errors", filters.hasErrors === "true");
  if (filters.gpRateMin !== undefined) query = query.gte("gp_rate", filters.gpRateMin);
  if (filters.gpRateMax !== undefined) query = query.lte("gp_rate", filters.gpRateMax);
  if (filters.costMin !== undefined) query = query.gte("cost", filters.costMin);
  if (filters.costMax !== undefined) query = query.lte("cost", filters.costMax);
  if (filters.priceMin !== undefined) query = query.gte("price", filters.priceMin);
  if (filters.priceMax !== undefined) query = query.lte("price", filters.priceMax);
  if (filters.qtyMin !== undefined) query = query.gte("qty", filters.qtyMin);
  if (filters.qtyMax !== undefined) query = query.lte("qty", filters.qtyMax);
  if (filters.uploadDateFrom) query = query.gte("created_at", filters.uploadDateFrom);
  if (filters.uploadDateTo) query = query.lte("created_at", `${filters.uploadDateTo}T23:59:59.999Z`);

  query = query.range(from, to);

  try {
    const [{ data: records, error, count }, { data: employees, error: employeesError }] = await measureAsync(
      "records_query",
      "records",
      logContext,
      async () => {
        const [recordsResult, employeesResult] = await Promise.all([
          safeQuery<unknown[]>(
            "business_records",
            logContext,
            () => query,
            { ...filterMetadata, range: { from, to } }
          ),
          safeQuery<unknown[]>(
            "profiles",
            logContext,
            () => context.supabase!.from("profiles").select("*").order("full_name"),
            { orderBy: "full_name", scope: "record_filters" }
          )
        ]);
        if (recordsResult.error) throw recordsResult.error;
        if (employeesResult.error) throw employeesResult.error;
        return [recordsResult, employeesResult] as const;
      },
      filterMetadata,
      { slowAction: "slow_query_detected" }
    );

    if (error || employeesError) throw error ?? employeesError;

    await logger.info({
      ...logContext,
      module: "records",
      action: "records_query_completed",
      message: "Records page query completed.",
      status: "completed",
      metadata: { ...filterMetadata, count: count ?? 0 }
    });

    return NextResponse.json({
      records: records ?? [],
      employees: employees ?? [],
      count: count ?? 0,
      page: filters.page,
      pageSize: filters.pageSize
    });
  } catch (error) {
    await logger.error({
      ...logContext,
      module: "records",
      action: "records_query_failed",
      message: "Unable to load records.",
      status: "failed",
      error,
      metadata: filterMetadata
    });
    return NextResponse.json({ error: "Unable to load records." }, { status: 500 });
  }
}
