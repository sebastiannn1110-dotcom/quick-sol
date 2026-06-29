"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import AdminGuard from "@/components/AdminGuard";

interface EmployeeOption {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "manager" | "employee";
  department: string | null;
  region: string | null;
}

interface HistoryItem {
  id: string;
  subject: string;
  recipient_count: number;
  status: string;
  provider: string | null;
  error_message: string | null;
  created_at: string;
  sent_at: string | null;
}

interface EmailTemplate { id: string; name: string; subject: string; body: string }

export default function AdminEmailCenterPage() {
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [provider, setProvider] = useState("mock");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [audienceMode, setAudienceMode] = useState<"selection" | "allEmployees" | "role" | "department" | "region">("selection");
  const [audienceValue, setAudienceValue] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/admin/email-center", { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      setEmployees(payload.employees ?? []);
      setHistory(payload.history ?? []);
      setTemplates(payload.templates ?? []);
      setProvider(payload.provider ?? "mock");
      if (payload.setupRequired) setError(payload.error);
    } else setError(payload?.error ?? "No se pudo cargar el centro de correo.");
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return employees.filter((employee) => {
      if (role && employee.role !== role) return false;
      if (!query) return true;
      return [employee.full_name, employee.email, employee.department, employee.region, employee.role]
        .filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }, [employees, role, search]);
  const departments = useMemo(() => Array.from(new Set(employees.map((employee) => employee.department).filter((value): value is string => Boolean(value)))).sort(), [employees]);
  const regions = useMemo(() => Array.from(new Set(employees.map((employee) => employee.region).filter((value): value is string => Boolean(value)))).sort(), [employees]);
  const audienceCount = useMemo(() => {
    if (audienceMode === "selection") return selectedIds.length;
    if (audienceMode === "allEmployees") return employees.filter((employee) => employee.role === "employee").length;
    if (audienceMode === "role") return employees.filter((employee) => employee.role === audienceValue).length;
    if (audienceMode === "department") return employees.filter((employee) => employee.department === audienceValue).length;
    return employees.filter((employee) => employee.region === audienceValue).length;
  }, [audienceMode, audienceValue, employees, selectedIds.length]);

  function toggle(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function applyTemplate(template: EmailTemplate) {
    setSubject(template.subject);
    setBody(template.body);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/admin/email-center/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          body,
          userIds: audienceMode === "selection" ? selectedIds : [],
          allEmployees: audienceMode === "allEmployees",
          roles: audienceMode === "role" && audienceValue ? [audienceValue] : [],
          department: audienceMode === "department" ? audienceValue : null,
          region: audienceMode === "region" ? audienceValue : null
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "No se pudo enviar el correo.");
      setMessage(`Envio procesado: ${payload.sent} enviados, ${payload.failed} fallidos.`);
      setSelectedIds([]);
      setSubject("");
      setBody("");
      await load();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "No se pudo enviar el correo.");
    } finally {
      setSending(false);
    }
  }

  return (
    <AdminGuard>
      <div className="space-y-6">
        <header>
          <p className="text-sm font-medium text-orange-700">Administrador</p>
          <h1 className="text-2xl font-semibold text-slate-950">Centro de correo</h1>
          <p className="mt-2 text-sm text-slate-600">Envia mensajes internos a perfiles activos y conserva un historial auditable.</p>
        </header>

        <section className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-md border border-slate-200 bg-white p-4"><p className="text-sm text-slate-500">Proveedor</p><p className="mt-1 text-xl font-semibold">{provider}</p></div>
          <div className="rounded-md border border-slate-200 bg-white p-4"><p className="text-sm text-slate-500">Perfiles activos</p><p className="mt-1 text-xl font-semibold">{employees.length}</p></div>
          <div className="rounded-md border border-slate-200 bg-white p-4"><p className="text-sm text-slate-500">Envios recientes</p><p className="mt-1 text-xl font-semibold">{history.length}</p></div>
        </section>

        {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p> : null}
        {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

        <form onSubmit={send} className="grid gap-5 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]">
          <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3"><h2 className="font-semibold text-slate-950">Destinatarios</h2><span className="text-sm text-slate-500">{audienceCount} seleccionados</span></div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <select value={audienceMode} onChange={(event) => { setAudienceMode(event.target.value as typeof audienceMode); setAudienceValue(""); }} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="selection">Seleccion manual</option><option value="allEmployees">Todos los empleados</option><option value="role">Por rol</option><option value="department">Por departamento</option><option value="region">Por region</option></select>
              {audienceMode === "role" ? <select required value={audienceValue} onChange={(event) => setAudienceValue(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Selecciona rol</option><option value="employee">Empleados</option><option value="manager">Managers</option><option value="admin">Admins</option></select> : null}
              {audienceMode === "department" ? <select required value={audienceValue} onChange={(event) => setAudienceValue(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Selecciona departamento</option>{departments.map((item) => <option key={item} value={item}>{item}</option>)}</select> : null}
              {audienceMode === "region" ? <select required value={audienceValue} onChange={(event) => setAudienceValue(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Selecciona region</option>{regions.map((item) => <option key={item} value={item}>{item}</option>)}</select> : null}
            </div>
            {audienceMode === "selection" ? <>
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_140px]">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nombre, email, departamento o region" className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm" />
              <select value={role} onChange={(event) => setRole(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Todos los roles</option><option value="employee">Empleados</option><option value="manager">Managers</option><option value="admin">Admins</option></select>
            </div>
            <button type="button" onClick={() => setSelectedIds(filtered.map((item) => item.id))} className="mt-3 text-sm font-semibold text-orange-700">Seleccionar resultados</button>
            <div className="mt-3 max-h-96 divide-y divide-slate-100 overflow-auto border-y border-slate-100">
              {filtered.map((employee) => (
                <label key={employee.id} className="flex cursor-pointer items-start gap-3 py-3 text-sm">
                  <input type="checkbox" checked={selectedIds.includes(employee.id)} onChange={() => toggle(employee.id)} className="mt-1" />
                  <span><span className="block font-medium text-slate-950">{employee.full_name}</span><span className="block text-slate-500">{employee.email} · {employee.role}{employee.department ? ` · ${employee.department}` : ""}</span></span>
                </label>
              ))}
              {!loading && !filtered.length ? <p className="py-6 text-center text-sm text-slate-500">No hay perfiles que coincidan.</p> : null}
            </div>
            </> : <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-600">Quiksol resolvera los destinatarios activos en el servidor al momento de enviar.</p>}
          </section>

          <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="font-semibold text-slate-950">Mensaje</h2>
            <div className="mt-3 flex flex-wrap gap-2">{templates.map((template) => <button key={template.id} type="button" onClick={() => applyTemplate(template)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700">{template.name}</button>)}</div>
            <label className="mt-4 grid gap-1 text-sm font-medium text-slate-700">Asunto<input required minLength={3} maxLength={180} value={subject} onChange={(event) => setSubject(event.target.value)} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
            <label className="mt-4 grid gap-1 text-sm font-medium text-slate-700">Mensaje<textarea required minLength={2} maxLength={10000} value={body} onChange={(event) => setBody(event.target.value)} className="focus-ring min-h-64 rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
            <button disabled={sending || audienceCount === 0 || (audienceMode !== "selection" && audienceMode !== "allEmployees" && !audienceValue)} className="mt-4 rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{sending ? "Enviando..." : `Enviar a ${audienceCount} destinatario${audienceCount === 1 ? "" : "s"}`}</button>
          </section>
        </form>

        <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3"><h2 className="font-semibold text-slate-950">Historial reciente</h2></div>
          <div className="divide-y divide-slate-100">{history.map((item) => <div key={item.id} className="flex flex-wrap items-start justify-between gap-3 p-4 text-sm"><div><p className="font-medium text-slate-950">{item.subject}</p><p className="mt-1 text-slate-500">{item.recipient_count} destinatarios · {item.provider ?? "sin proveedor"} · {new Date(item.created_at).toLocaleString()}</p>{item.error_message ? <p className="mt-1 text-red-700">{item.error_message}</p> : null}</div><span className={`rounded-md px-2 py-1 text-xs font-semibold ${item.status === "sent" ? "bg-emerald-100 text-emerald-800" : item.status === "failed" ? "bg-red-100 text-red-800" : "bg-slate-100 text-slate-700"}`}>{item.status}</span></div>)}{!history.length ? <p className="p-6 text-sm text-slate-500">Todavia no hay envios registrados.</p> : null}</div>
        </section>
      </div>
    </AdminGuard>
  );
}
