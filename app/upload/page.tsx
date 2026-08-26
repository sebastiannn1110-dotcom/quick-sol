"use client";

import { useCallback, useEffect, useState } from "react";
import ColumnMapper from "@/components/ColumnMapper";
import { useLanguage } from "@/components/LanguageProvider";
import UploadExcelCard from "@/components/UploadExcelCard";
import UploadHistory from "@/components/UploadHistory";
import type { BusinessCategory, UploadBatch } from "@/lib/types";

interface UploadResult {
  recordsUploaded: number;
  detectedCategory: string;
  dataQualityScore?: number;
}

export default function UploadPage() {
  const { t } = useLanguage();
  const [uploads, setUploads] = useState<UploadBatch[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsError, setClientsError] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState("");

  const loadUploads = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/upload", { cache: "no-store" });
    const payload = (await response.json()) as { uploads: UploadBatch[] };
    setUploads(payload.uploads ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadUploads();
  }, [loadUploads]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadClients() {
      setClientsLoading(true);
      setClientsError("");
      try {
        const response = await fetch("/api/upload/clients", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("UPLOAD_CLIENTS_FAILED");
        const payload = await response.json() as { clients: Array<{ id: string; name: string }> };
        const available = payload.clients ?? [];
        setClients(available);
        const requestedClientId = new URLSearchParams(window.location.search).get("clientId") ?? "";
        if (available.some((client) => client.id === requestedClientId)) setSelectedClientId(requestedClientId);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setClientsError(t("upload.clientsError"));
      } finally {
        if (!controller.signal.aborted) setClientsLoading(false);
      }
    }
    void loadClients();
    return () => controller.abort();
  }, [t]);

  const filteredClients = clients.filter((client) =>
    client.name.toLocaleLowerCase().includes(clientSearch.trim().toLocaleLowerCase())
  );
  const selectedClient = clients.find((client) => client.id === selectedClientId) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-700">{t("upload.eyebrow")}</p>
        <h1 className="text-2xl font-semibold text-slate-950">{t("upload.title")}</h1>
      </div>
      <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold text-slate-950">{t("upload.clientQuestion")}</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            {t("upload.clientSearch")}
            <input
              type="search"
              value={clientSearch}
              onChange={(event) => setClientSearch(event.target.value)}
              placeholder={t("upload.clientSearchPlaceholder")}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            {t("upload.company")}
            <select
              value={selectedClientId}
              onChange={(event) => setSelectedClientId(event.target.value)}
              disabled={clientsLoading}
              className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-950 disabled:opacity-60"
            >
              <option value="">{clientsLoading ? t("clients.loading") : t("upload.selectClient")}</option>
              {filteredClients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
          </label>
        </div>
        {clientsError ? <p className="mt-3 text-sm font-medium text-red-700">{clientsError}</p> : null}
        {!clientsLoading && !clientsError && clients.length === 0 ? (
          <p className="mt-3 text-sm text-amber-800">{t("upload.noClients")}</p>
        ) : null}
      </section>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
        <UploadExcelCard
          client={selectedClient}
          onStatusChange={loadUploads}
          onUploaded={(uploadResult) => {
            setResult({
              detectedCategory: uploadResult.detectedCategory,
              recordsUploaded: uploadResult.recordsUploaded,
              dataQualityScore: uploadResult.dataQualityScore
            });
            loadUploads();
          }}
        />
        <ColumnMapper
          detectedCategory={(result?.detectedCategory ?? "Generic") as BusinessCategory}
          recordsUploaded={result?.recordsUploaded}
        />
      </div>
      {loading ? (
        <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("upload.loadingHistory")}</div>
      ) : (
        <UploadHistory uploads={uploads} />
      )}
    </div>
  );
}
