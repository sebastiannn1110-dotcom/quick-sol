import { NextResponse } from "next/server";
import { logAuditEvent, requireRole } from "@/lib/auth/context";
import { isUuid } from "@/lib/clients/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function scopedContext(request: Request, clientId: string) {
  const context = await requireRole(request, ["admin", "manager"]);
  if (context instanceof NextResponse) return context;
  if (!isUuid(clientId)) return NextResponse.json({ error: "Invalid client id." }, { status: 400 });
  return context;
}

export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const context = await scopedContext(request, clientId);
  if (context instanceof NextResponse) return context;
  const body = await request.json().catch(() => null) as { uploadBatchId?: string } | null;
  if (!isUuid(body?.uploadBatchId)) return NextResponse.json({ error: "Invalid upload id." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true, demo: true });

  const { data: upload } = await context.supabase
    .from("upload_batches")
    .select("id")
    .eq("id", body!.uploadBatchId!)
    .is("archived_at", null)
    .maybeSingle();
  if (!upload) return NextResponse.json({ error: "Upload not found or outside your scope." }, { status: 404 });

  const { error } = await context.supabase
    .from("client_upload_assignments")
    .upsert({
      client_id: clientId,
      upload_batch_id: body!.uploadBatchId!,
      assigned_by: context.profile.id,
      assigned_at: new Date().toISOString()
    }, { onConflict: "upload_batch_id" });
  if (error) return NextResponse.json({ error: "Unable to assign upload." }, { status: 500 });

  await logAuditEvent(context, "client_upload_assigned", "client", clientId, { uploadBatchId: body!.uploadBatchId! });
  return NextResponse.json({ ok: true, clientId, uploadBatchId: body!.uploadBatchId! });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const context = await scopedContext(request, clientId);
  if (context instanceof NextResponse) return context;
  const uploadBatchId = new URL(request.url).searchParams.get("uploadBatchId");
  if (!isUuid(uploadBatchId)) return NextResponse.json({ error: "Invalid upload id." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true, demo: true });

  const { error } = await context.supabase
    .from("client_upload_assignments")
    .delete()
    .eq("client_id", clientId)
    .eq("upload_batch_id", uploadBatchId!);
  if (error) return NextResponse.json({ error: "Unable to remove upload assignment." }, { status: 500 });
  await logAuditEvent(context, "client_upload_unassigned", "client", clientId, { uploadBatchId });
  return NextResponse.json({ ok: true, clientId, uploadBatchId });
}
