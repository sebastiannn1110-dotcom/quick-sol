import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";
import { BUSINESS_RECORDS_COMMERCIAL_VIEW, IMPORT_ERRORS_SAFE_VIEW } from "@/lib/security/business-records";
import { scopeElectronicPartsDemoEmployees } from "@/lib/demo/employee-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query")?.trim() ?? "";
  if (!query) return NextResponse.json({ records: [], uploads: [], employees: [], errors: [] });
  if (context.isDemoMode) return NextResponse.json({ records: [], uploads: [], employees: [], errors: [] });

  const pattern = `%${query.replace(/[%_]/g, "")}%`;
  const [records, uploads, employees, errors] = await Promise.all([
    context.supabase!
      .from(BUSINESS_RECORDS_COMMERCIAL_VIEW)
      .select("id,category,customer,supplier,supplier_name,mpn,mpn_quoted,po,description,created_at,profiles,upload_batches")
      .is("archived_at", null)
      .or(`mpn.ilike.${pattern},mpn_quoted.ilike.${pattern},supplier.ilike.${pattern},supplier_name.ilike.${pattern},customer.ilike.${pattern},po.ilike.${pattern},description.ilike.${pattern}`)
      .limit(20),
    context.supabase!
      .from("upload_batches")
      .select("id, original_file_name, detected_category, status, created_at, profiles(full_name,email)")
      .or(`original_file_name.ilike.${pattern},detected_category.ilike.${pattern},notes.ilike.${pattern}`)
      .limit(20),
    context.supabase!
      .from("profiles")
      .select("id, full_name, email, role, department, region, bio, avatar_path, is_active")
      .or(`full_name.ilike.${pattern},email.ilike.${pattern},department.ilike.${pattern},region.ilike.${pattern}`)
      .limit(20),
    context.supabase!
      .from(IMPORT_ERRORS_SAFE_VIEW)
      .select("id,upload_batch_id,row_index,column_name,error_type,message,severity,created_at,upload_batches")
      .or(`column_name.ilike.${pattern},error_type.ilike.${pattern},message.ilike.${pattern}`)
      .limit(20)
  ]);

  const firstError = records.error ?? uploads.error ?? employees.error ?? errors.error;
  if (firstError) return NextResponse.json({ error: "Unable to search admin data." }, { status: 500 });

  return NextResponse.json({
    records: records.data ?? [],
    uploads: uploads.data ?? [],
    employees: scopeElectronicPartsDemoEmployees(employees.data ?? []),
    errors: errors.data ?? []
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
