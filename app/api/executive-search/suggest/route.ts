import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";

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
  return `%${value.replace(/[%_]/g, "")}%`;
}

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
  const q = (searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) {
    return NextResponse.json({ query: q, groups: {} });
  }

  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ query: q, groups: {} });
  }

  const pattern = like(q);
  const [recordsResult, uploadsResult, usersResult, errorsResult] = await Promise.all([
    context.supabase
      .from("business_records")
      .select("id, mpn, mpn_quoted, supplier, supplier_name, customer, client, po, category, price, gp_rate")
      .is("archived_at", null)
      .or(`mpn.ilike.${pattern},mpn_quoted.ilike.${pattern},supplier.ilike.${pattern},supplier_name.ilike.${pattern},customer.ilike.${pattern},client.ilike.${pattern},po.ilike.${pattern},category.ilike.${pattern}`)
      .limit(12),
    context.supabase
      .from("upload_batches")
      .select("id, original_file_name, detected_category, error_count, profiles(full_name,email)")
      .or(`original_file_name.ilike.${pattern},detected_category.ilike.${pattern}`)
      .limit(8),
    context.supabase
      .from("profiles")
      .select("id, full_name, email, role, department")
      .or(`full_name.ilike.${pattern},email.ilike.${pattern},department.ilike.${pattern}`)
      .limit(8),
    context.supabase
      .from("import_errors")
      .select("id, upload_batch_id, error_type, column_name, message, severity")
      .or(`error_type.ilike.${pattern},column_name.ilike.${pattern},message.ilike.${pattern}`)
      .limit(8)
  ]);

  if (recordsResult.error || uploadsResult.error || usersResult.error || errorsResult.error) {
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
      error: recordsResult.error ?? uploadsResult.error ?? usersResult.error ?? errorsResult.error
    });
    return NextResponse.json({ error: "Unable to load suggestions." }, { status: 500 });
  }

  const records = recordsResult.data ?? [];
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
    supplier: uniqueSuggestions(
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
    ).slice(0, 6),
    customer: uniqueSuggestions(
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
    ).slice(0, 6),
    po: uniqueSuggestions(
      records
        .map((record) => record.po)
        .filter(Boolean)
        .map((po) => ({
          type: "po",
          label: String(po),
          value: String(po),
          href: `/executive-search?q=${encodeURIComponent(`PO ${po}`)}`,
          detail: "Purchase order"
        }))
    ).slice(0, 6),
    employee: uniqueSuggestions(
      (usersResult.data ?? []).map((user) => ({
        type: "employee",
        label: user.full_name,
        value: user.id,
        href: `/employees?employee=${encodeURIComponent(user.id)}`,
        detail: `${user.role}${user.department ? ` - ${user.department}` : ""}`
      }))
    ),
    upload: uniqueSuggestions(
      (uploadsResult.data ?? []).map((upload) => ({
        type: "upload",
        label: upload.original_file_name,
        value: upload.id,
        href: `/executive-search?q=${encodeURIComponent(upload.original_file_name)}`,
        detail: `${upload.detected_category ?? "Upload"} - ${upload.error_count ?? 0} errors`
      }))
    ),
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
    error: uniqueSuggestions(
      (errorsResult.data ?? []).map((error) => ({
        type: "error",
        label: error.error_type ?? error.column_name ?? "Import error",
        value: error.id,
        href: `/executive-search?q=${encodeURIComponent(error.error_type ?? error.column_name ?? q)}`,
        detail: error.message ?? error.severity ?? "Import error"
      }))
    ),
    financial: uniqueSuggestions(
      records
        .filter((record) => record.price !== null || record.gp_rate !== null)
        .map((record) => ({
          type: "financial",
          label: `${record.mpn ?? record.customer ?? "Record"} - ${record.price ?? "no price"}`,
          value: record.id,
          href: `/records?mpn=${encodeURIComponent(record.mpn ?? "")}`,
          detail: `GP ${record.gp_rate ?? "-"}`
        }))
    ).slice(0, 5)
  };

  return NextResponse.json({ query: q, groups });
}
