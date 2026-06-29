"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import EmailAlertRuleForm, { type EditableEmailRule } from "@/components/email/EmailAlertRuleForm";
import EmailAlertRulesTable, { type EmailAlertRule } from "@/components/email/EmailAlertRulesTable";
import EmailEventsHistory, { type EmailEvent } from "@/components/email/EmailEventsHistory";

export default function AdminEmailAlertsPage() {
  const [rules, setRules] = useState<EmailAlertRule[]>([]);
  const [events, setEvents] = useState<EmailEvent[]>([]);
  const [provider, setProvider] = useState("mock");
  const [testRecipients, setTestRecipients] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [setupRequired, setSetupRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingRule, setEditingRule] = useState<EditableEmailRule | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [rulesResponse, eventsResponse] = await Promise.all([
      fetch("/api/admin/email-alerts", { cache: "no-store" }),
      fetch("/api/admin/email-alerts/events?limit=200", { cache: "no-store" })
    ]);
    const rulesPayload = await rulesResponse.json().catch(() => null);
    const eventsPayload = await eventsResponse.json().catch(() => null);
    if (rulesPayload?.provider) setProvider(rulesPayload.provider);
    setSetupRequired(Boolean(rulesPayload?.setupRequired || eventsPayload?.setupRequired));
    if (rulesResponse.ok) setRules(rulesPayload?.rules ?? []);
    else if (rulesPayload?.error) setError(rulesPayload.error);
    if (eventsResponse.ok) setEvents(eventsPayload?.events ?? []);
    else if (eventsPayload?.error) setError(eventsPayload.error);
    setLoading(false);
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const stats = useMemo(() => ({
    active: rules.filter((rule) => rule.enabled).length,
    sent: events.filter((event) => event.status === "sent").length,
    failed: events.filter((event) => event.status === "failed").length,
    last: events[0]?.created_at ?? null
  }), [events, rules]);

  async function sendTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    const recipients = testRecipients.split(",").map((item) => item.trim()).filter(Boolean);
    try {
      const response = await fetch("/api/admin/email-alerts/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipients }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "No se pudo enviar la prueba.");
      if (payload.result.status === "sent") setMessage(`Prueba enviada correctamente con ${payload.result.provider}.`);
      else setError(`El proveedor ${payload.result.provider} respondio ${payload.result.status}: ${payload.result.errorMessage ?? "sin detalle"}`);
      await loadData();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "No se pudo enviar la prueba.");
    }
  }

  return (
    <AdminGuard>
      <div className="space-y-6">
        <header><p className="text-sm font-medium text-orange-700">Administrador</p><h1 className="text-2xl font-semibold text-slate-950">Reportes y alertas por correo</h1><p className="mt-2 text-sm text-slate-500">Crea avisos automaticos sin conocimientos tecnicos y revisa que ocurrio en cada envio.</p></header>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {[{ label: "Proveedor actual", value: provider }, { label: "Reglas activas", value: stats.active }, { label: "Correos enviados", value: stats.sent }, { label: "Correos fallidos", value: stats.failed }, { label: "Ultimo envio", value: stats.last ? new Date(stats.last).toLocaleString() : "Sin envios" }].map((item) => <div key={item.label} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm font-medium text-slate-500">{item.label}</p><p className="mt-2 text-lg font-semibold text-slate-950">{item.value}</p></div>)}
        </section>

        <p className={`rounded-md border p-3 text-sm ${provider === "resend" || provider === "smtp" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>{provider === "resend" ? "Resend esta configurado. Los envios reales dependen de que el dominio remitente y el destinatario esten autorizados en Resend." : provider === "smtp" ? "SMTP esta configurado para envios reales." : provider === "disabled" ? "Los correos estan desactivados por ENABLE_EMAIL_ALERTS=false." : "No hay proveedor real configurado. Los intentos quedaran como mock/omitidos."}</p>
        {setupRequired ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">Faltan las tablas de email en Supabase. Ejecuta primero 20260626010000_email_alerts.sql.</p> : null}
        {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null}
        {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

        <form onSubmit={sendTest} className="grid gap-3 rounded-md border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-[minmax(0,1fr)_auto]"><div><label className="text-sm font-semibold text-slate-700">Probar proveedor</label><input required value={testRecipients} onChange={(event) => setTestRecipients(event.target.value)} placeholder="correo@empresa.com" className="focus-ring mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm" /><p className="mt-1 text-xs text-slate-500">Con el dominio de prueba de Resend solo puedes enviar al correo propietario de la cuenta.</p></div><button type="submit" className="focus-ring self-end rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700">Enviar prueba</button></form>

        {loading ? <div className="grid gap-3"><div className="h-24 animate-pulse rounded-md bg-slate-200" /><div className="h-48 animate-pulse rounded-md bg-slate-200" /></div> : <>
          <EmailAlertRulesTable rules={rules} onChanged={loadData} onEdit={setEditingRule} onError={setError} />
          <EmailAlertRuleForm onSaved={loadData} editingRule={editingRule} onCancelEdit={() => setEditingRule(null)} />
          <EmailEventsHistory events={events} />
        </>}
      </div>
    </AdminGuard>
  );
}
