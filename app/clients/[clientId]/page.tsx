"use client";

import Link from "next/link";
import { ArrowLeft, Building2, Pencil } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import ClientFiles from "@/components/clients/ClientFiles";
import ClientOpportunities from "@/components/clients/ClientOpportunities";
import EmployeeGuard from "@/components/EmployeeGuard";
import { useLanguage } from "@/components/LanguageProvider";
import type { ClientDetail, ClientUpload } from "@/lib/clients/clients";

type Tab = "summary" | "opportunities" | "files" | "information";

export default function ClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const { t } = useLanguage();
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [uploads, setUploads] = useState<ClientUpload[]>([]);
  const [tab, setTab] = useState<Tab>("summary");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [clientResponse, uploadsResponse] = await Promise.all([
          fetch(`/api/clients/${clientId}`, { cache: "no-store" }),
          fetch(`/api/clients/${clientId}/uploads`, { cache: "no-store" })
        ]);
        if (!clientResponse.ok) throw new Error();
        setClient((await clientResponse.json() as { client: ClientDetail }).client);
        if (uploadsResponse.ok) setUploads((await uploadsResponse.json() as { uploads: ClientUpload[] }).uploads);
      } catch {
        setError(t("clients.error"));
      } finally {
        setLoading(false);
      }
    }
    if (clientId) void load();
  }, [clientId, t]);

  if (loading) return <EmployeeGuard><div className="py-10 text-center text-sm text-slate-500">{t("clients.loading")}</div></EmployeeGuard>;
  if (error || !client) return <EmployeeGuard><div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error || t("clients.error")}</div></EmployeeGuard>;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "summary", label: t("clientDetail.summary") },
    { id: "opportunities", label: t("clientDetail.opportunities") },
    { id: "files", label: t("clientDetail.files") },
    { id: "information", label: t("clientDetail.information") }
  ];
  const summary = [
    [t("opportunities.metrics.total"), client.opportunityCount],
    [t("clients.immediateSales"), client.immediateSaleCount],
    [t("clients.partialSales"), client.partialSaleCount],
    [t("clients.sourcingNeeded"), client.sourcingNeededCount],
    [t("clients.stockWithoutDemand"), client.stockWithoutDemandCount],
    [t("opportunities.metrics.highConfidence"), `${client.highConfidenceCount}${client.highConfidenceTruncated ? "+" : ""}`],
    [t("clients.files"), client.fileCount],
    [t("clients.mpns"), client.mpnCount]
  ];

  return (
    <EmployeeGuard>
      <div className="space-y-6">
        <Link href="/clients" className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-950">
          <ArrowLeft className="h-4 w-4" />
          {t("clientDetail.back")}
        </Link>
        <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-center">
          <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-white">
            {client.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={client.logoUrl} alt="" className="h-full w-full object-contain p-2" />
            ) : <Building2 className="h-12 w-12 text-slate-300" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="break-words text-2xl font-semibold text-slate-950">{client.name}</h1>
              <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">{t(client.status === "active" ? "clients.status.active" : "clients.status.archived")}</span>
            </div>
            <p className="mt-1 text-sm text-slate-500">{client.description ?? t("clientDetail.noDescription")}</p>
          </div>
          {client.canManage ? (
            <Link href={`/admin/clients/${client.id}/edit`} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <Pencil className="h-4 w-4" />
              {t("clientDetail.edit")}
            </Link>
          ) : null}
        </header>

        <div className="flex gap-2 overflow-x-auto border-b border-slate-200">
          {tabs.map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`min-w-fit border-b-2 px-3 py-2 text-sm font-medium ${tab === item.id ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-900"}`}>
              {item.label}
            </button>
          ))}
        </div>

        {tab === "summary" ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            {summary.map(([label, value]) => (
              <div key={label} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>
        ) : null}
        {tab === "opportunities" ? <ClientOpportunities clientId={client.id} /> : null}
        {tab === "files" ? <ClientFiles uploads={uploads} /> : null}
        {tab === "information" ? (
          <div className="grid gap-4 border-y border-slate-200 bg-white py-5 sm:grid-cols-2">
            <div><p className="text-xs font-medium uppercase text-slate-500">{t("clientDetail.industry")}</p><p className="mt-1 text-slate-800">{client.industry ?? "-"}</p></div>
            <div><p className="text-xs font-medium uppercase text-slate-500">{t("clientDetail.region")}</p><p className="mt-1 text-slate-800">{client.region ?? "-"}</p></div>
            <div><p className="text-xs font-medium uppercase text-slate-500">{t("clientDetail.website")}</p><p className="mt-1 break-all text-slate-800">{client.website ?? "-"}</p></div>
            <div><p className="text-xs font-medium uppercase text-slate-500">{t("clientDetail.description")}</p><p className="mt-1 text-slate-800">{client.description ?? "-"}</p></div>
            {client.privateDetails?.identificationImageUrl ? (
              <div className="sm:col-span-2">
                <p className="text-xs font-medium uppercase text-slate-500">{t("adminClient.identification")}</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={client.privateDetails.identificationImageUrl} alt="" className="mt-2 max-h-64 max-w-full rounded-md border border-slate-200 object-contain" />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </EmployeeGuard>
  );
}
