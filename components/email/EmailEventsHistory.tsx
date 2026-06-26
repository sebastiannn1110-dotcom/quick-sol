"use client";

interface EmailEvent {
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

export default function EmailEventsHistory({ events }: { events: EmailEvent[] }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-950">Historial de envios</h2>
      </div>
      <div className="divide-y divide-slate-100">
        {events.map((event) => (
          <div key={event.id} className="p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-slate-950">{event.subject}</p>
                <p className="mt-1 text-slate-500">{event.recipient} - {event.event_type} - {new Date(event.created_at).toLocaleString()}</p>
                {event.error_message ? <p className="mt-1 text-red-700">{event.error_message}</p> : null}
              </div>
              <span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusClass(event.status)}`}>{event.status}</span>
            </div>
            {event.metadata ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-semibold text-slate-600">Metadata</summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                  {JSON.stringify(event.metadata, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        ))}
        {!events.length ? <p className="p-6 text-sm text-slate-500">No hay emails registrados todavia.</p> : null}
      </div>
    </section>
  );
}
