"use client";

import { useMemo, useState } from "react";
import { emailAlertEventLabel } from "@/lib/email/alert-labels";

export interface EmailEvent {
  id: string;
  event_type: string;
  recipient: string;
  subject: string;
  status: string;
  error_message: string | null;
  metadata: unknown;
  sent_at: string | null;
  created_at: string;
}

function statusClass(status: string) {
  if (status === "sent") return "bg-emerald-100 text-emerald-800";
  if (status === "failed") return "bg-red-100 text-red-800";
  if (status === "skipped") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

const STATUS_LABELS: Record<string, string> = { sent: "Enviado", failed: "Fallido", skipped: "Omitido", pending: "Pendiente" };

export default function EmailEventsHistory({ events }: { events: EmailEvent[] }) {
  const [status, setStatus] = useState("");
  const filtered = useMemo(() => events.filter((event) => !status || event.status === status), [events, status]);

  return (
    <section className="rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div><h2 className="text-base font-semibold text-slate-950">Historial de alertas</h2><p className="mt-1 text-xs text-slate-500">Resultado real informado por el proveedor de correo.</p></div>
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="">Todos los estados</option><option value="sent">Enviados</option><option value="failed">Fallidos</option><option value="skipped">Omitidos</option><option value="pending">Pendientes</option></select>
      </div>
      <div className="divide-y divide-slate-100">
        {filtered.map((event) => (
          <div key={event.id} className="p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="font-semibold text-slate-950">{event.subject}</p><p className="mt-1 text-slate-500">{event.recipient} · {emailAlertEventLabel(event.event_type)} · {new Date(event.created_at).toLocaleString()}</p>{event.error_message ? <p className="mt-2 rounded-md bg-red-50 p-2 text-red-700">{event.error_message}</p> : null}</div>
              <span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusClass(event.status)}`}>{STATUS_LABELS[event.status] ?? event.status}</span>
            </div>
            {event.metadata ? <details className="mt-3"><summary className="cursor-pointer text-xs font-semibold text-slate-600">Detalles tecnicos</summary><pre className="mt-2 max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(event.metadata, null, 2)}</pre></details> : null}
          </div>
        ))}
        {!filtered.length ? <p className="p-8 text-center text-sm text-slate-500">No hay eventos para este filtro.</p> : null}
      </div>
    </section>
  );
}
