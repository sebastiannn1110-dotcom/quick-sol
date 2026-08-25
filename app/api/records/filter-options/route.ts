import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ employees: [] });
  const { data, error } = await context.supabase
    .from("profiles")
    .select("id,full_name,email,role,department,region,is_active,created_at,updated_at")
    .eq("is_active", true)
    .order("full_name");
  if (error) return NextResponse.json({ error: "Unable to load record filters." }, { status: 500 });
  return NextResponse.json({ employees: data ?? [] }, {
    headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" }
  });
}
