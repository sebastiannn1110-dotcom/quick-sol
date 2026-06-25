"use client";

import { FormEvent, useState } from "react";
import AdminGuard from "@/components/AdminGuard";

type SearchPayload = {
  records: Array<Record<string, unknown>>;
  uploads: Array<Record<string, unknown>>;
  employees: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
};

function ResultList({ title, rows }: { title: string; rows: Array<Record<string, unknown>> }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-2">
        {rows.map((row, index) => (
          <pre key={String(row.id ?? index)} className="max-h-48 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
            {JSON.stringify(row, null, 2)}
          </pre>
        ))}
        {!rows.length ? <p className="text-sm text-slate-500">No results.</p> : null}
      </div>
    </section>
  );
}

export default function AdminSearchPage() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchPayload | null>(null);
  const [loading, setLoading] = useState(false);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    const response = await fetch(`/api/admin/search?query=${encodeURIComponent(query.trim())}`, { cache: "no-store" });
    if (response.ok) setResult((await response.json()) as SearchPayload);
    setLoading(false);
  }

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Admin</p>
          <h1 className="text-2xl font-semibold text-slate-950">Global Search</h1>
        </div>
        <form onSubmit={search} className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-4 shadow-sm sm:flex-row">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search MPN, supplier, customer, PO, upload, employee, category, error or comments"
            className="focus-ring min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2.5 text-sm"
          />
          <button type="submit" className="focus-ring rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700">
            {loading ? "Searching..." : "Search"}
          </button>
        </form>
        {result ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <ResultList title="Records" rows={result.records} />
            <ResultList title="Uploads" rows={result.uploads} />
            <ResultList title="Employees" rows={result.employees} />
            <ResultList title="Errors" rows={result.errors} />
          </div>
        ) : null}
      </div>
    </AdminGuard>
  );
}
