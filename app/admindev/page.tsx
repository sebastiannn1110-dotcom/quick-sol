"use client";

import { useCallback, useEffect, useState } from "react";
import DatabaseSafetyCenter from "@/components/admindev/DatabaseSafetyCenter";
import type { TrafficAnalytics } from "@/lib/traffic/analytics";

type DashboardModules = {
  health: {
    web: { status: string };
    worker: { status: string; heartbeatAt: string | null; workerId: string | null };
    jobs: { queued: number; processing: number; failed: number; completed: number; stuck: unknown[] };
    providers: Record<string, string>;
    alerts: string[];
  };
  traffic: TrafficAnalytics;
  imports: {
    jobs: Array<Record<string, string | number | null>>;
    summary: {
      activeBusinessRecords: number;
      archivedBusinessRecords: number;
      archivedBusinessRecordsApproximate?: boolean;
    };
  };
  security: { securityEvents: unknown[]; failedLogins: unknown[]; unauthorizedRequests: unknown[] };
  ai: { failures: number; averageResponseMs: number };
  chat: { messagesLast24h: number; activeConversations: number };
};

type ModuleName = keyof DashboardModules;
type ModuleLoadState = { status: "loading" | "success" | "error"; message: string | null };

const MODULES: Record<ModuleName, { label: string; endpoint: string }> = {
  health: { label: "System Health", endpoint: "/api/superadmin/health" },
  traffic: { label: "Tráfico", endpoint: "/api/superadmin/traffic?range=7d" },
  security: { label: "Seguridad", endpoint: "/api/superadmin/security" },
  imports: { label: "Importaciones", endpoint: "/api/superadmin/imports" },
  ai: { label: "IA", endpoint: "/api/superadmin/ai" },
  chat: { label: "Chat", endpoint: "/api/superadmin/chat" }
};

const INITIAL_MODULE_STATE = Object.fromEntries(
  Object.keys(MODULES).map((name) => [name, { status: "loading", message: null }])
) as Record<ModuleName, ModuleLoadState>;

function metric(value: number | null | undefined) {
  return typeof value === "number" ? new Intl.NumberFormat("es").format(value) : "n/a";
}

function Tile({ label, value, danger = false }: { label: string; value: string | number; danger?: boolean }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950 p-3">
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${danger ? "text-red-300" : "text-white"}`}>{value}</p>
    </div>
  );
}

function ModuleStatusCard({
  name,
  state,
  onRetry
}: {
  name: ModuleName;
  state: ModuleLoadState;
  onRetry: (name: ModuleName) => void;
}) {
  const config = MODULES[name];
  const tone = state.status === "success"
    ? "border-emerald-800 bg-emerald-950 text-emerald-100"
    : state.status === "error"
      ? "border-amber-700 bg-amber-950 text-amber-100"
      : "border-slate-700 bg-slate-900 text-slate-200";
  const statusLabel = state.status === "success" ? "Disponible" : state.status === "error" ? "Error temporal" : "Cargando";

  return (
    <div className={`rounded-md border p-3 ${tone}`} data-testid={`module-${name}-${state.status}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{config.label}</p>
          <p className="mt-1 text-xs">{state.message ?? statusLabel}</p>
        </div>
        {state.status === "error" ? (
          <button
            type="button"
            onClick={() => onRetry(name)}
            className="rounded border border-amber-500 px-2 py-1 text-xs font-semibold hover:bg-amber-900"
          >
            Reintentar {config.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function AdminDevPage() {
  const [data, setData] = useState<Partial<DashboardModules>>({});
  const [moduleStates, setModuleStates] = useState<Record<ModuleName, ModuleLoadState>>(INITIAL_MODULE_STATE);
  const [authError, setAuthError] = useState<string | null>(null);

  const loadModule = useCallback(async (name: ModuleName) => {
    setModuleStates((current) => ({ ...current, [name]: { status: "loading", message: null } }));
    try {
      const response = await fetch(MODULES[name].endpoint, {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (response.status === 401 || response.status === 403) {
        setAuthError("Sesión Super Admin Dev requerida.");
        setModuleStates((current) => ({
          ...current,
          [name]: { status: "error", message: "Acceso no autorizado." }
        }));
        return;
      }
      if (!response.ok) {
        setModuleStates((current) => ({
          ...current,
          [name]: { status: "error", message: `No se pudo cargar el módulo de ${MODULES[name].label}.` }
        }));
        return;
      }

      const payload = await response.json() as Partial<Record<ModuleName, DashboardModules[ModuleName]>>;
      const moduleData = payload[name];
      if (!moduleData) throw new Error("Invalid module payload");
      setData((current) => ({ ...current, [name]: moduleData }));
      setModuleStates((current) => ({ ...current, [name]: { status: "success", message: null } }));
    } catch {
      setModuleStates((current) => ({
        ...current,
        [name]: { status: "error", message: `No se pudo cargar el módulo de ${MODULES[name].label}.` }
      }));
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    await Promise.all((Object.keys(MODULES) as ModuleName[]).map((name) => loadModule(name)));
  }, [loadModule]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  async function logout() {
    await fetch("/api/superadmin/logout", { method: "POST", credentials: "same-origin" });
    window.location.assign("/login");
  }

  async function jobAction(jobId: string, action: "safe-finalize" | "retry" | "cancel") {
    await fetch(`/api/superadmin/jobs/${jobId}/${action}`, { method: "POST", credentials: "same-origin" });
    await loadModule("imports");
  }

  const initialLoading = Object.values(moduleStates).every((state) => state.status === "loading");

  if (authError || initialLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md rounded-md border border-slate-800 bg-slate-900 p-5 text-slate-100">
          <p className="text-sm font-medium text-blue-300">Electronic Parts · Super Admin Dev</p>
          <h1 className="mt-1 text-2xl font-semibold">{initialLoading && !authError ? "Cargando panel técnico…" : "Acceso denegado"}</h1>
          {authError ? <p className="mt-4 rounded bg-red-950 p-3 text-sm text-red-200">{authError}</p> : null}
          {authError ? <a className="mt-4 inline-block text-sm font-semibold text-orange-300 underline" href="/login?redirect=/admindev">Ir al inicio de sesión</a> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-blue-300">Electronic Parts · Super Admin Dev</p>
            <h1 className="text-2xl font-semibold">Centro de control técnico restringido</h1>
          </div>
          <button onClick={logout} className="rounded-md border border-slate-700 px-3 py-2 text-sm font-semibold hover:border-orange-400">Cerrar sesión</button>
        </header>

        <DatabaseSafetyCenter />

        <section aria-label="Estado de módulos" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(Object.keys(MODULES) as ModuleName[]).map((name) => (
            <ModuleStatusCard key={name} name={name} state={moduleStates[name]} onRetry={(moduleName) => void loadModule(moduleName)} />
          ))}
        </section>

        {data.health?.alerts.length ? (
          <section className="rounded-md border border-red-800 bg-red-950 p-3 text-sm text-red-100">
            {data.health.alerts.map((alert) => <p key={alert}>{alert}</p>)}
          </section>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Tile label="Web" value={data.health?.web.status ?? "n/a"} />
          <Tile label="Worker" value={data.health?.worker.status ?? "n/a"} danger={Boolean(data.health && data.health.worker.status !== "ok")} />
          <Tile label="Visitas 7 días" value={metric(data.traffic?.summary.totalVisits)} />
          <Tile label="Errores 5xx" value={metric(data.traffic?.summary.errors5xx)} danger={Boolean(data.traffic?.summary.errors5xx)} />
          <Tile label="Jobs fallidos" value={metric(data.health?.jobs.failed)} danger={Boolean(data.health?.jobs.failed)} />
          <Tile label="Jobs en cola" value={metric(data.health?.jobs.queued)} />
          <Tile label="Jobs procesando" value={metric(data.health?.jobs.processing)} />
          <Tile label="Registros activos" value={metric(data.imports?.summary.activeBusinessRecords)} />
          <Tile label="Fallos IA 24h" value={metric(data.ai?.failures)} danger={Boolean(data.ai?.failures)} />
          <Tile label="Mensajes chat 24h" value={metric(data.chat?.messagesLast24h)} />
        </section>

        <section className="rounded-md border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold">Import Jobs</h2>
          {moduleStates.imports.status === "loading" ? <p className="mt-3 text-sm text-slate-400">Cargando importaciones…</p> : null}
          {moduleStates.imports.status === "error" ? (
            <div className="mt-3 rounded-md border border-amber-700 bg-amber-950 p-3 text-sm text-amber-100">
              <p>Error temporal al cargar el módulo de importaciones. El resto del panel continúa disponible.</p>
              <button type="button" onClick={() => void loadModule("imports")} className="mt-2 rounded border border-amber-500 px-2 py-1 text-xs font-semibold">Reintentar Importaciones</button>
            </div>
          ) : null}
          {moduleStates.imports.status === "success" ? (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead><tr className="text-left text-slate-400"><th className="py-2">Archivo</th><th>Estado</th><th>Job ID</th><th>Acciones</th></tr></thead>
                <tbody className="divide-y divide-slate-800">
                  {data.imports?.jobs.slice(0, 20).map((job) => {
                    const id = String(job.id);
                    return <tr key={id}>
                      <td className="py-2">{job.original_file_name}</td><td>{job.status}</td><td className="font-mono text-xs">{id}</td>
                      <td className="flex gap-2 py-2">
                        <button onClick={() => jobAction(id, "safe-finalize")} className="rounded bg-emerald-900 px-2 py-1 text-xs">Safe finalize</button>
                        <button onClick={() => jobAction(id, "retry")} className="rounded bg-slate-800 px-2 py-1 text-xs">Retry</button>
                        <button onClick={() => jobAction(id, "cancel")} className="rounded bg-red-900 px-2 py-1 text-xs">Cancel</button>
                      </td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
