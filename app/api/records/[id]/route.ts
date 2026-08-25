import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { redactSensitiveFieldsForRole } from "@/lib/security/permissions";
import { businessRecordReadContract } from "@/lib/security/business-records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ record: null }, { status: 404 });
  const id = (await params).id;
  if (!UUID.test(id)) return NextResponse.json({ error: "Record not found." }, { status: 404 });

  const contract = businessRecordReadContract(context.profile.role);
  const { data, error } = await context.supabase
    .from(contract.table)
    .select(contract.select)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to load record detail." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Record not found." }, { status: 404 });
  return NextResponse.json({
    record: redactSensitiveFieldsForRole(data, context.profile.role)
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
