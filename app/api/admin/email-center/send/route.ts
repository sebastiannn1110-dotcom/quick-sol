import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { adminEmailSendSchema, resolveAdminEmailRecipients, sendAdminEmailToRecipients } from "@/lib/email/admin-email";
import { getEmailProvider } from "@/lib/email/email-service";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const parsed = adminEmailSendSchema.safeParse(await request.json().catch(() => null));
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
  if (recipients.length > 100) return NextResponse.json({ error: "El limite es de 100 destinatarios por envio." }, { status: 400 });

  const { data: message, error: insertError } = await context.supabase
    .from("admin_email_messages")
    .insert({
      subject: parsed.data.subject,
      body: parsed.data.body,
      sender_user_id: context.profile.id,
      recipients: recipients.map(({ id, full_name, email }) => ({ id, full_name, email })),
      recipient_count: recipients.length,
      status: "pending",
      provider: getEmailProvider(),
      metadata: { selector: { allEmployees: parsed.data.allEmployees, roles: parsed.data.roles, department: parsed.data.department, region: parsed.data.region, templateId: parsed.data.templateId } }
    })
    .select("id")
    .single();
  if (insertError || !message) return NextResponse.json({ error: "No se pudo registrar el envio. Verifica la migracion empresarial." }, { status: 500 });

  const results = await sendAdminEmailToRecipients({
    recipients,
    subject: parsed.data.subject,
    body: parsed.data.body,
    senderName: `${context.profile.full_name} (${context.profile.email})`
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
        selector: { allEmployees: parsed.data.allEmployees, roles: parsed.data.roles, department: parsed.data.department, region: parsed.data.region, templateId: parsed.data.templateId },
        results: results.map(({ recipient, result }) => ({ userId: recipient.id, email: recipient.email, status: result.status, error: result.errorMessage ?? null }))
      }
    })
    .eq("id", message.id);

  await logAuditEvent(context, "admin_email_sent", "admin_email_message", message.id, {
    recipientCount: recipients.length,
    sent,
    failed: failed.length,
    provider: firstResult?.provider ?? getEmailProvider()
  });

  return NextResponse.json({ messageId: message.id, status, sent, failed: failed.length, errorMessage });
}
