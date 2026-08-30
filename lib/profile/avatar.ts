export const AVATAR_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const LOCAL_DEMO_AVATAR_PATTERN = /^\/?(demo\/people\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp)$/;

export function validateAvatarFile(file: File) {
  const configuredMb = Number(process.env.AVATAR_MAX_SIZE_MB || 5);
  const maxBytes = Math.min(Math.max(Number.isFinite(configuredMb) ? configuredMb : 5, 1), 10) * 1024 * 1024;
  if (!AVATAR_MIME_TYPES.has(file.type)) return { valid: false, error: "Usa una imagen JPG, PNG o WebP." };
  if (file.size <= 0) return { valid: false, error: "La imagen esta vacia." };
  if (file.size > maxBytes) return { valid: false, error: `La imagen supera el limite de ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  return { valid: true, maxBytes };
}

export function avatarPublicUrl(path: string | null | undefined) {
  const candidate = path?.trim();
  if (!candidate) return null;

  const localDemoAvatar = candidate.match(LOCAL_DEMO_AVATAR_PATTERN);
  if (localDemoAvatar) return `/${localDemoAvatar[1]}`;

  // Absolute and demo-prefixed values are local URL attempts. Only the
  // allowlisted demo people directory above may bypass Supabase Storage.
  if (candidate.startsWith("/") || candidate.startsWith("demo/")) return null;

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  if (!base) return null;
  const encodedPath = candidate.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/public/avatars/${encodedPath}`;
}

export function avatarFallbackText(name: string) {
  const cleanName = name.replace(/\s+[\u2014-]\s+DEMO$/i, "").trim();
  if (/^Jason\s+Boss$/i.test(cleanName)) return "J";
  return cleanName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "QS";
}
