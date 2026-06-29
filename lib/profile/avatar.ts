export const AVATAR_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function validateAvatarFile(file: File) {
  const configuredMb = Number(process.env.AVATAR_MAX_SIZE_MB || 5);
  const maxBytes = Math.min(Math.max(Number.isFinite(configuredMb) ? configuredMb : 5, 1), 10) * 1024 * 1024;
  if (!AVATAR_MIME_TYPES.has(file.type)) return { valid: false, error: "Usa una imagen JPG, PNG o WebP." };
  if (file.size <= 0) return { valid: false, error: "La imagen esta vacia." };
  if (file.size > maxBytes) return { valid: false, error: `La imagen supera el limite de ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  return { valid: true, maxBytes };
}

export function avatarPublicUrl(path: string | null | undefined) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  if (!base || !path) return null;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/public/avatars/${encodedPath}`;
}
