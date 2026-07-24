import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireRole(request, ["admin", "manager"]);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ uploads: [] });

  const { data, error } = await context.supabase
    .from("upload_batches")
    .select("id,original_file_name,detected_category,status,created_at")
    .is("archived_at", null)
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: "Unable to load available uploads." }, { status: 500 });
  return NextResponse.json({ uploads: data ?? [] });
}
