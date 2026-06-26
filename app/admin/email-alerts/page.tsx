"use client";

import { FormEvent, useCallback, useEffect, useState, type ComponentProps } from "react";
import AdminGuard from "@/components/AdminGuard";
import EmailAlertRuleForm from "@/components/email/EmailAlertRuleForm";
import EmailAlertRulesTable from "@/components/email/EmailAlertRulesTable";
import EmailEventsHistory from "@/components/email/EmailEventsHistory";

export default function AdminEmailAlertsPage() {
  const [rules, setRules] = useState<ComponentProps<typeof EmailAlertRulesTable>["rules"]>([]);
  const [events, setEvents] = useState<ComponentProps<typeof EmailEventsHistory>["events"]>([]);
  const [provider, setProvider] = useState("mock");
  const [testRecipients, setTestRecipients] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    const [rulesResponse, eventsResponse] = await Promise.all([
      fetch("/api/admin/email-alerts", { cache: "no-store" }),
      fetch("/api/admin/email-alerts/events", { cache: "no-store" })
    ]);
    if (rulesResponse.ok) {
      const payload = await rulesResponse.json();
      setRules(payload.rules ?? []);
      setProvider(payload.provider ?? "mock");
    }
    if (eventsResponse.ok) {
      const payload = await eventsResponse.json();
      setEvents(payload.events ?? []);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function sendTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    const recipients = testRecipients.split(",").map((item) => item.trim()).filter(Boolean);
    try {
      const response = await fetch("/api/admin/email-alerts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to send test email.");
      setMessage(`Test processed with provider ${payload.result.provider}: ${payload.result.status}`);
      await loadData();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to send test email.");
    }
  }

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Admin</p>
          <h1 className="text-2xl font-semibold text-slate-950">Email Reports & Alerts</h1>
          <p className="mt-2 text-sm text-slate-500">
            Reglas ejecutivas para enviar reportes y alertas por upload, errores, GP bajo o calidad de datos.
          </p>
        </div>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Proveedor</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{provider}</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Reglas</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{rules.length}</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Eventos</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{events.length}</p>
          </div>
        </section>

        {provider === "mock" ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            No hay proveedor de email configurado. Las reglas quedan creadas y los tests se registran en modo mock/skipped.
          </p>
        ) : null}
        {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null}
        {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

        <form onSubmit={sendTest} className="grid gap-3 rounded-md border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-[minmax(0,1fr)_auto]">
          <input
            value={testRecipients}
            onChange={(event) => setTestRecipients(event.target.value)}
            placeholder="admin@empresa.com, operaciones@empresa.com"
            className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm"
          />
          <button type="submit" className="focus-ring rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700">
            Enviar prueba
          </button>
        </form>

        <EmailAlertRuleForm onSaved={loadData} />
        <EmailAlertRulesTable rules={rules} onChanged={loadData} />
        <EmailEventsHistory events={events} />
      </div>
    </AdminGuard>
  );
}
