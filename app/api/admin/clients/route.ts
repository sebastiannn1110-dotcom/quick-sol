import { NextResponse } from "next/server";
import { logAuditEvent, requireRole } from "@/lib/auth/context";
import { parseClientWriteInput } from "@/lib/clients/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = await requireRole(request, ["admin", "manager"]);
  if (context instanceof NextResponse) return context;
  const input = parseClientWriteInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "Client data is invalid." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ client: { id: crypto.randomUUID(), ...input, status: "active" }, demo: true }, { status: 201 });
  }

  const { data, error } = await context.supabase
    .from("clients")
    .insert({
      name: input.name,
      description: input.description,
      industry: input.industry,
      region: input.region,
      website: input.website,
      created_by: context.profile.id,
      updated_by: context.profile.id
    })
    .select("id,name,description,industry,region,website,status,created_at,updated_at")
    .single();

  if (error) return NextResponse.json({ error: "Unable to create client." }, { status: 500 });
  await logAuditEvent(context, "client_created", "client", data.id);
  return NextResponse.json({ client: data }, { status: 201 });
}
