"use client";

import { FormEvent, useState } from "react";

const EVENT_TYPES = [
  "upload_completed",
  "upload_failed",
  "upload_has_many_errors",
  "low_gp_rate",
  "missing_mpn_threshold",
  "weekly_report",
  "new_dataset_published",
  "import_quality_below_threshold"
];

const CONDITION_TYPES = [
  { value: "", label: "No condition" },
  { value: "error_count_gt", label: "Error count greater than" },
  { value: "gp_rate_lt", label: "GP rate lower than" },
  { value: "missing_mpn_gt", label: "Missing MPN greater than" },
  { value: "quality_score_lt", label: "Quality score lower than" }
];

export interface EmailRulePayload {
  name: string;
  description?: string | null;
  event_type: string;
  condition_type?: string | null;
  condition_value?: number | null;
  recipients: string[];
  enabled: boolean;
  frequency: "immediate" | "daily" | "weekly";
}

export default function EmailAlertRuleForm({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    event_type: "upload_has_many_errors",
    condition_type: "error_count_gt",
    condition_value: "200",
    recipients: "",
    frequency: "immediate"
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const payload: EmailRulePayload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      event_type: form.event_type,
      condition_type: form.condition_type || null,
      condition_value: form.condition_type ? Number(form.condition_value) : null,
      recipients: form.recipients.split(",").map((item) => item.trim()).filter(Boolean),
      enabled: true,
      frequency: form.frequency as EmailRulePayload["frequency"]
    };

    try {
      const response = await fetch("/api/admin/email-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to save rule.");
      setForm({
        name: "",
        description: "",
        event_type: "upload_has_many_errors",
        condition_type: "error_count_gt",
        condition_value: "200",
        recipients: "",
        frequency: "immediate"
      });
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save rule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-md border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-2">
      <div className="lg:col-span-2">
        <h2 className="text-sm font-semibold text-slate-950">Crear nueva regla</h2>
        <p className="mt-1 text-sm text-slate-500">Los destinatarios se separan por coma.</p>
      </div>
      {error ? <p className="lg:col-span-2 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        Nombre
        <input required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        Tipo de evento
        <select value={form.event_type} onChange={(event) => setForm((current) => ({ ...current, event_type: event.target.value }))} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal">
          {EVENT_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        Condicion
        <select value={form.condition_type} onChange={(event) => setForm((current) => ({ ...current, condition_type: event.target.value }))} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal">
          {CONDITION_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        Valor
        <input type="number" value={form.condition_value} onChange={(event) => setForm((current) => ({ ...current, condition_value: event.target.value }))} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
      </label>
      <label className="lg:col-span-2 grid gap-1 text-sm font-medium text-slate-700">
        Destinatarios
        <input required value={form.recipients} onChange={(event) => setForm((current) => ({ ...current, recipients: event.target.value }))} placeholder="admin@empresa.com, operaciones@empresa.com" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
      </label>
      <label className="lg:col-span-2 grid gap-1 text-sm font-medium text-slate-700">
        Descripcion
        <textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} className="focus-ring min-h-20 rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
      </label>
      <div className="lg:col-span-2 flex justify-end">
        <button type="submit" disabled={saving} className="focus-ring rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50">
          {saving ? "Guardando..." : "Crear regla"}
        </button>
      </div>
    </form>
  );
}
