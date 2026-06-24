"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";

interface PerformanceLog {
  id: string;
  trace_id: string | null;
  request_id: string | null;
  operation: string;
  module: string;
  duration_ms: number;
  status: string;
  metadata?: unknown;
  created_at: string;
}

export default function AdminPerformancePage() {
  const [logs, setLogs] = useState<PerformanceLog[]>([]);

  useEffect(() => {
    async function loadPerformanceLogs() {
      const response = await fetch("/api/admin/performance", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { logs: PerformanceLog[] };
        setLogs(payload.logs ?? []);
      }
    }
    loadPerformanceLogs();
  }, []);

  const slowLogs = logs.filter((log) => Number(log.duration_ms) > 1500);

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-brand-700">Observability</p>
          <h1 className="text-2xl font-semibold text-slate-950">Performance Logs</h1>
        </div>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Measured operations</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{logs.length}</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Slow operations</p>
            <p className="mt-2 text-2xl font-semibold text-amber-700">{slowLogs.length}</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Failed operations</p>
            <p className="mt-2 text-2xl font-semibold text-red-700">
              {logs.filter((log) => log.status === "failed").length}
            </p>
          </div>
        </section>

        <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Time</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Operation</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Module</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Duration</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Status</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{new Date(log.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 font-medium text-slate-950">{log.operation}</td>
                    <td className="px-4 py-3 text-slate-600">{log.module}</td>
                    <td className={`px-4 py-3 font-semibold ${Number(log.duration_ms) > 1500 ? "text-amber-700" : "text-slate-700"}`}>
                      {log.duration_ms}ms
                    </td>
                    <td className="px-4 py-3 text-slate-600">{log.status}</td>
                    <td className="px-4 py-3 text-xs">
                      {log.trace_id ? (
                        <Link className="font-medium text-brand-700" href={`/admin/traces/${log.trace_id}`}>
                          {log.trace_id.slice(0, 8)}...
                        </Link>
                      ) : "-"}
                    </td>
                  </tr>
                ))}
                {!logs.length ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-slate-500" colSpan={6}>No performance logs found.</td>
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
