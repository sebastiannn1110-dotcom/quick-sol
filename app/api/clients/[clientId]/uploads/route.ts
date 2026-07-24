import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { getClientDetail, listClientUploads } from "@/lib/clients/data-source";
import { isUuid } from "@/lib/clients/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { clientId } = await params;
  if (!isUuid(clientId)) return NextResponse.json({ error: "Invalid client id." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ uploads: [] });

  try {
    const client = await getClientDetail(context.supabase, context.profile.role, clientId);
    if (!client) return NextResponse.json({ error: "Client not found or outside your scope." }, { status: 404 });
    return NextResponse.json({ uploads: await listClientUploads(context.supabase, clientId) });
  } catch {
    return NextResponse.json({ error: "Unable to load client uploads." }, { status: 500 });
  }
}
