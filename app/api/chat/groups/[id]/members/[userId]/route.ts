import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id, userId } = await params;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true });
  const { error } = await context.supabase.from("chat_conversation_members").delete().eq("conversation_id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: "No puedes retirar miembros de este grupo." }, { status: 403 });
  await logAuditEvent(context, "chat_group_member_removed", "chat_conversation", id, { userId });
  return NextResponse.json({ ok: true });
}
