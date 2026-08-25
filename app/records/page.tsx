"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DataTable from "@/components/DataTable";
import { useLanguage } from "@/components/LanguageProvider";
import SearchBar from "@/components/SearchBar";
import { clientLogger } from "@/lib/logger/clientLogger";
import type { PlatformRecord, Profile } from "@/lib/types";

interface RecordsPayload {
  records: PlatformRecord[];
  count: number | null;
  page: number;
  pageSize: number;
  nextCursor: string | null;
}

const CATEGORIES = [
  "Sales Margin",
  "RFQ",
  "Customer Demand",
  "Supplier Offers",
  "Inventory",
  "Logistics",
  "Finance",
  "Quality",
  "Generic"
];

export default function RecordsPage() {
  const { t, tc } = useLanguage();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [uploadedBy, setUploadedBy] = useState("");
  const [customer, setCustomer] = useState("");
  const [supplier, setSupplier] = useState("");
  const [mpn, setMpn] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [po, setPo] = useState("");
  const [country, setCountry] = useState("");
  const [hasErrors, setHasErrors] = useState("");
  const [records, setRecords] = useState<PlatformRecord[]>([]);
  const [employees, setEmployees] = useState<Profile[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/records/filter-options", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { employees?: Profile[] };
        if (response.ok) setEmployees(payload.employees ?? []);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const resetPagination = useCallback(() => {
    setPage(1);
    setCursor(null);
    setNextCursor(null);
    setCursorHistory([]);
  }, []);

  const loadRecords = useCallback(async (signal: AbortSignal) => {
    const sequence = ++requestSequence.current;
    const params = new URLSearchParams({ pageSize: "25" });
    if (cursor) {
      params.set("cursor", cursor);
      params.set("includeCount", "false");
    }
    if (query) params.set("query", query);
    if (category) params.set("category", category);
    if (uploadedBy) params.set("uploadedBy", uploadedBy);
    if (customer) params.set("customer", customer);
    if (supplier) params.set("supplier", supplier);
    if (mpn) params.set("mpn", mpn);
    if (manufacturer) params.set("manufacturer", manufacturer);
    if (po) params.set("po", po);
    if (country) params.set("country", country);
    if (hasErrors) params.set("hasErrors", hasErrors);

    try {
      setLoading(true);
      const response = await fetch(`/api/records?${params.toString()}`, { cache: "no-store", signal });
      const payload = (await response.json()) as RecordsPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? t("records.loading"));
      if (sequence !== requestSequence.current) return;
      clientLogger.searchExecuted({
        query,
        category,
        uploadedBy,
        count: payload.count ?? 0
      });
      setRecords(payload.records ?? []);
      if (typeof payload.count === "number") setCount(payload.count);
      setNextCursor(payload.nextCursor ?? null);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      if (sequence !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : t("records.loading"));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [category, country, cursor, customer, hasErrors, manufacturer, mpn, po, query, supplier, t, uploadedBy]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void loadRecords(controller.signal), 250);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [loadRecords]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-brand-700">{t("records.eyebrow")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("records.title")}</h1>
        </div>
        <div className="text-sm text-slate-500">
          <span className="font-semibold text-slate-950">{count}</span> {t("records.matching")}
        </div>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <SearchBar
              value={query}
              onChange={(value) => {
                setQuery(value);
                resetPagination();
              }}
              placeholder={t("records.searchPlaceholder")}
            />
          </div>
          <select value={category} onChange={(event) => { setCategory(event.target.value); resetPagination(); }} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
            <option value="">{t("records.allCategories")}</option>
            {CATEGORIES.map((item) => (
              <option key={item} value={item}>{tc(item)}</option>
            ))}
          </select>
          <select value={uploadedBy} onChange={(event) => { setUploadedBy(event.target.value); resetPagination(); }} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
            <option value="">{t("records.allUploaders")}</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.full_name}
              </option>
            ))}
          </select>
          <input value={customer} onChange={(event) => { setCustomer(event.target.value); resetPagination(); }} placeholder={t("records.customer")} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={supplier} onChange={(event) => { setSupplier(event.target.value); resetPagination(); }} placeholder={t("records.supplier")} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={mpn} onChange={(event) => { setMpn(event.target.value); resetPagination(); }} placeholder="MPN" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={manufacturer} onChange={(event) => { setManufacturer(event.target.value); resetPagination(); }} placeholder={t("records.manufacturer")} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={po} onChange={(event) => { setPo(event.target.value); resetPagination(); }} placeholder="PO" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={country} onChange={(event) => { setCountry(event.target.value); resetPagination(); }} placeholder={t("records.country")} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <select value={hasErrors} onChange={(event) => { setHasErrors(event.target.value); resetPagination(); }} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
            <option value="">{t("records.anyQuality")}</option>
            <option value="true">{t("records.hasErrors")}</option>
            <option value="false">{t("records.noErrors")}</option>
          </select>
        </div>
      </section>

      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      {loading ? (
        <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("records.loading")}</div>
      ) : (
        <>
          <DataTable records={records} />
          <div className="flex items-center justify-between">
            <button
              disabled={!cursorHistory.length}
              onClick={() => {
                const previous = cursorHistory.at(-1) ?? null;
                setCursorHistory((current) => current.slice(0, -1));
                setCursor(previous);
                setPage((current) => Math.max(1, current - 1));
              }}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              {t("records.previous")}
            </button>
            <span className="text-sm text-slate-500">{t("records.page")} {page}</span>
            <button
              disabled={!nextCursor}
              onClick={() => {
                setCursorHistory((current) => [...current, cursor]);
                setCursor(nextCursor);
                setPage((current) => current + 1);
              }}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              {t("records.next")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
