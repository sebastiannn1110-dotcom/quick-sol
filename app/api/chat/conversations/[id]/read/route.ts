import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true });
  const { error } = await context.supabase.from("chat_conversation_members").update({ last_read_at: new Date().toISOString() }).eq("conversation_id", id).eq("user_id", context.profile.id);
  if (error) return NextResponse.json({ error: "No se pudo marcar la conversacion como leida." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
