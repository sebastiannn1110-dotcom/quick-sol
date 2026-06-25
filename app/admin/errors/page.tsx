"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import type { ImportErrorLog } from "@/lib/types";

interface ImportErrorRow extends ImportErrorLog {
  upload_batches?: {
    original_file_name: string | null;
    uploaded_by: string | null;
  } | null;
  upload_sheets?: {
    sheet_name: string | null;
  } | null;
}

export default function AdminErrorsPage() {
  const [errors, setErrors] = useState<ImportErrorRow[]>([]);

  useEffect(() => {
    async function loadErrors() {
      const response = await fetch("/api/admin/errors", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { errors: ImportErrorRow[] };
        setErrors(payload.errors ?? []);
      }
    }
    loadErrors();
  }, []);

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Admin</p>
          <h1 className="text-2xl font-semibold text-slate-950">Import Errors</h1>
        </div>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Total errors</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{errors.length}</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">High severity</p>
            <p className="mt-2 text-2xl font-semibold text-amber-700">
              {errors.filter((error) => error.severity === "high").length}
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Critical</p>
            <p className="mt-2 text-2xl font-semibold text-red-700">
              {errors.filter((error) => error.severity === "critical").length}
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Files affected</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {new Set(errors.map((error) => error.upload_batches?.original_file_name).filter(Boolean)).size}
            </p>
          </div>
        </section>

        <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">File</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Sheet</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Row</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Column</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Severity</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Original value</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Message</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">Trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {errors.map((error) => (
                  <tr key={error.id}>
                    <td className="max-w-xs px-4 py-3 font-medium text-slate-950">
                      {error.upload_batches?.original_file_name ?? "unknown file"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{error.upload_sheets?.sheet_name ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{error.row_index ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{error.column_name ?? "row"}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                        {error.severity ?? "unknown"}
                      </span>
                    </td>
                    <td className="max-w-xs px-4 py-3 text-slate-600">{error.raw_value ?? "-"}</td>
                    <td className="max-w-md px-4 py-3 text-slate-600">
                      <p className="font-medium text-slate-950">{error.error_type ?? "import_error"}</p>
                      <p className="mt-1">{error.message ?? "No message"}</p>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {error.trace_id ? (
                        <Link className="font-medium text-orange-700" href={`/admin/traces/${error.trace_id}`}>
                          {error.trace_id.slice(0, 8)}...
                        </Link>
                      ) : "-"}
                    </td>
                  </tr>
                ))}
                {!errors.length ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-slate-500" colSpan={8}>No import errors found.</td>
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
