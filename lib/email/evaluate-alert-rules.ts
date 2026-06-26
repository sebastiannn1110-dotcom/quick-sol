import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail, type EmailStatus } from "@/lib/email/email-service";
import { logger } from "@/lib/logger/logger";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export type EmailAlertEventType =
  | "upload_completed"
  | "upload_failed"
  | "upload_has_many_errors"
  | "low_gp_rate"
  | "missing_mpn_threshold"
  | "weekly_report"
  | "new_dataset_published"
  | "import_quality_below_threshold";

export interface EmailAlertEvent {
  eventType: EmailAlertEventType;
  actorName?: string | null;
  actorEmail?: string | null;
  fileName?: string | null;
  uploadBatchId?: string | null;
  errorCount?: number | null;
  dataQualityScore?: number | null;
  missingMpnCount?: number | null;
  lowGpRate?: number | null;
  totalRows?: number | null;
  validRows?: number | null;
  dashboardUrl?: string | null;
  metadata?: Record<string, unknown>;
}

interface EmailAlertRule {
  id: string;
  name: string;
  description: string | null;
  event_type: EmailAlertEventType;
  condition_type: string | null;
  condition_value: number | null;
  recipients: string[] | null;
  enabled: boolean;
  frequency: string | null;
}

function numberValue(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function eventValue(event: EmailAlertEvent, conditionType: string | null) {
  if (conditionType === "error_count_gt") return numberValue(event.errorCount);
  if (conditionType === "gp_rate_lt") return numberValue(event.lowGpRate);
  if (conditionType === "missing_mpn_gt") return numberValue(event.missingMpnCount);
  if (conditionType === "quality_score_lt") return numberValue(event.dataQualityScore);
  return null;
}

export function shouldSendAlert(rule: Pick<EmailAlertRule, "event_type" | "condition_type" | "condition_value" | "enabled">, event: EmailAlertEvent) {
  if (!rule.enabled) return false;
  if (rule.event_type !== event.eventType) return false;
  if (!rule.condition_type || rule.condition_value === null || rule.condition_value === undefined) return true;

  const currentValue = eventValue(event, rule.condition_type);
  if (currentValue === null) return false;
  const threshold =
    rule.condition_type === "gp_rate_lt" && Number(rule.condition_value) > 1
      ? Number(rule.condition_value) / 100
      : Number(rule.condition_value);
  if (rule.condition_type.endsWith("_gt")) return currentValue > threshold;
  if (rule.condition_type.endsWith("_lt")) return currentValue < threshold;
  return currentValue === threshold;
}

function subjectForRule(rule: EmailAlertRule, event: EmailAlertEvent) {
  if (event.eventType === "upload_completed") return `[Quiksol] Nuevo Excel subido${event.actorName ? ` por ${event.actorName}` : ""}`;
  if (event.eventType === "upload_failed") return "[Quiksol] Upload fallido";
  if (event.eventType === "upload_has_many_errors") return `[Quiksol] Alerta: archivo con ${event.errorCount ?? 0} errores`;
  if (event.eventType === "low_gp_rate") return "[Quiksol] GP rate bajo detectado";
  if (event.eventType === "missing_mpn_threshold") return "[Quiksol] Registros sin MPN superan el limite";
  if (event.eventType === "import_quality_below_threshold") return "[Quiksol] Calidad de importacion baja";
  if (event.eventType === "weekly_report") return "[Quiksol] Reporte semanal de calidad de datos";
  if (event.eventType === "new_dataset_published") return "[Quiksol] Nuevo dataset publicado";
  return `[Quiksol] ${rule.name}`;
}

function bodyForRule(rule: EmailAlertRule, event: EmailAlertEvent) {
  const rows = [
    ["Regla", rule.name],
    ["Evento", event.eventType],
    ["Usuario", event.actorName || event.actorEmail || "Sistema"],
    ["Archivo", event.fileName || "No aplica"],
    ["Upload ID", event.uploadBatchId || "No aplica"],
    ["Total filas", event.totalRows ?? "No disponible"],
    ["Filas validas", event.validRows ?? "No disponible"],
    ["Errores", event.errorCount ?? "No disponible"],
    ["Calidad", event.dataQualityScore ?? "No disponible"],
    ["Registros sin MPN", event.missingMpnCount ?? "No disponible"],
    ["GP rate bajo", event.lowGpRate ?? "No disponible"],
    ["Fecha", new Date().toISOString()]
  ];

  const table = rows
    .map(([label, value]) => `<tr><td style="padding:6px 10px;font-weight:600">${label}</td><td style="padding:6px 10px">${value}</td></tr>`)
    .join("");
  const link = event.dashboardUrl ? `<p><a href="${event.dashboardUrl}">Abrir en Quiksol</a></p>` : "";

  return `
    <div style="font-family:Arial,sans-serif;color:#0f172a">
      <h2>${subjectForRule(rule, event)}</h2>
      <p>Resumen automatico del evento detectado por Quiksol.</p>
      <table style="border-collapse:collapse;border:1px solid #e2e8f0">${table}</table>
      ${link}
      <p style="font-size:12px;color:#64748b">Esta es una notificacion automatica. No respondas directamente a este correo.</p>
    </div>
  `;
}

async function persistNotificationEvent(
  supabase: SupabaseClient,
  rule: EmailAlertRule,
  recipient: string,
  subject: string,
  status: EmailStatus,
  errorMessage: string | null,
  event: EmailAlertEvent
) {
  await supabase.from("email_notification_events").insert({
    rule_id: rule.id,
    event_type: event.eventType,
    recipient,
    subject,
    status,
    error_message: errorMessage,
    metadata: event.metadata ?? event,
    sent_at: status === "sent" ? new Date().toISOString() : null
  });
}

export async function evaluateEmailAlertRules(event: EmailAlertEvent) {
  if (process.env.ENABLE_EMAIL_ALERTS === "false") return { evaluated: 0, sent: 0 };
  const service = createSupabaseServiceRoleClient();
  if (!service) return { evaluated: 0, sent: 0, skipped: "service_role_missing" };

  const { data: rules, error } = await service
    .from("email_alert_rules")
    .select("*")
    .eq("enabled", true)
    .eq("event_type", event.eventType)
    .limit(100);

  if (error) {
    await logger.warn({
      traceId: crypto.randomUUID(),
      module: "email",
      action: "alert_rules_load_failed",
      message: "Email alert rules could not be loaded.",
      status: "failed",
      error
    });
    return { evaluated: 0, sent: 0, error: error.message };
  }

  let sent = 0;
  let evaluated = 0;
  for (const rule of (rules ?? []) as EmailAlertRule[]) {
    evaluated += 1;
    if (!shouldSendAlert(rule, event)) continue;
    const recipients = (rule.recipients ?? []).filter(Boolean);
    const subject = subjectForRule(rule, event);
    const html = bodyForRule(rule, event);
    const result = await sendEmail({ to: recipients, subject, html });
    if (result.status === "sent") sent += recipients.length;

    await Promise.all(
      (recipients.length ? recipients : ["no-recipient"]).map((recipient) =>
        persistNotificationEvent(service, rule, recipient, subject, result.status, result.errorMessage ?? null, event)
      )
    );

    await logger.audit({
      traceId: crypto.randomUUID(),
      module: "email",
      action: result.status === "sent" ? "email_alert_sent" : "email_alert_not_sent",
      message: "Email alert rule evaluated.",
      status: result.status === "failed" ? "failed" : "completed",
      metadata: { ruleId: rule.id, eventType: event.eventType, provider: result.provider, recipients }
    });
  }

  return { evaluated, sent };
}
