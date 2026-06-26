"use client";

import { FormEvent, Suspense, useEffect, useState, type ComponentProps } from "react";
import { useSearchParams } from "next/navigation";
import GlobalExecutiveSearch from "@/components/search/GlobalExecutiveSearch";
import ExecutiveSearchResults from "@/components/search/ExecutiveSearchResults";

function ExecutiveSearchContent() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<ComponentProps<typeof ExecutiveSearchResults>["data"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function runSearch(nextQuery = query) {
    const trimmed = nextQuery.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/executive-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, limit: 50, offset: 0 })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Executive search failed.");
      setResult(payload);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Executive search failed.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
      void runSearch(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch();
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-orange-700">Executive Search</p>
        <h1 className="text-2xl font-semibold text-slate-950">Buscador Ejecutivo</h1>
        <p className="mt-2 text-sm text-slate-500">
          Busca MPN, proveedores, clientes, PO, empleados, archivos, errores y condiciones como GP mayor a 25%.
        </p>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <form onSubmit={submit} className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ej: Muestrame todos los MPN de Tesla con GP mayor al 25%"
            className="focus-ring rounded-md border border-slate-300 px-3 py-3 text-sm"
          />
          <button type="submit" className="focus-ring rounded-md bg-orange-600 px-5 py-3 text-sm font-semibold text-white hover:bg-orange-700">
            {loading ? "Buscando..." : "Buscar"}
          </button>
        </form>
        <div className="mt-3 md:hidden">
          <GlobalExecutiveSearch compact />
        </div>
      </section>

      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      {loading ? <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Consultando Supabase...</div> : null}
      {!loading && !result ? (
        <div className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
          Escribe una busqueda ejecutiva para empezar. Los resultados respetan los permisos del usuario actual.
        </div>
      ) : null}
      {result ? <ExecutiveSearchResults data={result} /> : null}
    </div>
  );
}

export default function ExecutiveSearchPage() {
  return (
    <Suspense fallback={<div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Loading executive search...</div>}>
      <ExecutiveSearchContent />
    </Suspense>
  );
}
