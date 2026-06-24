"use client";

import { useCallback, useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import SearchBar from "@/components/SearchBar";
import { clientLogger } from "@/lib/logger/clientLogger";
import type { PlatformRecord, Profile } from "@/lib/types";

interface RecordsPayload {
  records: PlatformRecord[];
  employees: Profile[];
  count: number;
  page: number;
  pageSize: number;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRecords = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: "25" });
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
      const response = await fetch(`/api/records?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as RecordsPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to load records.");
      clientLogger.searchExecuted({
        query,
        category,
        uploadedBy,
        count: payload.count
      });
      setRecords(payload.records ?? []);
      setEmployees(payload.employees ?? []);
      setCount(payload.count ?? 0);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load records.");
    } finally {
      setLoading(false);
    }
  }, [category, country, customer, hasErrors, manufacturer, mpn, page, po, query, supplier, uploadedBy]);

  useEffect(() => {
    const timeout = window.setTimeout(loadRecords, 250);
    return () => window.clearTimeout(timeout);
  }, [loadRecords]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-brand-700">Search and traceability</p>
          <h1 className="text-2xl font-semibold text-slate-950">My Records</h1>
        </div>
        <div className="text-sm text-slate-500">
          <span className="font-semibold text-slate-950">{count}</span> matching records
        </div>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <SearchBar
              value={query}
              onChange={(value) => {
                setQuery(value);
                setPage(1);
              }}
              placeholder="Search by customer, supplier, MPN, line ID, PO, QPDDD, description or comments"
            />
          </div>
          <select value={category} onChange={(event) => setCategory(event.target.value)} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
            <option value="">All categories</option>
            {CATEGORIES.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <select value={uploadedBy} onChange={(event) => setUploadedBy(event.target.value)} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
            <option value="">All uploaders</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.full_name}
              </option>
            ))}
          </select>
          <input value={customer} onChange={(event) => setCustomer(event.target.value)} placeholder="Customer" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder="Supplier" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={mpn} onChange={(event) => setMpn(event.target.value)} placeholder="MPN" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} placeholder="Manufacturer" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={po} onChange={(event) => setPo(event.target.value)} placeholder="PO" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <input value={country} onChange={(event) => setCountry(event.target.value)} placeholder="Country" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
          <select value={hasErrors} onChange={(event) => setHasErrors(event.target.value)} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
            <option value="">Any quality state</option>
            <option value="true">Has errors</option>
            <option value="false">No errors</option>
          </select>
        </div>
      </section>

      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      {loading ? (
        <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Loading records...</div>
      ) : (
        <>
          <DataTable records={records} />
          <div className="flex items-center justify-between">
            <button
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-sm text-slate-500">Page {page}</span>
            <button
              disabled={page * 25 >= count}
              onClick={() => setPage((current) => current + 1)}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
