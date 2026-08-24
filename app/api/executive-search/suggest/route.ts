import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { z } from "zod";
import { businessRecordReadContract, permittedRecordSearchColumns } from "@/lib/security/business-records";
import { canViewCustomerDetails, canViewSupplierDetails } from "@/lib/security/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Suggestion {
  type: string;
  label: string;
  value: string;
  href: string;
  detail?: string;
}

function like(value: string) {
  return `%${value.replace(/[%_,()]/g, "")}%`;
}

const querySchema = z.string().trim().min(2).max(80);
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function uniqueSuggestions(items: Suggestion[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.value}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const rate = checkRateLimit({ key: `executive-suggest:${context.profile.id}`, limit: 120, windowMs: 60 * 1000 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const { searchParams } = new URL(request.url);
  const parsedQuery = querySchema.safeParse(searchParams.get("q") ?? "");
  if (!parsedQuery.success) {
    return NextResponse.json({ query: "", groups: {} }, { headers: PRIVATE_HEADERS });
  }
  const q = parsedQuery.data;

  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ query: q, groups: {} }, { headers: PRIVATE_HEADERS });
  }

  const pattern = like(q);
  const contract = businessRecordReadContract(context.profile.role);
  const searchColumns = permittedRecordSearchColumns(context.profile.role)
    .filter((column) => !["po", "comments"].includes(column));
  const selectedColumns = ["mpn", "mpn_quoted", "category"];
  if (canViewSupplierDetails(context.profile.role)) selectedColumns.push("supplier", "supplier_name");
  if (canViewCustomerDetails(context.profile.role)) selectedColumns.push("customer", "client");
  const recordsResult = await context.supabase
    .from(contract.table)
    .select(selectedColumns.join(","))
    .is("archived_at", null)
    .or(searchColumns.map((column) => `${column}.ilike.${pattern}`).join(","))
    .limit(12);

  if (recordsResult.error) {
    await logger.warn({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "api",
      action: "executive_suggestions_failed",
      message: "Executive search suggestions failed.",
      status: "failed",
      error: recordsResult.error
    });
    return NextResponse.json({ error: "Unable to load suggestions." }, { status: 500, headers: PRIVATE_HEADERS });
  }

  const records = (recordsResult.data ?? []) as unknown as Array<{
    mpn?: string | null;
    mpn_quoted?: string | null;
    supplier?: string | null;
    supplier_name?: string | null;
    customer?: string | null;
    client?: string | null;
    category?: string | null;
  }>;
  const groups = {
    mpn: uniqueSuggestions(
      records
        .flatMap((record) => [record.mpn, record.mpn_quoted])
        .filter(Boolean)
        .map((mpn) => ({
          type: "mpn",
          label: String(mpn),
          value: String(mpn),
          href: `/mpn-comparator?mpn=${encodeURIComponent(String(mpn))}`,
          detail: "Compare prices"
        }))
    ).slice(0, 6),
    supplier: canViewSupplierDetails(context.profile.role) ? uniqueSuggestions(
      records
        .flatMap((record) => [record.supplier_name, record.supplier])
        .filter(Boolean)
        .map((supplier) => ({
          type: "supplier",
          label: String(supplier),
          value: String(supplier),
          href: `/executive-search?q=${encodeURIComponent(String(supplier))}`,
          detail: "Supplier"
        }))
    ).slice(0, 6) : [],
    customer: canViewCustomerDetails(context.profile.role) ? uniqueSuggestions(
      records
        .flatMap((record) => [record.customer, record.client])
        .filter(Boolean)
        .map((customer) => ({
          type: "customer",
          label: String(customer),
          value: String(customer),
          href: `/executive-search?q=${encodeURIComponent(String(customer))}`,
          detail: "Customer"
        }))
    ).slice(0, 6) : [],
    po: [],
    employee: [],
    upload: [],
    category: uniqueSuggestions(
      records
        .map((record) => record.category)
        .filter(Boolean)
        .map((category) => ({
          type: "category",
          label: String(category),
          value: String(category),
          href: `/executive-search?q=${encodeURIComponent(String(category))}`,
          detail: "Category"
        }))
    ).slice(0, 5),
    error: [],
    financial: []
  };

  return NextResponse.json({ query: q, groups }, { headers: PRIVATE_HEADERS });
}
