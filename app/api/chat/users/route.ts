import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ users: [context.profile] });
  const search = new URL(request.url).searchParams.get("q")?.trim().slice(0, 100) || null;
  const { data, error } = await context.supabase.rpc("list_chat_users", { search_text: search });
  if (error) return NextResponse.json({ error: "No se pudo cargar el directorio del chat. Verifica la migracion empresarial." }, { status: 500 });
  return NextResponse.json({ users: data ?? [] });
}
