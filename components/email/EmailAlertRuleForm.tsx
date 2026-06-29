"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { EMAIL_ALERT_CONDITION_OPTIONS, EMAIL_ALERT_EVENT_OPTIONS } from "@/lib/email/alert-labels";

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

export interface EditableEmailRule extends EmailRulePayload {
  id: string;
  recipients: string[];
}

const EMPTY_FORM = {
  name: "",
  description: "",
  event_type: "upload_has_many_errors",
  condition_type: "error_count_gt",
  condition_value: "200",
  recipients: "",
  frequency: "immediate"
};

export default function EmailAlertRuleForm({
  onSaved,
  editingRule,
  onCancelEdit
}: {
  onSaved: () => void;
  editingRule?: EditableEmailRule | null;
  onCancelEdit?: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editingRule) {
      setForm(EMPTY_FORM);
      return;
    }
    setForm({
      name: editingRule.name,
      description: editingRule.description ?? "",
      event_type: editingRule.event_type,
      condition_type: editingRule.condition_type ?? "",
      condition_value: editingRule.condition_value == null ? "" : String(editingRule.condition_value),
      recipients: editingRule.recipients.join(", "),
      frequency: editingRule.frequency
    });
  }, [editingRule]);

  const selectedEvent = useMemo(
    () => EMAIL_ALERT_EVENT_OPTIONS.find((item) => item.value === form.event_type),
    [form.event_type]
  );

  function changeEvent(eventType: string) {
    const option = EMAIL_ALERT_EVENT_OPTIONS.find((item) => item.value === eventType);
    setForm((current) => ({ ...current, event_type: eventType, condition_type: option?.condition ?? "" }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const numericValue = form.condition_value === "" ? null : Number(form.condition_value);
    const payload: EmailRulePayload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      event_type: form.event_type,
      condition_type: form.condition_type || null,
      condition_value: form.condition_type && Number.isFinite(numericValue) ? numericValue : null,
      recipients: form.recipients.split(",").map((item) => item.trim()).filter(Boolean),
      enabled: editingRule?.enabled ?? true,
      frequency: form.frequency as EmailRulePayload["frequency"]
    };

    try {
      const response = await fetch(editingRule ? `/api/admin/email-alerts/${editingRule.id}` : "/api/admin/email-alerts", {
        method: editingRule ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "No se pudo guardar la regla.");
      setForm(EMPTY_FORM);
      onCancelEdit?.();
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo guardar la regla.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-md border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-2">
      <div className="lg:col-span-2">
        <h2 className="text-base font-semibold text-slate-950">{editingRule ? "Editar regla" : "Crear nueva regla"}</h2>
        <p className="mt-1 text-sm text-slate-500">Quiksol evaluara esta regla cuando ocurra el evento seleccionado.</p>
      </div>
      {error ? <p className="lg:col-span-2 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <label className="grid gap-1 text-sm font-medium text-slate-700">Nombre de la regla<input required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Ej: Avisar archivos con mas de 200 errores" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">Cuando ocurre<select value={form.event_type} onChange={(event) => changeEvent(event.target.value)} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal">{EMAIL_ALERT_EVENT_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <p className="lg:col-span-2 rounded-md bg-slate-50 p-3 text-sm text-slate-600">{selectedEvent?.example}</p>
      <label className="grid gap-1 text-sm font-medium text-slate-700">Condicion<select value={form.condition_type} onChange={(event) => setForm((current) => ({ ...current, condition_type: event.target.value }))} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal">{EMAIL_ALERT_CONDITION_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">Valor limite<input type="number" disabled={!form.condition_type} value={form.condition_value} onChange={(event) => setForm((current) => ({ ...current, condition_value: event.target.value }))} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>
      <label className="lg:col-span-2 grid gap-1 text-sm font-medium text-slate-700">Destinatarios<input required value={form.recipients} onChange={(event) => setForm((current) => ({ ...current, recipients: event.target.value }))} placeholder="admin@empresa.com, operaciones@empresa.com" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" /><span className="text-xs font-normal text-slate-500">Separa varios correos con coma. Maximo 25.</span></label>
      <label className="lg:col-span-2 grid gap-1 text-sm font-medium text-slate-700">Descripcion opcional<textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="Explica para que sirve esta alerta." className="focus-ring min-h-20 rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
      <div className="lg:col-span-2 flex justify-end gap-2">
        {editingRule ? <button type="button" onClick={onCancelEdit} className="rounded-md border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700">Cancelar</button> : null}
        <button type="submit" disabled={saving} className="focus-ring rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50">{saving ? "Guardando..." : editingRule ? "Guardar cambios" : "Crear regla"}</button>
      </div>
    </form>
  );
}
