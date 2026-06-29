import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { chatMessageSchema } from "@/lib/chat/chat-service";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Conversacion invalida." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ messages: [] });
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 50), 1), 100);
  const before = searchParams.get("before");
  let query = context.supabase
    .from("chat_messages")
    .select("id, conversation_id, sender_id, body, message_type, metadata, created_at, edited_at, deleted_at, chat_attachments(id,file_name,file_type,file_size,created_at)")
    .eq("conversation_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "No se pudieron cargar los mensajes o no perteneces a esta conversacion." }, { status: 403 });
  const { data: users } = await context.supabase.rpc("list_chat_users", { search_text: null });
  const userMap = new Map((users ?? []).map((user: { id: string }) => [user.id, user]));
  const messages = (data ?? []).reverse().map((message) => ({ ...message, sender: message.sender_id ? userMap.get(message.sender_id) ?? null : null }));
  return NextResponse.json({ messages, hasMore: (data?.length ?? 0) === limit });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Conversacion invalida." }, { status: 400 });
  const parsed = chatMessageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "El mensaje no es valido.", issues: parsed.error.flatten() }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ message: { id: crypto.randomUUID(), ...parsed.data }, demo: true });
  const rate = await checkPersistentRateLimit({ action: "chat_message", identifier: context.profile.id, limit: 120, windowSeconds: 60 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);
  const { data, error } = await context.supabase.from("chat_messages").insert({ conversation_id: id, sender_id: context.profile.id, body: parsed.data.body ?? null, message_type: parsed.data.messageType, metadata: parsed.data.metadata }).select("id, conversation_id, sender_id, body, message_type, metadata, created_at").single();
  if (error) return NextResponse.json({ error: "No se pudo enviar el mensaje o no perteneces a la conversacion." }, { status: 403 });
  await context.supabase.from("chat_conversations").update({ updated_at: new Date().toISOString() }).eq("id", id);
  return NextResponse.json({ message: { ...data, sender: context.profile } });
}
