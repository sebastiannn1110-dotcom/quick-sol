"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Mail, MessageCircle, Search } from "lucide-react";
import UserAvatar from "@/components/chat/UserAvatar";
import type { Profile } from "@/lib/types";

interface EmployeeWithCounts extends Profile {
  uploadCount: number;
  recordCount: number;
  lastUpload: string | null;
}

interface EmployeeDetailPayload {
  employee: EmployeeWithCounts | null;
  summary?: {
    uploadCount: number;
    recordCount: number;
    lastUpload: string | null;
  };
  privateActivity?: boolean;
}

function EmployeesContent() {
  const [currentUser, setCurrentUser] = useState<Profile | null>(null);
  const [employees, setEmployees] = useState<EmployeeWithCounts[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<EmployeeDetailPayload | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    const [meResponse, employeesResponse] = await Promise.all([
      fetch("/api/me", { cache: "no-store" }),
      fetch("/api/employees", { cache: "no-store" })
    ]);
    if (meResponse.ok) setCurrentUser(((await meResponse.json()) as { profile: Profile }).profile);
    if (employeesResponse.ok) {
      const payload = (await employeesResponse.json()) as { employees: EmployeeWithCounts[] };
      setEmployees(payload.employees ?? []);
      const first = payload.employees?.[0]?.id ?? "";
      setSelectedId((current) => current || first);
    }
    setLoading(false);
  }, []);

  const loadEmployeeDetail = useCallback(async (id: string) => {
    if (!id) return;
    setDetailLoading(true);
    const response = await fetch(`/api/employees?employeeId=${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as EmployeeDetailPayload | null;
    if (response.ok) setDetail(payload);
    setDetailLoading(false);
  }, []);

  useEffect(() => { void loadEmployees(); }, [loadEmployees]);
  useEffect(() => { if (selectedId) void loadEmployeeDetail(selectedId); }, [selectedId, loadEmployeeDetail]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return employees;
    return employees.filter((employee) => [employee.full_name, employee.email, employee.role, employee.department, employee.region, employee.job_title, employee.bio].filter(Boolean).join(" ").toLowerCase().includes(query));
  }, [employees, search]);

  async function startChat(employeeId: string) {
    if (!employeeId || employeeId === currentUser?.id) return;
    setMessage(""); setError("");
    const response = await fetch("/api/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "direct", participantIds: [employeeId] })
    });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      window.location.href = `/chat?conversation=${encodeURIComponent(payload.conversationId)}`;
    } else {
      setError(payload?.error ?? "No se pudo abrir el chat.");
    }
  }

  const employee = detail?.employee;
  const canEmail = currentUser?.role === "admin" && employee?.email;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-700">Directorio interno</p>
        <h1 className="text-2xl font-semibold text-slate-950">Empleados</h1>
        <p className="mt-2 text-sm text-slate-600">Contactos activos de la empresa con foto, cargo, area y descripcion visible.</p>
      </div>
      {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p> : null}
      {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

      <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 p-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nombre, correo, cargo, area o region" className="focus-ring w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm" />
            </label>
          </div>
          <div className="max-h-[calc(100vh-250px)] divide-y divide-slate-100 overflow-auto">
            {loading ? <p className="p-4 text-sm text-slate-500">Cargando empleados...</p> : null}
            {!loading && filtered.map((item) => (
              <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} className={`flex w-full items-start gap-3 p-3 text-left hover:bg-slate-50 ${selectedId === item.id ? "bg-brand-50" : ""}`}>
                <UserAvatar name={item.full_name} avatarPath={item.avatar_path} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-950">{item.full_name}</span>
                  <span className="block truncate text-xs text-slate-500">{item.job_title || item.role}</span>
                  <span className="block truncate text-xs text-slate-400">{item.department || "Sin departamento"} - {item.region || "Sin region"}</span>
                </span>
              </button>
            ))}
            {!loading && !filtered.length ? <p className="p-6 text-center text-sm text-slate-500">No hay empleados que coincidan.</p> : null}
          </div>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
          {detailLoading ? <p className="text-sm text-slate-500">Cargando perfil...</p> : null}
          {!detailLoading && employee ? (
            <div className="space-y-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-4">
                  <UserAvatar name={employee.full_name} avatarPath={employee.avatar_path} size="lg" />
                  <div>
                    <h2 className="text-2xl font-semibold text-slate-950">{employee.full_name}</h2>
                    <p className="mt-1 text-sm text-slate-500">{employee.email}</p>
                    <p className="mt-2 text-sm font-semibold text-slate-700">{employee.job_title || employee.role}</p>
                    <p className="text-sm text-slate-500">{employee.department || "Sin departamento"} - {employee.region || "Sin region"}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {employee.id !== currentUser?.id ? (
                    <button type="button" onClick={() => void startChat(employee.id)} className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white">
                      <MessageCircle className="h-4 w-4" /> Enviar mensaje
                    </button>
                  ) : null}
                  {canEmail ? (
                    <Link href={`/admin/email-center?email=${encodeURIComponent(employee.email)}`} className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">
                      <Mail className="h-4 w-4" /> Enviar correo
                    </Link>
                  ) : null}
                </div>
              </div>

              <div className="rounded-md bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase text-slate-500">Descripcion</p>
                <p className="mt-2 text-sm text-slate-700">{employee.bio || "Este usuario aun no ha agregado una descripcion."}</p>
              </div>

              {detail?.privateActivity ? (
                <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">La actividad operativa de otros empleados no se muestra en el directorio normal.</p>
              ) : detail?.summary ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md bg-slate-50 p-3"><p className="text-xs text-slate-500">Cargas</p><p className="text-xl font-semibold text-slate-950">{detail.summary.uploadCount}</p></div>
                  <div className="rounded-md bg-slate-50 p-3"><p className="text-xs text-slate-500">Registros</p><p className="text-xl font-semibold text-slate-950">{detail.summary.recordCount}</p></div>
                  <div className="rounded-md bg-slate-50 p-3"><p className="text-xs text-slate-500">Ultima carga</p><p className="text-sm font-semibold text-slate-950">{detail.summary.lastUpload ? new Date(detail.summary.lastUpload).toLocaleString() : "Sin cargas"}</p></div>
                </div>
              ) : null}
            </div>
          ) : null}
          {!detailLoading && !employee ? <p className="text-sm text-slate-500">Selecciona un empleado para ver su perfil interno.</p> : null}
        </section>
      </div>
    </div>
  );
}

export default function EmployeesPage() {
  return (
    <Suspense fallback={<div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Cargando empleados...</div>}>
      <EmployeesContent />
    </Suspense>
  );
}
