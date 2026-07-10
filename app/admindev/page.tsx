"use client";

import { FormEvent, useEffect, useState } from "react";
import type { TrafficAnalytics } from "@/lib/traffic/analytics";

type HealthPayload = {
  health: {
    web: { status: string };
    worker: { status: string; heartbeatAt: string | null; workerId: string | null };
    jobs: { queued: number; processing: number; failed: number; completed: number; stuck: unknown[] };
    providers: Record<string, string>;
    recentTechnicalErrors: unknown[];
    alerts: string[];
  };
  superadmin: {
    route: string;
    hasUsername: boolean;
    hasPasswordHash: boolean;
    hasTemporaryPassword: boolean;
    hasSessionSecret: boolean;
    ttlMinutes: number;
  };
};

type ImportsPayload = {
  imports: {
    jobs: Array<Record<string, string | number | null>>;
    summary: { queued: number; processing: number; completedWithWarnings: number; failed: number };
  };
};

type SecurityPayload = {
  security: {
    securityEvents: unknown[];
    failedLogins: unknown[];
    unauthorizedRequests: unknown[];
    suspiciousIps: Array<{ ip: string; events: number; lastSeenAt: string; routes: number }>;
  };
};

type AiPayload = { ai: { env: { hasOpenIa: boolean; hasOpenAiApiKey: boolean; model: string }; total: number; failures: number; averageResponseMs: number } };
type ChatPayload = { chat: { messagesLast24h: number; activeConversations: number; attachmentsLast24h: number; errors: unknown[] } };

function metric(value: number | string | null | undefined) {
  if (typeof value === "number") return new Intl.NumberFormat("es").format(value);
  return value ?? "n/a";
}

function dateText(value: string | null | undefined) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-800 bg-slate-900 p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Tile({ label, value, tone = "slate" }: { label: string; value: string | number; tone?: "slate" | "green" | "amber" | "red" }) {
  const color = tone === "green" ? "text-emerald-300" : tone === "amber" ? "text-amber-300" : tone === "red" ? "text-red-300" : "text-white";
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950 p-3">
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}

export default function AdminDevPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [traffic, setTraffic] = useState<TrafficAnalytics | null>(null);
  const [security, setSecurity] = useState<SecurityPayload | null>(null);
  const [imports, setImports] = useState<ImportsPayload | null>(null);
  const [ai, setAi] = useState<AiPayload | null>(null);
  const [chat, setChat] = useState<ChatPayload | null>(null);

  async function loadAll() {
    const responses = await Promise.all([
      fetch("/api/superadmin/health", { cache: "no-store" }),
      fetch("/api/superadmin/traffic?range=7d", { cache: "no-store" }),
      fetch("/api/superadmin/security", { cache: "no-store" }),
      fetch("/api/superadmin/imports", { cache: "no-store" }),
      fetch("/api/superadmin/ai", { cache: "no-store" }),
      fetch("/api/superadmin/chat", { cache: "no-store" })
    ]);
    if (responses[0].status === 401) {
      setAuthenticated(false);
      return;
    }
    if (!responses.every((response) => response.ok)) throw new Error("No se pudo cargar el panel superadmin.");
    const [healthPayload, trafficPayload, securityPayload, importsPayload, aiPayload, chatPayload] = await Promise.all(responses.map((response) => response.json()));
    setHealth(healthPayload as HealthPayload);
    setTraffic((trafficPayload as { traffic: TrafficAnalytics }).traffic);
    setSecurity(securityPayload as SecurityPayload);
    setImports(importsPayload as ImportsPayload);
    setAi(aiPayload as AiPayload);
    setChat(chatPayload as ChatPayload);
    setAuthenticated(true);
  }

  useEffect(() => {
    loadAll().catch(() => setAuthenticated(false));
  }, []);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const response = await fetch("/api/superadmin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? "No se pudo iniciar sesion.");
      return;
    }
    setPassword("");
    await loadAll();
  }

  async function logout() {
    await fetch("/api/superadmin/logout", { method: "POST" });
    setAuthenticated(false);
    setHealth(null);
  }

  async function jobAction(jobId: string, action: "retry" | "cancel") {
    await fetch(`/api/superadmin/jobs/${jobId}/${action}`, { method: "POST" });
    await loadAll();
  }

  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <form onSubmit={submitLogin} className="w-full max-w-sm rounded-md border border-slate-800 bg-slate-900 p-5 shadow-sm">
          <p className="text-sm font-medium text-orange-300">Quicksol Superadmin</p>
          <h1 className="mt-1 text-2xl font-semibold text-white">Acceso privado</h1>
          <div className="mt-5 grid gap-3">
            <label className="grid gap-1 text-sm font-medium text-slate-300">
              Usuario
              <input value={username} onChange={(event) => setUsername(event.target.value)} className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-orange-400" autoComplete="username" />
            </label>
            <label className="grid gap-1 text-sm font-medium text-slate-300">
              Contraseña
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-orange-400" autoComplete="current-password" />
            </label>
            {error ? <p className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-200">{error}</p> : null}
            <button className="rounded-md bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-400">Entrar</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-orange-300">Quicksol Superadmin</p>
            <h1 className="text-2xl font-semibold text-white">Centro de control</h1>
          </div>
          <button onClick={logout} className="rounded-md border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-100 hover:border-orange-400">Salir</button>
        </header>

        {health?.health.alerts.length ? (
          <div className="rounded-md border border-red-800 bg-red-950 p-3 text-sm text-red-100">
            {health.health.alerts.map((alert) => <p key={alert}>{alert}</p>)}
          </div>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile label="Web" value={health?.health.web.status ?? "n/a"} tone="green" />
          <Tile label="Worker" value={health?.health.worker.status ?? "n/a"} tone={health?.health.worker.status === "ok" ? "green" : "red"} />
          <Tile label="Visitas 7d" value={metric(traffic?.summary.totalVisits)} />
          <Tile label="Errores 5xx" value={metric(traffic?.summary.errors5xx)} tone={traffic?.summary.errors5xx ? "red" : "green"} />
          <Tile label="Jobs queued" value={metric(health?.health.jobs.queued)} />
          <Tile label="Jobs processing" value={metric(health?.health.jobs.processing)} />
          <Tile label="Jobs failed" value={metric(health?.health.jobs.failed)} tone={health?.health.jobs.failed ? "red" : "green"} />
          <Tile label="Jobs stuck" value={metric(health?.health.jobs.stuck.length)} tone={health?.health.jobs.stuck.length ? "red" : "green"} />
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <Panel title="System Health">
            <div className="grid gap-2 text-sm text-slate-300">
              <p>Worker heartbeat: {dateText(health?.health.worker.heartbeatAt)}</p>
              <p>Worker ID: {health?.health.worker.workerId ?? "n/a"}</p>
              <p>Supabase: {health?.health.providers.supabase}</p>
              <p>Storage: {health?.health.providers.storage} · Bucket: {health?.health.providers.bucket}</p>
              <p>OpenAI: {health?.health.providers.openai} · Modelo: {health?.health.providers.openaiModel}</p>
              <p>ElevenLabs: {health?.health.providers.elevenlabs} · Email: {health?.health.providers.email}</p>
            </div>
          </Panel>

          <Panel title="Traffic">
            <div className="grid gap-2 text-sm text-slate-300">
              <p>Visitantes unicos aprox.: {metric(traffic?.summary.approximateUniqueVisitors)}</p>
              <p>Requests: {metric(traffic?.summary.totalRequests)}</p>
              <p>Promedio respuesta: {metric(traffic?.summary.averageResponseMs)}ms</p>
              <p>Ultima visita: {dateText(traffic?.summary.lastVisitAt)}</p>
            </div>
          </Panel>

          <Panel title="Security">
            <div className="grid gap-2 text-sm text-slate-300">
              <p>Logins fallidos 24h: {metric(security?.security.failedLogins.length)}</p>
              <p>Unauthorized 24h: {metric(security?.security.unauthorizedRequests.length)}</p>
              <p>Eventos seguridad 24h: {metric(security?.security.securityEvents.length)}</p>
              <p>IPs sospechosas: {metric(security?.security.suspiciousIps.length)}</p>
            </div>
          </Panel>

          <Panel title="AI y Chat">
            <div className="grid gap-2 text-sm text-slate-300">
              <p>OPEN_IA: {ai?.ai.env.hasOpenIa ? "detectado" : "faltante"} · Modelo: {ai?.ai.env.model ?? "n/a"}</p>
              <p>Fallos IA 24h: {metric(ai?.ai.failures)} · Avg: {metric(ai?.ai.averageResponseMs)}ms</p>
              <p>Mensajes chat 24h: {metric(chat?.chat.messagesLast24h)}</p>
              <p>Conversaciones activas: {metric(chat?.chat.activeConversations)}</p>
            </div>
          </Panel>
        </section>

        <Panel title="Import Jobs">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead><tr className="text-left text-slate-400"><th className="py-2">Archivo</th><th>Status</th><th>Filas</th><th>Warnings</th><th>JobId</th><th>Acciones</th></tr></thead>
              <tbody className="divide-y divide-slate-800">
                {imports?.imports.jobs.slice(0, 20).map((job) => {
                  const jobId = String(job.id);
                  return (
                    <tr key={jobId}>
                      <td className="py-2 text-white">{job.original_file_name}</td>
                      <td>{job.status}</td>
                      <td>{metric(job.processed_rows as number | null)} / {metric(job.total_rows as number | null)}</td>
                      <td>{metric(job.rows_with_warnings as number | null)}</td>
                      <td className="font-mono text-xs">{jobId}</td>
                      <td className="flex gap-2 py-2">
                        <button onClick={() => jobAction(jobId, "retry")} className="rounded-md bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700">Retry</button>
                        <button onClick={() => jobAction(jobId, "cancel")} className="rounded-md bg-red-900 px-2 py-1 text-xs hover:bg-red-800">Cancel</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Top Routes">
          <div className="grid gap-2 text-sm">
            {traffic?.topRoutes.slice(0, 10).map((route) => (
              <div key={route.route} className="flex flex-wrap justify-between gap-2 rounded-md bg-slate-950 px-3 py-2">
                <span>{route.route}</span>
                <span>{route.visits} visitas · {route.errors} errores · {route.averageResponseMs}ms</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
