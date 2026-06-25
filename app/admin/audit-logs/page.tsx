"use client";

import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import type { AuditLog } from "@/lib/types";

export default function AdminAuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);

  useEffect(() => {
    async function loadLogs() {
      const response = await fetch("/api/admin/audit-logs", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { logs: AuditLog[] };
        setLogs(payload.logs ?? []);
      }
    }
    loadLogs();
  }, []);

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Admin</p>
          <h1 className="text-2xl font-semibold text-slate-950">Audit Logs</h1>
        </div>
        <section className="rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="divide-y divide-slate-100">
            {logs.map((log) => (
              <div key={log.id} className="p-4 text-sm">
                <p className="font-semibold text-slate-950">{log.action}</p>
                <p className="mt-1 text-slate-600">{log.actor_email ?? log.actor_id ?? "system"} · {log.entity_type ?? "entity"}</p>
                <p className="mt-1 text-xs text-slate-500">{new Date(log.created_at).toLocaleString()}</p>
              </div>
            ))}
            {!logs.length ? <p className="p-6 text-sm text-slate-500">No audit logs found.</p> : null}
          </div>
        </section>
      </div>
    </AdminGuard>
  );
}
