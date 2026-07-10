"use client";

import { useEffect, useMemo, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import type { TrafficAnalytics, TrafficRange } from "@/lib/traffic/analytics";

const ranges: Array<{ value: TrafficRange; label: string }> = [
  { value: "today", label: "Hoy" },
  { value: "yesterday", label: "Ayer" },
  { value: "7d", label: "Ultimos 7 dias" },
  { value: "30d", label: "Ultimos 30 dias" }
];

function numberFormat(value: number) {
  return new Intl.NumberFormat("es").format(value);
}

function dateFormat(value: string | null) {
  if (!value) return "Sin datos";
  return new Date(value).toLocaleString();
}

function Metric({ label, value, tone = "slate" }: { label: string; value: string | number; tone?: "slate" | "green" | "amber" | "red" }) {
  const color = tone === "green" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : tone === "red" ? "text-red-700" : "text-slate-950";
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-normal text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}

export default function AdminTrafficPage() {
  const [range, setRange] = useState<TrafficRange>("7d");
  const [traffic, setTraffic] = useState<TrafficAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadTraffic() {
      setLoading(true);
      setError(null);
      const response = await fetch(`/api/admin/traffic?range=${range}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as { traffic?: TrafficAnalytics; error?: string };
      if (cancelled) return;
      if (!response.ok || !payload.traffic) {
        setError(payload.error ?? "No se pudo cargar trafico.");
        setTraffic(null);
      } else {
        setTraffic(payload.traffic);
      }
      setLoading(false);
    }
    loadTraffic();
    return () => {
      cancelled = true;
    };
  }, [range]);

  const summary = traffic?.summary;
  const lastDay = useMemo(() => traffic?.visitsByDay.at(-1), [traffic]);

  return (
    <AdminGuard>
      <div className="space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-orange-700">Administrador</p>
            <h1 className="text-2xl font-semibold text-slate-950">Trafico y monitoreo</h1>
            <p className="mt-1 text-sm text-slate-500">Visitas, rutas, usuarios activos, errores y actividad operacional.</p>
          </div>
          <select value={range} onChange={(event) => setRange(event.target.value as TrafficRange)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            {ranges.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </header>

        {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p> : null}
        {loading ? <p className="text-sm text-slate-500">Cargando trafico...</p> : null}

        {summary ? (
          <>
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Visitas totales" value={numberFormat(summary.totalVisits)} />
              <Metric label="Visitantes unicos aprox." value={numberFormat(summary.approximateUniqueVisitors)} />
              <Metric label="Usuarios logueados" value={numberFormat(summary.loggedInUsers)} />
              <Metric label="Anonimos" value={numberFormat(summary.anonymousVisits)} />
              <Metric label="Requests" value={numberFormat(summary.totalRequests)} />
              <Metric label="Exitosos" value={numberFormat(summary.successfulRequests)} tone="green" />
              <Metric label="Errores 4xx" value={numberFormat(summary.errors4xx)} tone={summary.errors4xx ? "amber" : "slate"} />
              <Metric label="Errores 5xx" value={numberFormat(summary.errors5xx)} tone={summary.errors5xx ? "red" : "slate"} />
              <Metric label="Promedio respuesta" value={`${summary.averageResponseMs}ms`} />
              <Metric label="Ultima visita" value={dateFormat(summary.lastVisitAt)} />
              <Metric label="Ultimo dia medido" value={lastDay ? `${lastDay.bucket}: ${lastDay.visits}` : "Sin datos"} />
              <Metric label="Rutas detectadas" value={numberFormat(traffic?.topRoutes.length ?? 0)} />
            </section>

            <section className="grid gap-4 xl:grid-cols-2">
              <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="font-semibold text-slate-950">Rutas mas visitadas</h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead><tr className="text-left text-slate-500"><th className="py-2">Ruta</th><th>Visitas</th><th>Usuarios</th><th>Avg</th><th>Errores</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {traffic.topRoutes.map((route) => (
                        <tr key={route.route}><td className="py-2 font-medium text-slate-800">{route.route}</td><td>{route.visits}</td><td>{route.uniqueUsers}</td><td>{route.averageResponseMs}ms</td><td>{route.errors}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="font-semibold text-slate-950">Usuarios activos</h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead><tr className="text-left text-slate-500"><th className="py-2">Usuario</th><th>Rol</th><th>Requests</th><th>Rutas</th><th>Uploads</th><th>Errores</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {traffic.activeUsers.map((user) => (
                        <tr key={user.userId}><td className="py-2 font-medium text-slate-800">{user.email}</td><td>{user.role}</td><td>{user.requests}</td><td>{user.routesUsed}</td><td>{user.uploads}</td><td>{user.errors}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="grid gap-4 xl:grid-cols-2">
              <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="font-semibold text-slate-950">IPs y user agents</h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead><tr className="text-left text-slate-500"><th className="py-2">IP</th><th>Requests</th><th>Rutas</th><th>Ultima visita</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {traffic.topIps.map((ip) => (
                        <tr key={ip.ip}><td className="max-w-[280px] py-2"><p className="font-medium text-slate-800">{ip.ip}</p><p className="truncate text-xs text-slate-500">{ip.userAgent}</p></td><td>{ip.requests}</td><td>{ip.routes}</td><td>{dateFormat(ip.lastVisitAt)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="font-semibold text-slate-950">Errores recientes</h2>
                <div className="mt-3 space-y-2">
                  {traffic.recentErrors.map((item) => (
                    <div key={`${item.createdAt}-${item.action}`} className="rounded-md bg-red-50 px-3 py-2 text-sm">
                      <p className="font-semibold text-red-800">{item.action} {item.statusCode ? `(${item.statusCode})` : ""}</p>
                      <p className="text-red-700">{item.message}</p>
                      <p className="text-xs text-red-600">{dateFormat(item.createdAt)} · {item.route ?? "sin ruta"} · {item.userEmail ?? "sin usuario"}</p>
                    </div>
                  ))}
                  {!traffic.recentErrors.length ? <p className="text-sm text-slate-500">Sin errores recientes.</p> : null}
                </div>
              </div>
            </section>

            <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="font-semibold text-slate-950">Eventos importantes</h2>
              <div className="mt-3 grid gap-2">
                {traffic.importantEvents.map((event) => (
                  <div key={`${event.createdAt}-${event.action}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm">
                    <span className="font-medium text-slate-800">{event.action}</span>
                    <span className="text-slate-500">{event.route ?? "sin ruta"}</span>
                    <span className="text-slate-500">{event.userEmail ?? "sin usuario"}</span>
                    <span className="text-slate-500">{dateFormat(event.createdAt)}</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </AdminGuard>
  );
}
