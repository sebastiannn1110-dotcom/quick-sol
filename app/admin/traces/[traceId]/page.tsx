"use client";

import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";

interface TraceEvent {
  id: string;
  source: string;
  created_at: string;
  action?: string;
  event_type?: string;
  level?: string;
  status?: string;
  module?: string;
  message?: string;
  duration_ms?: number;
  row_index?: number;
  column_name?: string;
  error_type?: string;
  severity?: string;
  metadata?: unknown;
  error?: unknown;
}

export default function TracePage({ params }: { params: Promise<{ traceId: string }> }) {
  const [traceId, setTraceId] = useState("");
  const [events, setEvents] = useState<TraceEvent[]>([]);

  useEffect(() => {
    async function loadTrace() {
      const resolved = await params;
      setTraceId(resolved.traceId);
      const response = await fetch(`/api/admin/traces/${resolved.traceId}`, { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { events: TraceEvent[] };
        setEvents(payload.events ?? []);
      }
    }
    loadTrace();
  }, [params]);

  const failedEvent = events.find((event) => event.level === "error" || event.level === "fatal" || event.status === "failed");
  const lastSuccessful = [...events].reverse().find((event) => event.level !== "error" && event.level !== "fatal");

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Trace Timeline</p>
          <h1 className="break-all text-2xl font-semibold text-slate-950">{traceId}</h1>
        </div>
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Last successful step</p>
            <p className="mt-2 font-semibold text-slate-950">{lastSuccessful?.action ?? lastSuccessful?.event_type ?? "None"}</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">First failed step</p>
            <p className="mt-2 font-semibold text-red-700">{failedEvent?.action ?? failedEvent?.event_type ?? "No failure"}</p>
          </div>
        </section>
        <section className="rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="divide-y divide-slate-100">
            {events.map((event, index) => (
              <div key={`${event.source}-${event.id}-${index}`} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-950">{index + 1}. {event.action ?? event.event_type ?? event.error_type}</p>
                    <p className="text-sm text-slate-500">{event.source} · {event.module ?? event.severity ?? "event"} · {new Date(event.created_at).toLocaleString()}</p>
                  </div>
                  {event.duration_ms !== undefined && event.duration_ms !== null ? (
                    <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{event.duration_ms}ms</span>
                  ) : null}
                </div>
                {event.message ? <p className="mt-2 text-sm text-slate-600">{event.message}</p> : null}
                <pre className="mt-3 max-h-60 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                  {JSON.stringify({ metadata: event.metadata, error: event.error, rowIndex: event.row_index, columnName: event.column_name }, null, 2)}
                </pre>
              </div>
            ))}
            {!events.length ? <p className="p-6 text-sm text-slate-500">No trace events found.</p> : null}
          </div>
        </section>
      </div>
    </AdminGuard>
  );
}
