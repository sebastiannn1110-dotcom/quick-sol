"use client";

import { useEffect, useState } from "react";
import DatabaseSafetyCenter from "@/components/admindev/DatabaseSafetyCenter";
import type { TrafficAnalytics } from "@/lib/traffic/analytics";

type DashboardData = {
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
    summary: { activeBusinessRecords: number; archivedBusinessRecords: number };
  };
  security: { securityEvents: unknown[]; failedLogins: unknown[]; unauthorizedRequests: unknown[] };
  ai: { failures: number; averageResponseMs: number };
  chat: { messagesLast24h: number; activeConversations: number };
};

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

export default function AdminDevPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadDashboard() {
    const responses = await Promise.all([
      fetch("/api/superadmin/health", { cache: "no-store", credentials: "same-origin" }),
      fetch("/api/superadmin/traffic?range=7d", { cache: "no-store", credentials: "same-origin" }),
      fetch("/api/superadmin/security", { cache: "no-store", credentials: "same-origin" }),
      fetch("/api/superadmin/imports", { cache: "no-store", credentials: "same-origin" }),
      fetch("/api/superadmin/ai", { cache: "no-store", credentials: "same-origin" }),
      fetch("/api/superadmin/chat", { cache: "no-store", credentials: "same-origin" })
    ]);
    if (!responses.every((response) => response.ok)) {
      const denied = responses.some((response) => response.status === 401 || response.status === 403);
      throw new Error(denied ? "Sesión Super Admin Dev requerida." : "No se pudo cargar el panel técnico.");
    }
    const [health, traffic, security, imports, ai, chat] = await Promise.all(
      responses.map((response) => response.json())
    );
    setData({
      health: health.health,
      traffic: traffic.traffic,
      security: security.security,
      imports: imports.imports,
      ai: ai.ai,
      chat: chat.chat
    });
  }

  useEffect(() => {
    loadDashboard()
      .catch((cause) => setError(cause instanceof Error ? cause.message : "No se pudo cargar el panel."))
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    await fetch("/api/superadmin/logout", { method: "POST", credentials: "same-origin" });
    window.location.assign("/login");
  }

  async function jobAction(jobId: string, action: "safe-finalize" | "retry" | "cancel") {
    await fetch(`/api/superadmin/jobs/${jobId}/${action}`, { method: "POST", credentials: "same-origin" });
    await loadDashboard();
  }

  if (loading || error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md rounded-md border border-slate-800 bg-slate-900 p-5 text-slate-100">
          <p className="text-sm font-medium text-orange-300">QuikSol Super Admin Dev</p>
          <h1 className="mt-1 text-2xl font-semibold">{loading ? "Validando sesión…" : "Acceso denegado"}</h1>
          {error ? <p className="mt-4 rounded bg-red-950 p-3 text-sm text-red-200">{error}</p> : null}
          {error ? <a className="mt-4 inline-block text-sm font-semibold text-orange-300 underline" href="/login?redirect=/admindev">Ir al inicio de sesión</a> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-orange-300">QuikSol Super Admin Dev</p>
            <h1 className="text-2xl font-semibold">Centro de control técnico restringido</h1>
          </div>
          <button onClick={logout} className="rounded-md border border-slate-700 px-3 py-2 text-sm font-semibold hover:border-orange-400">Cerrar sesión</button>
        </header>

        <DatabaseSafetyCenter />

        {data?.health.alerts.length ? (
          <section className="rounded-md border border-red-800 bg-red-950 p-3 text-sm text-red-100">
            {data.health.alerts.map((alert) => <p key={alert}>{alert}</p>)}
          </section>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Tile label="Web" value={data?.health.web.status ?? "n/a"} />
          <Tile label="Worker" value={data?.health.worker.status ?? "n/a"} danger={data?.health.worker.status !== "ok"} />
          <Tile label="Visitas 7 días" value={metric(data?.traffic.summary.totalVisits)} />
          <Tile label="Errores 5xx" value={metric(data?.traffic.summary.errors5xx)} danger={Boolean(data?.traffic.summary.errors5xx)} />
          <Tile label="Jobs fallidos" value={metric(data?.health.jobs.failed)} danger={Boolean(data?.health.jobs.failed)} />
          <Tile label="Jobs en cola" value={metric(data?.health.jobs.queued)} />
          <Tile label="Jobs procesando" value={metric(data?.health.jobs.processing)} />
          <Tile label="Registros activos" value={metric(data?.imports.summary.activeBusinessRecords)} />
          <Tile label="Fallos IA 24h" value={metric(data?.ai.failures)} danger={Boolean(data?.ai.failures)} />
          <Tile label="Mensajes chat 24h" value={metric(data?.chat.messagesLast24h)} />
        </section>

        <section className="rounded-md border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold">Import Jobs</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead><tr className="text-left text-slate-400"><th className="py-2">Archivo</th><th>Estado</th><th>Job ID</th><th>Acciones</th></tr></thead>
              <tbody className="divide-y divide-slate-800">
                {data?.imports.jobs.slice(0, 20).map((job) => {
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
        </section>
      </div>
    </div>
  );
}
