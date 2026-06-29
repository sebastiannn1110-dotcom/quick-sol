export const ADMIN_EMAIL_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export interface EmailAttachmentPayload {
  filename: string;
  contentType: string;
  size: number;
  contentBase64: string;
}

export function validateAdminEmailAttachment(file: File) {
  const configuredMb = Number(process.env.ADMIN_EMAIL_ATTACHMENT_MAX_MB || 20);
  const maxBytes = Math.min(Math.max(Number.isFinite(configuredMb) ? configuredMb : 20, 1), 25) * 1024 * 1024;
  if (!ADMIN_EMAIL_ATTACHMENT_MIME_TYPES.has(file.type)) return { valid: false, error: "Tipo de archivo no permitido para correo." };
  if (file.size <= 0) return { valid: false, error: "El archivo esta vacio." };
  if (file.size > maxBytes) return { valid: false, error: `El archivo supera el limite de ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  return { valid: true, maxBytes };
}
