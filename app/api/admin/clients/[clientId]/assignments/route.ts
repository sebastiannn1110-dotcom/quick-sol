import { NextResponse } from "next/server";
import { logAuditEvent, requireRole } from "@/lib/auth/context";
import { isUuid } from "@/lib/clients/clients";
import { AppError } from "@/lib/errors/AppError";
import { ensureClientUploadAssignment, loadAssignableUploadClient } from "@/lib/upload/client-assignment";

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

  try {
    await loadAssignableUploadClient(context.supabase, clientId);
    await ensureClientUploadAssignment(context.supabase, {
      actorId: context.profile.id,
      clientId,
      uploadBatchId: body!.uploadBatchId!
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.safeMessage, code: error.code }, { status: error.statusCode });
    }
    return NextResponse.json({ error: "Unable to assign upload." }, { status: 500 });
  }

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
