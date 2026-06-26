"use client";

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

interface Suggestion {
  type: string;
  label: string;
  value: string;
  href: string;
  detail?: string;
}

type SuggestionGroups = Record<string, Suggestion[]>;

const PLACEHOLDERS = [
  "Buscar MPN, proveedor, cliente, PO, empleado, error...",
  "Ej: Tesla GP > 25%",
  "Ej: SN74LVC2G74 mejor precio",
  "Ej: archivos con mas de 200 errores"
];

const GROUP_LABELS: Record<string, string> = {
  mpn: "MPN",
  supplier: "Proveedor",
  customer: "Cliente",
  po: "PO",
  employee: "Empleado",
  upload: "Archivo subido",
  category: "Categoria",
  error: "Error",
  financial: "Comision / GP / precio"
};

export default function GlobalExecutiveSearch({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SuggestionGroups>({});
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const flatSuggestions = useMemo(
    () => Object.values(groups).flat(),
    [groups]
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      setPlaceholderIndex((current) => (current + 1) % PLACEHOLDERS.length);
    }, 3200);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => window.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setGroups({});
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/executive-search/suggest?q=${encodeURIComponent(trimmed)}`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (response.ok) {
          const payload = (await response.json()) as { groups: SuggestionGroups };
          setGroups(payload.groups ?? {});
          setOpen(true);
          setActiveIndex(-1);
        }
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [query]);

  function submitSearch() {
    const trimmed = query.trim();
    if (!trimmed) return;
    router.push(`/executive-search?q=${encodeURIComponent(trimmed)}`);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.min(flatSuggestions.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(-1, current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selected = flatSuggestions[activeIndex];
      if (selected) {
        router.push(selected.href);
        setOpen(false);
      } else {
        submitSearch();
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className={`relative ${compact ? "w-full" : "hidden min-w-[280px] max-w-xl flex-1 md:block"}`}>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={PLACEHOLDERS[placeholderIndex]}
          className="focus-ring w-full rounded-md border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-950 placeholder:text-slate-400"
        />
      </div>

      {open && (query.trim().length >= 2 || loading) ? (
        <div className="absolute left-0 right-0 top-11 z-50 max-h-[70vh] overflow-auto rounded-md border border-slate-200 bg-white p-2 shadow-xl">
          {loading ? <p className="px-3 py-2 text-sm text-slate-500">Buscando sugerencias...</p> : null}
          {!loading && !flatSuggestions.length ? (
            <button
              type="button"
              onClick={submitSearch}
              className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
            >
              Buscar &quot;{query.trim()}&quot; en Buscador Ejecutivo
            </button>
          ) : null}
          {Object.entries(groups).map(([group, suggestions]) =>
            suggestions.length ? (
              <div key={group} className="py-1">
                <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {GROUP_LABELS[group] ?? group}
                </p>
                {suggestions.map((suggestion) => {
                  const index = flatSuggestions.findIndex((item) => item.type === suggestion.type && item.value === suggestion.value);
                  return (
                    <button
                      key={`${suggestion.type}-${suggestion.value}-${suggestion.href}`}
                      type="button"
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        router.push(suggestion.href);
                        setOpen(false);
                      }}
                      className={`block w-full rounded-md px-3 py-2 text-left text-sm ${
                        activeIndex === index ? "bg-orange-50 text-orange-900" : "text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <span className="block font-medium">{suggestion.label}</span>
                      {suggestion.detail ? <span className="block text-xs text-slate-500">{suggestion.detail}</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : null
          )}
        </div>
      ) : null}
    </div>
  );
}
