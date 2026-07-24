import { NextResponse } from "next/server";
import { logAuditEvent, requireRole } from "@/lib/auth/context";
import { isUuid, parseClientWriteInput } from "@/lib/clients/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const context = await requireRole(request, ["admin", "manager"]);
  if (context instanceof NextResponse) return context;
  const { clientId } = await params;
  if (!isUuid(clientId)) return NextResponse.json({ error: "Invalid client id." }, { status: 400 });
  const body = await request.json().catch(() => null);
  const input = parseClientWriteInput(body);
  if (!input) return NextResponse.json({ error: "Client data is invalid." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ client: { id: clientId, ...input }, demo: true });

  const { data, error } = await context.supabase
    .from("clients")
    .update({
      name: input.name,
      description: input.description,
      industry: input.industry,
      region: input.region,
      website: input.website,
      updated_by: context.profile.id
    })
    .eq("id", clientId)
    .select("id,name,description,industry,region,website,status,created_at,updated_at")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Unable to update client." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Client not found or outside your scope." }, { status: 404 });
  await logAuditEvent(context, "client_updated", "client", clientId);
  return NextResponse.json({ client: data });
}
