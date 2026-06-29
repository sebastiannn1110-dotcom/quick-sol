import { z } from "zod";

export const conversationSchema = z.object({
  type: z.enum(["direct", "group"]),
  name: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  participantIds: z.array(z.string().uuid()).min(1).max(99)
});

export const chatMessageSchema = z.object({
  body: z.string().trim().max(8000).optional().nullable(),
  messageType: z.enum(["text", "record_reference", "upload_reference"]).default("text"),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({})
}).refine((value) => value.messageType !== "text" || Boolean(value.body), { message: "El mensaje no puede estar vacio." });

export const groupUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional().nullable()
}).refine((value) => Object.keys(value).length > 0, { message: "No hay cambios." });

export const groupMembersSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(99)
});

export const CHAT_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export function validateChatAttachment(file: File) {
  const configuredMb = Number(process.env.CHAT_MAX_ATTACHMENT_MB || 15);
  const maxBytes = Math.min(Math.max(Number.isFinite(configuredMb) ? configuredMb : 15, 1), 25) * 1024 * 1024;
  if (!CHAT_ATTACHMENT_MIME_TYPES.has(file.type)) return { valid: false, error: "Tipo de archivo no permitido." };
  if (file.size <= 0) return { valid: false, error: "El archivo esta vacio." };
  if (file.size > maxBytes) return { valid: false, error: `El archivo supera el limite de ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  return { valid: true, maxBytes };
}
