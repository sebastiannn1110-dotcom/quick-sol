import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  if (context.isDemoMode) return NextResponse.json({ errors: [] });

  const { data, error } = await context.supabase!
    .from("import_errors")
    .select("*, upload_batches(original_file_name,uploaded_by), upload_sheets(sheet_name)")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) return NextResponse.json({ error: "Unable to load import errors." }, { status: 500 });
  return NextResponse.json({ errors: data ?? [] });
}
