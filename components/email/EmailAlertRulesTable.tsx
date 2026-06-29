"use client";

import { useState } from "react";
import { emailAlertConditionLabel, emailAlertEventLabel } from "@/lib/email/alert-labels";
import type { EditableEmailRule } from "@/components/email/EmailAlertRuleForm";

export interface EmailAlertRule extends EditableEmailRule {
  created_at: string;
}

export default function EmailAlertRulesTable({
  rules,
  onChanged,
  onEdit,
  onError
}: {
  rules: EmailAlertRule[];
  onChanged: () => void;
  onEdit: (rule: EmailAlertRule) => void;
  onError: (message: string) => void;
}) {
  const [busyId, setBusyId] = useState("");

  async function request(rule: EmailAlertRule, method: "PATCH" | "DELETE", body?: unknown) {
    setBusyId(rule.id);
    onError("");
    const response = await fetch(`/api/admin/email-alerts/${rule.id}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => null);
    setBusyId("");
    if (!response.ok) {
      onError(payload?.error ?? "No se pudo actualizar la regla.");
      return;
    }
    onChanged();
  }

  async function sendTest(rule: EmailAlertRule) {
    setBusyId(rule.id);
    const response = await fetch("/api/admin/email-alerts/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipients: rule.recipients, subject: `[Quiksol] Prueba: ${rule.name}` })
    });
    const payload = await response.json().catch(() => null);
    setBusyId("");
    if (!response.ok || payload?.result?.status !== "sent") onError(payload?.error ?? payload?.result?.errorMessage ?? "La prueba no pudo enviarse.");
    else onChanged();
  }

  return (
    <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3"><h2 className="text-base font-semibold text-slate-950">Reglas configuradas</h2></div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50"><tr>{["Regla", "Evento", "Condicion", "Destinatarios", "Estado", "Acciones"].map((header) => <th key={header} className="px-4 py-3 text-left font-semibold text-slate-600">{header}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td className="px-4 py-3"><p className="font-medium text-slate-950">{rule.name}</p>{rule.description ? <p className="mt-1 max-w-xs text-xs text-slate-500">{rule.description}</p> : null}</td>
                <td className="px-4 py-3 text-slate-600">{emailAlertEventLabel(rule.event_type)}</td>
                <td className="px-4 py-3 text-slate-600">{emailAlertConditionLabel(rule.condition_type)}{rule.condition_type ? ` ${rule.condition_value ?? ""}` : ""}</td>
                <td className="px-4 py-3 text-slate-600"><span className="block max-w-xs truncate" title={rule.recipients.join(", ")}>{rule.recipients.length} correo{rule.recipients.length === 1 ? "" : "s"}</span></td>
                <td className="px-4 py-3"><span className={`rounded-md px-2 py-1 text-xs font-semibold ${rule.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>{rule.enabled ? "Activa" : "Inactiva"}</span></td>
                <td className="px-4 py-3"><div className="flex flex-wrap gap-2"><button disabled={busyId === rule.id} type="button" onClick={() => request(rule, "PATCH", { enabled: !rule.enabled })} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700">{rule.enabled ? "Desactivar" : "Activar"}</button><button type="button" onClick={() => onEdit(rule)} className="rounded-md border border-orange-200 px-2.5 py-1.5 text-xs font-semibold text-orange-700">Editar</button><button disabled={busyId === rule.id} type="button" onClick={() => void sendTest(rule)} className="rounded-md border border-brand-200 px-2.5 py-1.5 text-xs font-semibold text-brand-700">Probar</button><button disabled={busyId === rule.id} type="button" onClick={() => { if (window.confirm(`Eliminar la regla ${rule.name}?`)) void request(rule, "DELETE"); }} className="rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-semibold text-red-700">Eliminar</button></div></td>
              </tr>
            ))}
            {!rules.length ? <tr><td className="px-4 py-10 text-center text-slate-500" colSpan={6}>No hay reglas. Crea la primera con el formulario inferior.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
