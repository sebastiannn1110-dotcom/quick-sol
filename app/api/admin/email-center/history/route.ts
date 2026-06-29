import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ history: [] });
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 50), 1), 200);
  const { data, error } = await context.supabase
    .from("admin_email_messages")
    .select("id, subject, sender_user_id, recipients, recipient_count, status, provider, error_message, metadata, created_at, sent_at, admin_email_attachments(id,file_name,file_type,file_size,created_at)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: "No se pudo cargar el historial." }, { status: 500 });
  return NextResponse.json({ history: data ?? [] });
}
