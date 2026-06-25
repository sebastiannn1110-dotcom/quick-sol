"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";

interface SystemLog {
  id: string;
  trace_id: string | null;
  request_id: string | null;
  level: string;
  module: string;
  action: string;
  message: string;
  user_id: string | null;
  user_email: string | null;
  route: string | null;
  duration_ms: number | null;
  upload_batch_id: string | null;
  created_at: string;
  error?: unknown;
  metadata?: unknown;
}

export default function AdminLogsPage() {
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [level, setLevel] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [traceId, setTraceId] = useState("");
  const [uploadBatchId, setUploadBatchId] = useState("");
  const [user, setUser] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    async function loadLogs() {
      const params = new URLSearchParams();
      if (level) params.set("level", level);
      if (moduleName) params.set("module", moduleName);
      if (traceId) params.set("traceId", traceId);
      if (uploadBatchId) params.set("uploadBatchId", uploadBatchId);
      if (user) params.set("user", user);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (query) params.set("query", query);
      const response = await fetch(`/api/admin/logs?${params.toString()}`, { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { logs: SystemLog[] };
        setLogs(payload.logs ?? []);
      }
    }
    const timeout = window.setTimeout(loadLogs, 250);
    return () => window.clearTimeout(timeout);
  }, [level, moduleName, traceId, uploadBatchId, user, dateFrom, dateTo, query]);

  async function copyTraceId(trace: string) {
    await navigator.clipboard.writeText(trace);
  }

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Observability</p>
          <h1 className="text-2xl font-semibold text-slate-950">System Logs</h1>
        </div>
        <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-4">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search action or message" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
            <input value={traceId} onChange={(event) => setTraceId(event.target.value)} placeholder="Trace ID" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
            <input value={uploadBatchId} onChange={(event) => setUploadBatchId(event.target.value)} placeholder="Upload batch ID" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
            <input value={user} onChange={(event) => setUser(event.target.value)} placeholder="User email or ID" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
            <select value={level} onChange={(event) => setLevel(event.target.value)} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
              <option value="">All levels</option>
              {["debug", "info", "warn", "error", "fatal", "security", "audit"].map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <select value={moduleName} onChange={(event) => setModuleName(event.target.value)} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
              <option value="">All modules</option>
              {["upload", "excel-parser", "header-detector", "normalizer", "category-detector", "auth", "admin", "records", "analytics", "supabase", "api", "frontend", "security"].map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          </div>
        </section>
        <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Time</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Level</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Module</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Action</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Message</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">User</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Trace</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{new Date(log.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3"><span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{log.level}</span></td>
                    <td className="px-4 py-3 text-slate-600">{log.module}</td>
                    <td className="px-4 py-3 font-medium text-slate-950">{log.action}</td>
                    <td className="max-w-md px-4 py-3 text-slate-600">{log.message}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{log.user_email ?? log.user_id ?? "-"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs">
                      {log.trace_id ? (
                        <div className="flex items-center gap-2">
                          <Link className="font-medium text-orange-700" href={`/admin/traces/${log.trace_id}`}>
                            {log.trace_id.slice(0, 8)}...
                          </Link>
                          <button type="button" onClick={() => copyTraceId(log.trace_id!)} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                            Copy
                          </button>
                        </div>
                      ) : "-"}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <details>
                        <summary className="cursor-pointer font-medium text-slate-600">View</summary>
                        <pre className="mt-2 max-h-48 max-w-lg overflow-auto rounded-md bg-slate-950 p-3 text-slate-100">
                          {JSON.stringify({ metadata: log.metadata, error: log.error, route: log.route, uploadBatchId: log.upload_batch_id }, null, 2)}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
                {!logs.length ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-slate-500" colSpan={8}>No logs found.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AdminGuard>
  );
}
