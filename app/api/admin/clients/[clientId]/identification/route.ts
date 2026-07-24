import { NextResponse } from "next/server";
import { logAuditEvent, requireRole } from "@/lib/auth/context";
import { validateClientImage } from "@/lib/clients/assets";
import { isUuid } from "@/lib/clients/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const context = await requireRole(request, ["admin", "manager"]);
  if (context instanceof NextResponse) return context;
  const { clientId } = await params;
  if (!isUuid(clientId)) return NextResponse.json({ error: "Invalid client id." }, { status: 400 });
  const image = validateClientImage((await request.formData()).get("file"));
  if ("error" in image) return NextResponse.json({ error: image.error }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true, demo: true });

  const { data: client } = await context.supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return NextResponse.json({ error: "Client not found or outside your scope." }, { status: 404 });

  const path = `${clientId}/identification/${Date.now()}-identification.${image.extension}`;
  const { error: uploadError } = await context.supabase.storage
    .from("client-assets")
    .upload(path, await image.file.arrayBuffer(), { contentType: image.file.type, upsert: false });
  if (uploadError) return NextResponse.json({ error: "Unable to upload client identification image." }, { status: 500 });

  const { error } = await context.supabase
    .from("client_private_details")
    .upsert({
      client_id: clientId,
      identification_image_path: path,
      updated_by: context.profile.id,
      updated_at: new Date().toISOString()
    }, { onConflict: "client_id" });
  if (error) return NextResponse.json({ error: "Image uploaded but private details could not be updated." }, { status: 500 });

  await logAuditEvent(context, "client_identification_updated", "client", clientId);
  return NextResponse.json({ ok: true, clientId });
}
