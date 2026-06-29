import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { groupUpdateSchema } from "@/lib/chat/chat-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const parsed = groupUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Los cambios del grupo no son validos." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true });
  const { data, error } = await context.supabase.from("chat_conversations").update(parsed.data).eq("id", id).eq("type", "group").select("id,name,description,updated_at").single();
  if (error) return NextResponse.json({ error: "No puedes administrar este grupo." }, { status: 403 });
  await logAuditEvent(context, "chat_group_updated", "chat_conversation", id);
  return NextResponse.json({ conversation: data });
}
