import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { groupMembersSchema } from "@/lib/chat/chat-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const parsed = groupMembersSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "La lista de miembros no es valida." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true });
  const rows = parsed.data.userIds.map((userId) => ({ conversation_id: id, user_id: userId, role: "member" }));
  const { error } = await context.supabase.from("chat_conversation_members").upsert(rows, { onConflict: "conversation_id,user_id", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: "No puedes agregar miembros a este grupo." }, { status: 403 });
  await logAuditEvent(context, "chat_group_members_added", "chat_conversation", id, { memberCount: rows.length });
  return NextResponse.json({ ok: true });
}
