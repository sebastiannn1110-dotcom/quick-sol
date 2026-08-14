import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { redactSensitiveFieldsForRole } from "@/lib/security/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_DETAIL_SELECT = [
  "id", "upload_batch_id", "upload_sheet_id", "uploaded_by", "category", "row_index",
  "raw_data", "normalized_data", "has_errors", "errors", "created_at",
  "line_id", "client", "customer", "supplier", "supplier_name", "mpn", "mpn_quoted",
  "manufacturer", "clean_mfg", "description", "generic", "po", "qty", "req_qty", "cost",
  "price", "total_price", "gp_rate", "gp", "commission", "potential_amount_usd",
  "target_to_vendor", "best_price_offered", "date_code", "moq", "spq", "on_hand",
  "lead_time_weeks", "transit_time_weeks", "earliest_shipping_date",
  "shipping_point_country", "delivery_point", "comments"
].join(",");

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ record: null }, { status: 404 });
  const id = (await params).id;
  if (!UUID.test(id)) return NextResponse.json({ error: "Record not found." }, { status: 404 });

  const { data, error } = await context.supabase
    .from("business_records")
    .select(RECORD_DETAIL_SELECT)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to load record detail." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Record not found." }, { status: 404 });
  return NextResponse.json({
    record: redactSensitiveFieldsForRole(data, context.profile.role)
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
