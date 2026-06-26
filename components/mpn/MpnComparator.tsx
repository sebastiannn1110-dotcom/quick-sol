"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import SupplierRecommendationCard from "@/components/mpn/SupplierRecommendationCard";
import type { Profile } from "@/lib/types";

interface ComparisonPayload {
  mpn: string;
  summary: {
    totalOffers: number;
    bestPrice: number | null;
    worstPrice: number | null;
    fastestLeadTime: number | null;
    highestQuantity: number | null;
    recommendedSupplier: string | null;
    recommendationReason: string;
  };
  offers: Array<Record<string, unknown>>;
  priceHistory: Array<Record<string, unknown>>;
  supplierRanking: Array<Record<string, unknown>>;
  note?: string | null;
}

function cell(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function nested(row: Record<string, unknown>, key: string, field: string) {
  const value = row[key] as Record<string, unknown> | null | undefined;
  return value?.[field] ? String(value[field]) : "-";
}

export default function MpnComparator({ initialMpn = "" }: { initialMpn?: string }) {
  const [mpn, setMpn] = useState(initialMpn);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [data, setData] = useState<ComparisonPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function compare(nextMpn = mpn) {
    const trimmed = nextMpn.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/mpn-comparator?mpn=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to compare MPN.");
      setData(payload);
    } catch (compareError) {
      setError(compareError instanceof Error ? compareError.message : "Unable to compare MPN.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    async function loadProfile() {
      const response = await fetch("/api/me", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { profile: Profile };
        setProfile(payload.profile);
      }
    }
    void loadProfile();
  }, []);

  useEffect(() => {
    if (initialMpn) void compare(initialMpn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMpn]);

  useEffect(() => {
    const trimmed = mpn.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    const timeout = window.setTimeout(async () => {
      const response = await fetch(`/api/mpn-comparator/suggest?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { suggestions: string[] };
        setSuggestions(payload.suggestions ?? []);
      }
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [mpn]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void compare();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <input
            value={mpn}
            onChange={(event) => setMpn(event.target.value)}
            placeholder="Escribe un MPN, ej: SN74LVC2G74"
            className="focus-ring rounded-md border border-slate-300 px-3 py-3 text-sm"
          />
          <button type="submit" className="focus-ring rounded-md bg-orange-600 px-5 py-3 text-sm font-semibold text-white hover:bg-orange-700">
            {loading ? "Comparando..." : "Comparar"}
          </button>
        </div>
        {suggestions.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => {
                  setMpn(suggestion);
                  void compare(suggestion);
                }}
                className="rounded-md border border-orange-200 px-3 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-50"
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
      </form>

      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      {loading ? <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Consultando ofertas reales...</div> : null}
      {!loading && !data ? (
        <div className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
          Busca un MPN para comparar proveedores, precio, disponibilidad, lead time y margen.
        </div>
      ) : null}

      {data ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SupplierRecommendationCard label="Mejor precio" value={data.summary.bestPrice} detail="Menor price encontrado" accent="green" />
            <SupplierRecommendationCard label="Entrega mas rapida" value={data.summary.fastestLeadTime} detail="Lead time en semanas" accent="blue" />
            <SupplierRecommendationCard label="Mayor cantidad" value={data.summary.highestQuantity} detail="Qty / On hand" />
            <SupplierRecommendationCard label="Proveedor recomendado" value={data.summary.recommendedSupplier} detail={data.summary.recommendationReason} accent="orange" />
          </section>

          {data.note ? <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{data.note}</p> : null}

          <section className="rounded-md border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-950">Tabla comparativa - {data.mpn}</h2>
              <Link href={`/records?mpn=${encodeURIComponent(data.mpn)}`} className="text-sm font-semibold text-orange-700">
                Abrir registros filtrados
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {["Proveedor", "Precio", "Costo", "Qty", "MOQ", "SPQ", "Lead", "Pais", "GP", "GP rate", "Archivo", "Empleado", "Excel"].map((header) => (
                      <th key={header} className="px-4 py-3 text-left font-semibold text-slate-600">{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.offers.map((offer) => {
                    const upload = offer.upload_batches as { id?: string; original_file_name?: string; stored_file_path?: string | null } | null | undefined;
                    return (
                      <tr key={String(offer.id)}>
                        <td className="px-4 py-3 font-medium text-slate-950">{cell(offer, "supplier_name") !== "-" ? cell(offer, "supplier_name") : cell(offer, "supplier")}</td>
                        <td className="px-4 py-3 text-slate-600">{cell(offer, "price")}</td>
                        <td className="px-4 py-3 text-slate-600">{cell(offer, "cost")}</td>
                        <td className="px-4 py-3 text-slate-600">{cell(offer, "on_hand") !== "-" ? cell(offer, "on_hand") : cell(offer, "qty")}</td>
                        <td className="px-4 py-3 text-slate-600">{cell(offer, "moq")}</td>
                        <td className="px-4 py-3 text-slate-600">{cell(offer, "spq")}</td>
                        <td className="px-4 py-3 text-slate-600">{cell(offer, "lead_time_weeks")}</td>
                        <td className="px-4 py-3 text-slate-600">{cell(offer, "shipping_point_country")}</td>
                        <td className="px-4 py-3 text-slate-600">{cell(offer, "gp")}</td>
                        <td className="px-4 py-3 text-slate-600">{cell(offer, "gp_rate")}</td>
                        <td className="px-4 py-3 text-slate-600">{upload?.original_file_name ?? "-"}</td>
                        <td className="px-4 py-3 text-slate-600">{nested(offer, "profiles", "full_name")}</td>
                        <td className="px-4 py-3">
                          {profile?.role === "admin" && upload?.id ? (
                            <a className="text-sm font-semibold text-orange-700" href={`/api/admin/uploads/${upload.id}/download`} target="_blank" rel="noreferrer">
                              Abrir
                            </a>
                          ) : "-"}
                        </td>
                      </tr>
                    );
                  })}
                  {!data.offers.length ? (
                    <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={13}>No hay ofertas para este MPN.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-950">Ranking de proveedores</h2>
              <div className="mt-3 space-y-2">
                {data.supplierRanking.map((item) => (
                  <div key={String(item.supplier)} className="rounded-md bg-slate-50 p-3 text-sm">
                    <p className="font-semibold text-slate-950">{cell(item, "supplier")} - Score {cell(item, "score")}</p>
                    <p className="text-slate-500">Best price {cell(item, "bestPrice")} - Qty {cell(item, "highestQuantity")} - Lead {cell(item, "fastestLeadTimeWeeks")}</p>
                  </div>
                ))}
                {!data.supplierRanking.length ? <p className="text-sm text-slate-500">No ranking available.</p> : null}
              </div>
            </section>

            <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-950">Historial de precios</h2>
              <div className="mt-3 space-y-2">
                {data.priceHistory.map((item, index) => (
                  <div key={`${String(item.date)}-${index}`} className="rounded-md bg-slate-50 p-3 text-sm">
                    <p className="font-semibold text-slate-950">{cell(item, "date")} - {cell(item, "price")}</p>
                    <p className="text-slate-500">{cell(item, "supplier")} - {cell(item, "uploadFile")}</p>
                  </div>
                ))}
                {!data.priceHistory.length ? <p className="text-sm text-slate-500">No hay historial suficiente para este MPN todavia.</p> : null}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
