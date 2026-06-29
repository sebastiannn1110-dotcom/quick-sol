import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Adjunto no disponible." }, { status: 404 });
  const { data: attachment, error } = await context.supabase.from("chat_attachments").select("file_path,storage_bucket").eq("id", id).maybeSingle();
  if (error || !attachment) return NextResponse.json({ error: "Adjunto no encontrado o sin permisos." }, { status: 404 });
  const { data, error: signedError } = await context.supabase.storage.from(attachment.storage_bucket).createSignedUrl(attachment.file_path, 60);
  if (signedError || !data?.signedUrl) return NextResponse.json({ error: "No se pudo abrir el adjunto." }, { status: 500 });
  return NextResponse.redirect(data.signedUrl);
}
