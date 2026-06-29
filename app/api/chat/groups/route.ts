import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { conversationSchema } from "@/lib/chat/chat-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const parsed = conversationSchema.safeParse({ ...(await request.json().catch(() => null)), type: "group" });
  if (!parsed.success) return NextResponse.json({ error: "Revisa el nombre y los miembros del grupo.", issues: parsed.error.flatten() }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ conversationId: crypto.randomUUID(), demo: true });
  const { data, error } = await context.supabase.rpc("create_chat_conversation", { conversation_type: "group", conversation_name: parsed.data.name ?? "", conversation_description: parsed.data.description ?? "", participant_ids: parsed.data.participantIds });
  if (error) return NextResponse.json({ error: "No se pudo crear el grupo." }, { status: 500 });
  await logAuditEvent(context, "chat_group_created", "chat_conversation", data, { participantCount: parsed.data.participantIds.length });
  return NextResponse.json({ conversationId: data });
}
