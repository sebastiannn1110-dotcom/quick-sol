import { NextResponse } from "next/server";
import { logAuditEvent, requireRole } from "@/lib/auth/context";
import { isUuid } from "@/lib/clients/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const context = await requireRole(request, ["admin", "manager"]);
  if (context instanceof NextResponse) return context;
  const { clientId } = await params;
  if (!isUuid(clientId)) return NextResponse.json({ error: "Invalid client id." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true, demo: true });

  const archivedAt = new Date().toISOString();
  const { data, error } = await context.supabase
    .from("clients")
    .update({ status: "archived", archived_at: archivedAt, updated_by: context.profile.id })
    .eq("id", clientId)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to archive client." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Client not found or outside your scope." }, { status: 404 });
  await logAuditEvent(context, "client_archived", "client", clientId);
  return NextResponse.json({ ok: true, clientId, archivedAt });
}
