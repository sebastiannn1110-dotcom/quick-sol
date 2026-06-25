"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import type { SecurityEvent } from "@/lib/types";

const ALERT_EVENT_TYPES = new Set([
  "upload_failed",
  "chunk_insert_failed",
  "unauthorized_admin_access_attempt",
  "suspicious_upload_detected",
  "repeated_login_failed",
  "slow_query_detected",
  "high_import_error_rate",
  "storage_upload_failed",
  "supabase_query_failed",
  "rate_limit_triggered",
  "failed_permission_check"
]);

export default function AdminSecurityPage() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);

  useEffect(() => {
    async function loadEvents() {
      const response = await fetch("/api/admin/security-events", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { events: SecurityEvent[] };
        setEvents(payload.events ?? []);
      }
    }
    loadEvents();
  }, []);

  const alertEvents = events.filter(
    (event) =>
      event.severity === "high" ||
      event.severity === "critical" ||
      ALERT_EVENT_TYPES.has(event.event_type)
  );

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Admin</p>
          <h1 className="text-2xl font-semibold text-slate-950">Security Events</h1>
        </div>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Total events</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{events.length}</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Active alerts</p>
            <p className="mt-2 text-2xl font-semibold text-red-700">{alertEvents.length}</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Critical severity</p>
            <p className="mt-2 text-2xl font-semibold text-red-800">
              {events.filter((event) => event.severity === "critical").length}
            </p>
          </div>
        </section>

        {alertEvents.length ? (
          <section className="rounded-md border border-red-200 bg-red-50 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-red-900">Operational alerts</h2>
            <div className="mt-3 grid gap-2">
              {alertEvents.slice(0, 8).map((event) => (
                <div key={`alert-${event.id}`} className="rounded-md bg-white p-3 text-sm text-red-900">
                  <p className="font-semibold">{event.event_type} - {event.severity}</p>
                  <p className="mt-1 text-red-700">{event.route ?? "unknown route"}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="divide-y divide-slate-100">
            {events.map((event) => (
              <div key={event.id} className="p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-950">{event.event_type} - {event.severity}</p>
                    <p className="mt-1 text-slate-600">{event.route ?? "unknown route"}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {event.actor_email ?? event.actor_id ?? "unknown actor"} - {new Date(event.created_at).toLocaleString()}
                    </p>
                  </div>
                  {event.trace_id ? (
                    <Link
                      className="rounded-md border border-slate-200 px-3 py-2 text-xs font-medium text-orange-700 hover:bg-orange-50"
                      href={`/admin/traces/${event.trace_id}`}
                    >
                      View trace
                    </Link>
                  ) : null}
                </div>
                {event.metadata ? (
                  <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                    {JSON.stringify(event.metadata, null, 2)}
                  </pre>
                ) : null}
              </div>
            ))}
            {!events.length ? <p className="p-6 text-sm text-slate-500">No security events found.</p> : null}
          </div>
        </section>
      </div>
    </AdminGuard>
  );
}
