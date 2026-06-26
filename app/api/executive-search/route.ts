import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { parseExecutiveQuery, type NumericFilter } from "@/lib/search/executive-query-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const searchSchema = z.object({
  query: z.string().trim().min(1).max(300),
  filters: z.record(z.string(), z.unknown()).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0)
});

function like(value: string) {
  return `%${value.replace(/[%_]/g, "")}%`;
}

function applyNumeric<T>(query: T, column: string, filter?: NumericFilter): T {
  if (!filter) return query;
  const builder = query as {
    gt(column: string, value: number): T;
    gte(column: string, value: number): T;
    lt(column: string, value: number): T;
    lte(column: string, value: number): T;
    eq(column: string, value: number): T;
  };
  if (filter.operator === "gt") return builder.gt(column, filter.value);
  if (filter.operator === "gte") return builder.gte(column, filter.value);
  if (filter.operator === "lt") return builder.lt(column, filter.value);
  if (filter.operator === "lte") return builder.lte(column, filter.value);
  return builder.eq(column, filter.value);
}

function buildSummaryText(parsed: ReturnType<typeof parseExecutiveQuery>, counts: { records: number; uploads: number; errors: number; users: number }) {
  const parts = [
    `${counts.records} records`,
    `${counts.uploads} uploads`,
    `${counts.errors} import errors`,
    `${counts.users} users`
  ];
  const filters = parsed.detectedTerms.length ? `Detected filters: ${parsed.detectedTerms.join(", ")}.` : "No structured filters were detected.";
  return `${parts.join(", ")} found. ${filters}`;
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const rate = checkRateLimit({ key: `executive-search:${context.profile.id}`, limit: 60, windowMs: 60 * 1000 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const body = await request.json().catch(() => null);
  const parsedBody = searchSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid search request.", issues: parsedBody.error.flatten() }, { status: 400 });
  }

  const { query, limit, offset } = parsedBody.data;
  const parsed = parseExecutiveQuery(query);

  await logger.info({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "api",
    action: "executive_search_started",
    message: "Executive search started.",
    status: "started",
    metadata: { query, intent: parsed.intent, filters: parsed.filters }
  });

  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({
      query,
      interpretedFilters: parsed,
      summary: { totalResults: 0, recordsCount: 0, uploadsCount: 0, errorsCount: 0, usersCount: 0 },
      results: { records: [], uploads: [], errors: [], users: [] },
      aiSummary: "Demo mode has no live Supabase data for executive search."
    });
  }

  const filters = parsed.filters;
  let employeeIds: string[] = [];
  if (filters.employee) {
    const employeeResult = await context.supabase
      .from("profiles")
      .select("id")
      .or(`full_name.ilike.${like(filters.employee)},email.ilike.${like(filters.employee)}`)
      .limit(20);
    employeeIds = (employeeResult.data ?? []).map((employee) => employee.id);
  }

  let recordsQuery = context.supabase
    .from("business_records")
    .select("*, profiles(full_name,email,department,region,role), upload_batches(original_file_name,detected_category,status,created_at)", { count: "exact" })
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (filters.mpn) recordsQuery = recordsQuery.or(`mpn.ilike.${like(filters.mpn)},mpn_quoted.ilike.${like(filters.mpn)}`);
  if (filters.customer) recordsQuery = recordsQuery.or(`customer.ilike.${like(filters.customer)},client.ilike.${like(filters.customer)}`);
  if (filters.supplier) recordsQuery = recordsQuery.or(`supplier.ilike.${like(filters.supplier)},supplier_name.ilike.${like(filters.supplier)}`);
  if (filters.po) recordsQuery = recordsQuery.ilike("po", like(filters.po));
  if (filters.category) recordsQuery = recordsQuery.eq("category", filters.category);
  if (filters.country) recordsQuery = recordsQuery.ilike("shipping_point_country", like(filters.country));
  if (filters.hasErrors) recordsQuery = recordsQuery.eq("has_errors", true);
  if (filters.missingMpn) recordsQuery = recordsQuery.is("mpn", null);
  if (employeeIds.length) recordsQuery = recordsQuery.in("uploaded_by", employeeIds);
  if (filters.dateRange?.from) recordsQuery = recordsQuery.gte("created_at", filters.dateRange.from);
  if (filters.dateRange?.to) recordsQuery = recordsQuery.lte("created_at", `${filters.dateRange.to}T23:59:59.999Z`);
  recordsQuery = applyNumeric(recordsQuery, "gp_rate", filters.gpRate);
  recordsQuery = applyNumeric(recordsQuery, "price", filters.price);
  recordsQuery = applyNumeric(recordsQuery, "qty", filters.qty);
  if (filters.leadTimeDays) {
    recordsQuery = applyNumeric(recordsQuery, "lead_time_weeks", {
      ...filters.leadTimeDays,
      value: Number((filters.leadTimeDays.value / 7).toFixed(3))
    });
  }
  if (filters.text && !parsed.detectedTerms.length) recordsQuery = recordsQuery.textSearch("searchable_text", filters.text, { type: "websearch" });

  let uploadsQuery = context.supabase
    .from("upload_batches")
    .select("*, profiles(full_name,email,department,region,role)", { count: "exact" })
    .order("created_at", { ascending: false });
  if (filters.employee && employeeIds.length) uploadsQuery = uploadsQuery.in("uploaded_by", employeeIds);
  if (filters.category) uploadsQuery = uploadsQuery.eq("detected_category", filters.category);
  if (filters.uploadErrorThreshold) uploadsQuery = applyNumeric(uploadsQuery, "error_count", filters.uploadErrorThreshold);
  if (filters.dateRange?.from) uploadsQuery = uploadsQuery.gte("created_at", filters.dateRange.from);
  if (filters.dateRange?.to) uploadsQuery = uploadsQuery.lte("created_at", `${filters.dateRange.to}T23:59:59.999Z`);
  if (filters.text && !filters.employee && !filters.uploadErrorThreshold) uploadsQuery = uploadsQuery.ilike("original_file_name", like(filters.text));

  let errorsQuery = context.supabase
    .from("import_errors")
    .select("*, upload_batches(original_file_name,uploaded_by), upload_sheets(sheet_name)", { count: "exact" })
    .order("created_at", { ascending: false });
  if (filters.errorField) errorsQuery = errorsQuery.or(`column_name.ilike.${like(filters.errorField)},message.ilike.${like(filters.errorField)},error_type.ilike.${like(filters.errorField)}`);
  if (filters.hasErrors && filters.text && !filters.errorField) errorsQuery = errorsQuery.or(`error_type.ilike.${like(filters.text)},column_name.ilike.${like(filters.text)},message.ilike.${like(filters.text)}`);
  if (filters.dateRange?.from) errorsQuery = errorsQuery.gte("created_at", filters.dateRange.from);
  if (filters.dateRange?.to) errorsQuery = errorsQuery.lte("created_at", `${filters.dateRange.to}T23:59:59.999Z`);

  let usersQuery = context.supabase
    .from("profiles")
    .select("*", { count: "exact" })
    .order("full_name", { ascending: true });
  if (filters.employee) usersQuery = usersQuery.or(`full_name.ilike.${like(filters.employee)},email.ilike.${like(filters.employee)}`);
  else if (parsed.intent === "users" && filters.text) usersQuery = usersQuery.or(`full_name.ilike.${like(filters.text)},email.ilike.${like(filters.text)},department.ilike.${like(filters.text)}`);
  else usersQuery = usersQuery.limit(0);

  const [recordsResult, uploadsResult, errorsResult, usersResult] = await Promise.all([
    recordsQuery.range(offset, offset + limit - 1),
    uploadsQuery.range(offset, offset + limit - 1),
    errorsQuery.range(offset, offset + limit - 1),
    usersQuery.range(offset, offset + limit - 1)
  ]);

  const firstError = recordsResult.error ?? uploadsResult.error ?? errorsResult.error ?? usersResult.error;
  if (firstError) {
    await logger.error({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "api",
      action: "executive_search_failed",
      message: "Executive search failed.",
      status: "failed",
      error: firstError,
      metadata: { query, intent: parsed.intent }
    });
    return NextResponse.json({ error: "Executive search failed." }, { status: 500 });
  }

  const counts = {
    records: recordsResult.count ?? 0,
    uploads: uploadsResult.count ?? 0,
    errors: errorsResult.count ?? 0,
    users: usersResult.count ?? 0
  };
  const totalResults = counts.records + counts.uploads + counts.errors + counts.users;

  await logger.info({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "api",
    action: "executive_search_completed",
    message: "Executive search completed.",
    status: "completed",
    metadata: { query, intent: parsed.intent, totalResults }
  });

  return NextResponse.json({
    query,
    interpretedFilters: parsed,
    summary: {
      totalResults,
      recordsCount: counts.records,
      uploadsCount: counts.uploads,
      errorsCount: counts.errors,
      usersCount: counts.users
    },
    results: {
      records: recordsResult.data ?? [],
      uploads: uploadsResult.data ?? [],
      errors: errorsResult.data ?? [],
      users: usersResult.data ?? []
    },
    aiSummary: buildSummaryText(parsed, counts)
  });
}
