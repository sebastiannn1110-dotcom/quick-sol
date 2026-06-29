import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { validateAvatarFile, avatarPublicUrl } from "@/lib/profile/avatar";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extensionFor(type: string) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return "jpg";
}

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const path = context.profile.avatar_path ?? null;
  return NextResponse.json({ avatarPath: path, avatarUrl: avatarPublicUrl(path) });
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Selecciona una imagen." }, { status: 400 });
  const validation = validateAvatarFile(file);
  if (!validation.valid) return NextResponse.json({ error: validation.error }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "El avatar no esta disponible en modo demo." }, { status: 503 });
  const rate = await checkPersistentRateLimit({ action: "avatar_upload", identifier: context.profile.id, limit: 10, windowSeconds: 60 * 60 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const oldPath = context.profile.avatar_path;
  const path = `${context.profile.id}/${crypto.randomUUID()}.${extensionFor(file.type)}`;
  const { error: uploadError } = await context.supabase.storage.from("avatars").upload(path, file, { contentType: file.type, upsert: false, cacheControl: "3600" });
  if (uploadError) return NextResponse.json({ error: "No se pudo guardar la imagen en Storage." }, { status: 500 });
  const { error: profileError } = await context.supabase.rpc("set_my_avatar_path", { new_avatar_path: path });
  if (profileError) {
    await context.supabase.storage.from("avatars").remove([path]);
    return NextResponse.json({ error: "No se pudo actualizar el perfil. Verifica la migracion empresarial." }, { status: 500 });
  }
  if (oldPath) await context.supabase.storage.from("avatars").remove([oldPath]);
  await logAuditEvent(context, "profile_avatar_updated", "profile", context.profile.id);
  return NextResponse.json({ avatarPath: path, avatarUrl: avatarPublicUrl(path) });
}

export async function DELETE(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true });
  const oldPath = context.profile.avatar_path;
  const { error } = await context.supabase.rpc("set_my_avatar_path", { new_avatar_path: null });
  if (error) return NextResponse.json({ error: "No se pudo eliminar el avatar." }, { status: 500 });
  if (oldPath) await context.supabase.storage.from("avatars").remove([oldPath]);
  await logAuditEvent(context, "profile_avatar_deleted", "profile", context.profile.id);
  return NextResponse.json({ ok: true });
}
