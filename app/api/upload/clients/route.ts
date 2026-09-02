import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { canAssignClientUploads } from "@/lib/security/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEMO_CLIENT_COUNT = 19;

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
    .like("external_customer_id", "DEMO-%")
    .eq("status", "active")
    .is("archived_at", null)
    .order("name", { ascending: true })
    .limit(DEMO_CLIENT_COUNT + 1);

  if (error) return NextResponse.json({ error: "Unable to load upload clients." }, { status: 500 });
  const clients = data ?? [];
  if (clients.length !== DEMO_CLIENT_COUNT) {
    return NextResponse.json({ error: "Demo upload client scope is incomplete." }, { status: 500 });
  }
  return NextResponse.json({ clients }, {
    headers: { "Cache-Control": "private, no-store, max-age=0" }
  });
}
