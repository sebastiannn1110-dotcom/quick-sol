import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode) return NextResponse.json({ conversations: [], messages: [] });

  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ error: "Service role no esta configurado para auditoria." }, { status: 503 });

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId");
  const type = searchParams.get("type");
  const userId = searchParams.get("userId");

  let query = service
    .from("chat_conversations")
    .select("id,type,name,description,created_by,created_at,updated_at,chat_conversation_members(id,user_id,role,joined_at,last_read_at,profiles(id,full_name,email,role,department,region,avatar_path,bio,job_title))")
    .order("updated_at", { ascending: false })
    .limit(200);

  if (type && ["direct", "group", "all_company"].includes(type)) query = query.eq("type", type);

  const { data: conversations, error } = await query;
  if (error) return NextResponse.json({ error: "No se pudo cargar auditoria de chat." }, { status: 500 });

  let filtered = conversations ?? [];
  if (userId) {
    filtered = filtered.filter((conversation) => conversation.chat_conversation_members?.some((member) => member.user_id === userId));
  }

  if (!conversationId) return NextResponse.json({ conversations: filtered, messages: [] });

  const allowed = filtered.some((conversation) => conversation.id === conversationId) || !userId;
  if (!allowed) return NextResponse.json({ error: "Conversacion no encontrada en el filtro actual." }, { status: 404 });

  const { data: messages, error: messagesError } = await service
    .from("chat_messages")
    .select("id,conversation_id,sender_id,body,message_type,metadata,created_at,edited_at,deleted_at,profiles(id,full_name,email,avatar_path,job_title),chat_attachments(id,file_name,file_type,file_size,created_at)")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(500);

  if (messagesError) return NextResponse.json({ error: "No se pudieron cargar mensajes auditados." }, { status: 500 });

  await logAuditEvent(context, "admin_opened_chat_audit", "chat_conversation", conversationId, {
    auditView: true
  });

  return NextResponse.json({ conversations: filtered, messages: messages ?? [] });
}
