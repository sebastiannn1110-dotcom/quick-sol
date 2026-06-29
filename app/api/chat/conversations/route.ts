import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { canCreateChatGroup } from "@/lib/chat/chat-permissions";
import { conversationSchema } from "@/lib/chat/chat-service";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ conversations: [] });

  const { data: conversations, error } = await context.supabase
    .from("chat_conversations")
    .select("id, type, name, description, created_by, created_at, updated_at, chat_conversation_members(id,user_id,role,joined_at,last_read_at)")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: "No se pudieron cargar las conversaciones. Verifica la migracion empresarial." }, { status: 500 });

  const ids = (conversations ?? []).map((conversation) => conversation.id);
  const [messagesResult, usersResult] = await Promise.all([
    ids.length
      ? context.supabase.from("chat_messages").select("id, conversation_id, sender_id, body, message_type, created_at").in("conversation_id", ids).is("deleted_at", null).order("created_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [], error: null }),
    context.supabase.rpc("list_chat_users", { search_text: null })
  ]);
  const users = new Map((usersResult.data ?? []).map((user: { id: string }) => [user.id, user]));
  const latestByConversation = new Map<string, unknown>();
  for (const message of messagesResult.data ?? []) if (!latestByConversation.has(message.conversation_id)) latestByConversation.set(message.conversation_id, message);

  const enriched = (conversations ?? []).map((conversation) => ({
    ...conversation,
    members: conversation.chat_conversation_members.map((member) => ({ ...member, profile: users.get(member.user_id) ?? null })),
    latestMessage: latestByConversation.get(conversation.id) ?? null
  }));
  return NextResponse.json({ conversations: enriched });
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const parsed = conversationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Revisa el tipo de chat y los participantes.", issues: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.type === "group" && !canCreateChatGroup(context.profile.role)) return NextResponse.json({ error: "Solo un administrador puede crear grupos." }, { status: 403 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ conversationId: crypto.randomUUID(), demo: true });

  const rate = await checkPersistentRateLimit({ action: "chat_create_conversation", identifier: context.profile.id, limit: 20, windowSeconds: 60 * 60 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);
  const { data, error } = await context.supabase.rpc("create_chat_conversation", {
    conversation_type: parsed.data.type,
    conversation_name: parsed.data.name ?? "",
    conversation_description: parsed.data.description ?? "",
    participant_ids: parsed.data.participantIds
  });
  if (error) return NextResponse.json({ error: "No se pudo crear la conversacion.", detail: error.message }, { status: 500 });
  await logAuditEvent(context, "chat_conversation_created", "chat_conversation", data, { type: parsed.data.type, participantCount: parsed.data.participantIds.length });
  return NextResponse.json({ conversationId: data });
}
