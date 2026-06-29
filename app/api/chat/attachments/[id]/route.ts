import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { ensureConversationMember } from "@/lib/chat/server-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AttachmentRow = {
  file_path: string;
  storage_bucket: string;
  chat_messages?: { conversation_id?: string | null } | Array<{ conversation_id?: string | null }> | null;
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Adjunto no disponible." }, { status: 404 });
  const { data: attachment, error } = await context.supabase
    .from("chat_attachments")
    .select("file_path,storage_bucket,chat_messages(conversation_id)")
    .eq("id", id)
    .maybeSingle<AttachmentRow>();
  if (error || !attachment) return NextResponse.json({ error: "Adjunto no encontrado o sin permisos." }, { status: 404 });
  const messageRow = Array.isArray(attachment.chat_messages) ? attachment.chat_messages[0] : attachment.chat_messages;
  const conversationId = messageRow?.conversation_id;
  if (!conversationId) return NextResponse.json({ error: "Adjunto no encontrado o sin permisos." }, { status: 404 });
  const access = await ensureConversationMember(context.supabase, conversationId, context.profile.id);
  if (!access.allowed) return NextResponse.json({ error: "Adjunto no encontrado o sin permisos." }, { status: 404 });
  const { data, error: signedError } = await context.supabase.storage.from(attachment.storage_bucket).createSignedUrl(attachment.file_path, 60);
  if (signedError || !data?.signedUrl) return NextResponse.json({ error: "No se pudo abrir el adjunto." }, { status: 500 });
  return NextResponse.redirect(data.signedUrl);
}
