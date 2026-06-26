"use client";

interface EmailAlertRule {
  id: string;
  name: string;
  description: string | null;
  event_type: string;
  condition_type: string | null;
  condition_value: number | null;
  recipients: string[] | null;
  enabled: boolean;
  frequency: string;
  created_at: string;
}

export default function EmailAlertRulesTable({ rules, onChanged }: { rules: EmailAlertRule[]; onChanged: () => void }) {
  async function setEnabled(rule: EmailAlertRule, enabled: boolean) {
    await fetch(`/api/admin/email-alerts/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    onChanged();
  }

  async function disable(rule: EmailAlertRule) {
    await fetch(`/api/admin/email-alerts/${rule.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-950">Reglas de alerta</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {["Nombre", "Evento", "Condicion", "Destinatarios", "Estado", "Acciones"].map((header) => (
                <th key={header} className="px-4 py-3 text-left font-semibold text-slate-600">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-950">{rule.name}</p>
                  {rule.description ? <p className="mt-1 text-xs text-slate-500">{rule.description}</p> : null}
                </td>
                <td className="px-4 py-3 text-slate-600">{rule.event_type}</td>
                <td className="px-4 py-3 text-slate-600">
                  {rule.condition_type ? `${rule.condition_type} ${rule.condition_value ?? ""}` : "No condition"}
                </td>
                <td className="px-4 py-3 text-slate-600">{(rule.recipients ?? []).join(", ")}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-md px-2 py-1 text-xs font-semibold ${rule.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                    {rule.enabled ? "enabled" : "disabled"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setEnabled(rule, !rule.enabled)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700">
                      {rule.enabled ? "Desactivar" : "Activar"}
                    </button>
                    <button type="button" onClick={() => disable(rule)} className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700">
                      Eliminar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!rules.length ? (
              <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={6}>No hay reglas todavia.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
