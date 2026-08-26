import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { canAssignClientUploads } from "@/lib/security/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!canAssignClientUploads(context.profile.role)) {
    return NextResponse.json({ error: "You do not have permission to assign uploads." }, { status: 403 });
  }
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ clients: [] });

  const { data, error } = await context.supabase
    .from("clients")
    .select("id,name")
    .eq("status", "active")
    .is("archived_at", null)
    .order("name", { ascending: true })
    .limit(200);

  if (error) return NextResponse.json({ error: "Unable to load upload clients." }, { status: 500 });
  return NextResponse.json({ clients: data ?? [] }, {
    headers: { "Cache-Control": "private, no-store, max-age=0" }
  });
}
