import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { adminEmailSendSchema, resolveAdminEmailRecipients, sendAdminEmailToRecipients } from "@/lib/email/admin-email";
import { validateAdminEmailAttachment, type EmailAttachmentPayload } from "@/lib/email/attachments";
import { getEmailProvider } from "@/lib/email/email-service";
import { sanitizeFileName } from "@/lib/excel/validators";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readRequestPayload(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return {
      raw: await request.json().catch(() => null),
      files: [] as File[]
    };
  }

  const form = await request.formData().catch(() => null);
  if (!form) return { raw: null, files: [] as File[] };
  const jsonField = form.get("payload");
  const raw = typeof jsonField === "string" ? JSON.parse(jsonField) : {
    subject: String(form.get("subject") ?? ""),
    body: String(form.get("body") ?? ""),
    manualEmails: String(form.get("manualEmails") ?? "").split(/[\s,;]+/).map((email) => email.trim()).filter(Boolean),
    userIds: form.getAll("userIds").map(String).filter(Boolean)
  };
  const files = form.getAll("attachments").filter((item): item is File => item instanceof File);
  return { raw, files };
}

async function prepareAttachments(input: { files: File[]; messageId: string; senderId: string; supabase: SupabaseClient }) {
  const attachments: EmailAttachmentPayload[] = [];
  const records: Array<Record<string, unknown>> = [];

  for (const file of input.files.slice(0, 10)) {
    const validation = validateAdminEmailAttachment(file);
    if (!validation.valid) throw new Error(validation.error);

    const safeName = sanitizeFileName(file.name).slice(-160);
    const buffer = Buffer.from(await file.arrayBuffer());
    const filePath = `${input.senderId}/${input.messageId}/${crypto.randomUUID()}-${safeName}`;
    const { error: uploadError } = await input.supabase.storage.from("email-attachments").upload(filePath, file, { contentType: file.type, upsert: false });
    if (uploadError) throw new Error("No se pudo guardar un adjunto de correo en Storage.");

    records.push({
      message_id: input.messageId,
      file_name: safeName,
      file_path: filePath,
      file_type: file.type,
      file_size: file.size,
      storage_bucket: "email-attachments",
      uploaded_by: input.senderId
    });
    attachments.push({
      filename: safeName,
      contentType: file.type,
      size: file.size,
      contentBase64: buffer.toString("base64")
    });
  }

  if (records.length) {
    const { error } = await input.supabase.from("admin_email_attachments").insert(records);
    if (error) throw new Error("No se pudo registrar el historial de adjuntos.");
  }

  return attachments;
}

export async function POST(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const requestPayload = await readRequestPayload(request).catch(() => ({ raw: null, files: [] as File[] }));
  const parsed = adminEmailSendSchema.safeParse(requestPayload.raw);
  if (!parsed.success) return NextResponse.json({ error: "Revisa el mensaje y los destinatarios.", issues: parsed.error.flatten() }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "El envio real no esta disponible en modo demo." }, { status: 503 });

  const rate = await checkPersistentRateLimit({
    action: "admin_email_send",
    identifier: context.profile.id,
    limit: 20,
    windowSeconds: 60 * 60,
    blockSeconds: 15 * 60
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const recipients = await resolveAdminEmailRecipients(context.supabase, parsed.data);
  if (!recipients.length) return NextResponse.json({ error: "No hay destinatarios activos que coincidan con la seleccion." }, { status: 400 });
  if (recipients.length > 250) return NextResponse.json({ error: "El limite razonable es de 250 destinatarios por envio." }, { status: 400 });

  const { data: message, error: insertError } = await context.supabase
    .from("admin_email_messages")
    .insert({
      subject: parsed.data.subject,
      body: parsed.data.body,
      sender_user_id: context.profile.id,
      recipients: recipients.map(({ id, full_name, email, source }) => ({ id, full_name, email, source })),
      recipient_count: recipients.length,
      status: "pending",
      provider: getEmailProvider(),
      metadata: { selector: { allEmployees: parsed.data.allEmployees, roles: parsed.data.roles, department: parsed.data.department, region: parsed.data.region, templateId: parsed.data.templateId, manualEmailCount: parsed.data.manualEmails.length } }
    })
    .select("id")
    .single();
  if (insertError || !message) return NextResponse.json({ error: "No se pudo registrar el envio. Verifica la migracion empresarial." }, { status: 500 });

  let attachments: EmailAttachmentPayload[] = [];
  try {
    attachments = await prepareAttachments({
      files: requestPayload.files,
      messageId: message.id,
      senderId: context.profile.id,
      supabase: context.supabase
    });
  } catch (attachmentError) {
    await context.supabase.from("admin_email_messages").update({
      status: "failed",
      error_message: attachmentError instanceof Error ? attachmentError.message : "No se pudieron procesar los adjuntos."
    }).eq("id", message.id);
    return NextResponse.json({ error: attachmentError instanceof Error ? attachmentError.message : "No se pudieron procesar los adjuntos." }, { status: 400 });
  }

  const results = await sendAdminEmailToRecipients({
    recipients,
    subject: parsed.data.subject,
    body: parsed.data.body,
    senderName: `${context.profile.full_name} (${context.profile.email})`,
    attachments
  });
  const failed = results.filter(({ result }) => result.status !== "sent");
  const sent = results.length - failed.length;
  const status = failed.length === 0 ? "sent" : sent === 0 ? "failed" : "failed";
  const firstResult = results[0]?.result;
  const errorMessage = failed.length
    ? `${failed.length} de ${results.length} envios fallaron. ${failed[0]?.result.errorMessage ?? ""}`.trim()
    : null;

  await context.supabase
    .from("admin_email_messages")
    .update({
      status,
      provider: firstResult?.provider ?? getEmailProvider(),
      provider_message_id: firstResult?.messageId ?? null,
      error_message: errorMessage,
      sent_at: sent > 0 ? new Date().toISOString() : null,
      metadata: {
        selector: { allEmployees: parsed.data.allEmployees, roles: parsed.data.roles, department: parsed.data.department, region: parsed.data.region, templateId: parsed.data.templateId, manualEmailCount: parsed.data.manualEmails.length },
        attachments: attachments.map(({ filename, contentType, size }) => ({ filename, contentType, size })),
        results: results.map(({ recipient, result }) => ({ userId: recipient.id, email: recipient.email, status: result.status, error: result.errorMessage ?? null }))
      }
    })
    .eq("id", message.id);

  await logAuditEvent(context, "admin_email_sent", "admin_email_message", message.id, {
    recipientCount: recipients.length,
    sent,
    failed: failed.length,
    provider: firstResult?.provider ?? getEmailProvider(),
    attachmentCount: attachments.length
  });

  return NextResponse.json({ messageId: message.id, status, sent, failed: failed.length, attachmentCount: attachments.length, errorMessage });
}
