import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { validateChatAttachment } from "@/lib/chat/chat-service";
import { ensureConversationMember } from "@/lib/chat/server-access";
import { sanitizeFileName } from "@/lib/excel/validators";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id: conversationId } = await params;
  if (!UUID_PATTERN.test(conversationId)) return NextResponse.json({ error: "Conversacion invalida." }, { status: 400 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const body = String(form?.get("body") ?? "").trim().slice(0, 2000);
  if (!(file instanceof File)) return NextResponse.json({ error: "Selecciona un archivo." }, { status: 400 });
  const validation = validateChatAttachment(file);
  if (!validation.valid) return NextResponse.json({ error: validation.error }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Los adjuntos no estan disponibles en modo demo." }, { status: 503 });
  const rate = await checkPersistentRateLimit({ action: "chat_attachment", identifier: context.profile.id, limit: 30, windowSeconds: 60 * 60 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const access = await ensureConversationMember(context.supabase, conversationId, context.profile.id);
  if (!access.allowed) return NextResponse.json({ error: "No perteneces a esta conversacion." }, { status: 403 });
  const { data: message, error: messageError } = await context.supabase.from("chat_messages").insert({ conversation_id: conversationId, sender_id: context.profile.id, body: body || file.name, message_type: "file", metadata: {} }).select("id,created_at").single();
  if (messageError || !message) return NextResponse.json({ error: "No se pudo crear el mensaje del archivo." }, { status: 500 });

  const safeName = sanitizeFileName(file.name).slice(-160);
  const filePath = `${conversationId}/${context.profile.id}/${message.id}-${safeName}`;
  const { error: uploadError } = await context.supabase.storage.from("chat-attachments").upload(filePath, file, { contentType: file.type, upsert: false });
  if (uploadError) {
    await context.supabase.from("chat_messages").update({ deleted_at: new Date().toISOString() }).eq("id", message.id);
    return NextResponse.json({ error: "No se pudo guardar el archivo en Storage." }, { status: 500 });
  }
  const { data: attachment, error: attachmentError } = await context.supabase.from("chat_attachments").insert({ message_id: message.id, file_name: safeName, file_path: filePath, file_type: file.type, file_size: file.size, storage_bucket: "chat-attachments", uploaded_by: context.profile.id }).select("id,file_name,file_type,file_size,created_at").single();
  if (attachmentError) {
    await context.supabase.storage.from("chat-attachments").remove([filePath]);
    await context.supabase.from("chat_messages").update({ deleted_at: new Date().toISOString() }).eq("id", message.id);
    return NextResponse.json({ error: "No se pudo registrar el adjunto." }, { status: 500 });
  }
  return NextResponse.json({ message: { id: message.id, conversation_id: conversationId, sender_id: context.profile.id, body: body || safeName, message_type: "file", metadata: {}, created_at: message.created_at, sender: context.profile, chat_attachments: [attachment] } });
}
