"use client";

import Link from "next/link";

interface ExecutiveSearchResponse {
  query: string;
  interpretedFilters: {
    intent: string;
    confidence: number;
    detectedTerms: string[];
    filters: Record<string, unknown>;
  };
  summary: {
    totalResults: number;
    recordsCount: number;
    uploadsCount: number;
    errorsCount: number;
    usersCount: number;
  };
  results: {
    records: Array<Record<string, unknown>>;
    uploads: Array<Record<string, unknown>>;
    errors: Array<Record<string, unknown>>;
    users: Array<Record<string, unknown>>;
  };
  aiSummary?: string;
}

function value(row: Record<string, unknown>, key: string) {
  const next = row[key];
  if (next === null || next === undefined || next === "") return "-";
  return String(next);
}

function nestedName(row: Record<string, unknown>) {
  const profile = row.profiles as { full_name?: string; email?: string } | null | undefined;
  return profile?.full_name ?? profile?.email ?? "-";
}

function MetricCard({ label, value: cardValue }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{cardValue}</p>
    </div>
  );
}

export default function ExecutiveSearchResults({ data }: { data: ExecutiveSearchResponse }) {
  const filters = data.interpretedFilters.filters;
  const mpn = typeof filters.mpn === "string" ? filters.mpn : "";
  const canCreateAlert = Boolean(filters.uploadErrorThreshold || filters.gpRate || filters.missingMpn);

  return (
    <div className="space-y-6">
      <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-medium text-orange-700">Executive summary</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">{data.aiSummary}</h2>
            <p className="mt-2 text-sm text-slate-500">
              Intent: <span className="font-semibold text-slate-700">{data.interpretedFilters.intent}</span> · Confidence {Math.round(data.interpretedFilters.confidence * 100)}%
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {mpn ? (
              <Link href={`/mpn-comparator?mpn=${encodeURIComponent(mpn)}`} className="rounded-md bg-orange-600 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-700">
                Comparar precios
              </Link>
            ) : null}
            {canCreateAlert ? (
              <Link href="/admin/email-alerts" className="rounded-md border border-orange-200 px-3 py-2 text-sm font-semibold text-orange-700 hover:bg-orange-50">
                Crear alerta con esta condicion
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Total" value={data.summary.totalResults} />
        <MetricCard label="Records" value={data.summary.recordsCount} />
        <MetricCard label="Uploads" value={data.summary.uploadsCount} />
        <MetricCard label="Errors" value={data.summary.errorsCount} />
        <MetricCard label="Users" value={data.summary.usersCount} />
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-950">Filtros detectados</h2>
          <Link href="/executive-search" className="text-sm font-medium text-orange-700">Limpiar filtros</Link>
        </div>
        <pre className="mt-3 max-h-52 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
          {JSON.stringify(filters, null, 2)}
        </pre>
      </section>

      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-950">Registros</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                {["MPN", "Cliente", "Proveedor", "Precio", "GP rate", "Empleado", "Accion"].map((header) => (
                  <th key={header} className="px-4 py-3 text-left font-semibold text-slate-600">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.results.records.map((record) => {
                const recordMpn = value(record, "mpn") !== "-" ? value(record, "mpn") : value(record, "mpn_quoted");
                return (
                  <tr key={String(record.id)}>
                    <td className="px-4 py-3 font-medium text-slate-950">{recordMpn}</td>
                    <td className="px-4 py-3 text-slate-600">{value(record, "customer") !== "-" ? value(record, "customer") : value(record, "client")}</td>
                    <td className="px-4 py-3 text-slate-600">{value(record, "supplier_name") !== "-" ? value(record, "supplier_name") : value(record, "supplier")}</td>
                    <td className="px-4 py-3 text-slate-600">{value(record, "price")}</td>
                    <td className="px-4 py-3 text-slate-600">{value(record, "gp_rate")}</td>
                    <td className="px-4 py-3 text-slate-600">{nestedName(record)}</td>
                    <td className="px-4 py-3">
                      {recordMpn !== "-" ? (
                        <Link className="text-sm font-semibold text-orange-700" href={`/mpn-comparator?mpn=${encodeURIComponent(recordMpn)}`}>
                          Comparar
                        </Link>
                      ) : "-"}
                    </td>
                  </tr>
                );
              })}
              {!data.results.records.length ? (
                <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={7}>No records found.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3"><h2 className="text-sm font-semibold text-slate-950">Uploads</h2></div>
          <div className="divide-y divide-slate-100">
            {data.results.uploads.map((upload) => (
              <div key={String(upload.id)} className="p-4 text-sm">
                <p className="font-semibold text-slate-950">{value(upload, "original_file_name")}</p>
                <p className="mt-1 text-slate-500">{value(upload, "detected_category")} · {value(upload, "error_count")} errors · {nestedName(upload)}</p>
              </div>
            ))}
            {!data.results.uploads.length ? <p className="p-6 text-sm text-slate-500">No uploads found.</p> : null}
          </div>
        </section>

        <section className="rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3"><h2 className="text-sm font-semibold text-slate-950">Errores</h2></div>
          <div className="divide-y divide-slate-100">
            {data.results.errors.map((error) => (
              <div key={String(error.id)} className="p-4 text-sm">
                <p className="font-semibold text-slate-950">{value(error, "error_type")} · {value(error, "column_name")}</p>
                <p className="mt-1 text-slate-500">{value(error, "message")}</p>
              </div>
            ))}
            {!data.results.errors.length ? <p className="p-6 text-sm text-slate-500">No errors found.</p> : null}
          </div>
        </section>
      </div>

      {data.results.users.length ? (
        <section className="rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3"><h2 className="text-sm font-semibold text-slate-950">Empleados</h2></div>
          <div className="divide-y divide-slate-100">
            {data.results.users.map((user) => (
              <div key={String(user.id)} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                <div>
                  <p className="font-semibold text-slate-950">{value(user, "full_name")}</p>
                  <p className="mt-1 text-slate-500">{value(user, "email")} · {value(user, "role")} · {value(user, "department")}</p>
                </div>
                <Link className="text-sm font-semibold text-orange-700" href={`/employees?employee=${String(user.id)}`}>Ver perfil</Link>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
