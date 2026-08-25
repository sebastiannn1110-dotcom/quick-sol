import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { clientCapabilities } from "@/lib/clients/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return new NextResponse(null, { status: 404 });
  const clientId = (await params).clientId;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(clientId)) return new NextResponse(null, { status: 404 });
  const kind = new URL(request.url).searchParams.get("kind");
  let path: string | null = null;
  if (kind === "logo") {
    const result = await context.supabase.from("clients").select("logo_path").eq("id", clientId).maybeSingle();
    if (result.error) return new NextResponse(null, { status: 404 });
    path = result.data?.logo_path ?? null;
  } else if (kind === "identification" && clientCapabilities(context.profile.role).canViewPrivateIdentification) {
    const result = await context.supabase.from("client_private_details").select("identification_image_path").eq("client_id", clientId).maybeSingle();
    if (result.error) return new NextResponse(null, { status: 404 });
    path = result.data?.identification_image_path ?? null;
  }
  if (!path) return new NextResponse(null, { status: 404 });
  const signed = await context.supabase.storage.from("client-assets").createSignedUrl(path, 600);
  if (signed.error || !signed.data?.signedUrl) return new NextResponse(null, { status: 404 });
  return NextResponse.redirect(signed.data.signedUrl, {
    headers: { "Cache-Control": "private, no-store, max-age=0" }
  });
}
