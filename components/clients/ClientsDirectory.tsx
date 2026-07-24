"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import ClientGrid from "@/components/clients/ClientGrid";
import { useLanguage } from "@/components/LanguageProvider";
import { EMPTY_OPPORTUNITIES_RESULT } from "@/components/opportunities/opportunity-ui";
import type { AccountClient } from "@/lib/clients/clients";
import type { SalesOpportunitiesWithConfidenceResult } from "@/lib/opportunities/quality";
import type { Profile } from "@/lib/types";

export default function ClientsDirectory({ adminMode = false }: { adminMode?: boolean }) {
  const { t } = useLanguage();
  const [clients, setClients] = useState<AccountClient[]>([]);
  const [opportunities, setOpportunities] = useState<SalesOpportunitiesWithConfidenceResult>(EMPTY_OPPORTUNITIES_RESULT);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [clientsResponse, profileResponse, opportunitiesResponse] = await Promise.all([
          fetch(`/api/clients${adminMode ? "?includeArchived=true" : ""}`, { cache: "no-store" }),
          fetch("/api/me", { cache: "no-store" }),
          fetch("/api/opportunities?limit=200", { cache: "no-store" })
        ]);
        if (!clientsResponse.ok) throw new Error();
        const payload = await clientsResponse.json() as { clients: AccountClient[] };
        setClients(payload.clients);
        if (profileResponse.ok) setProfile((await profileResponse.json() as { profile: Profile }).profile);
        if (opportunitiesResponse.ok) setOpportunities(await opportunitiesResponse.json() as SalesOpportunitiesWithConfidenceResult);
      } catch {
        setError(t("clients.error"));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [adminMode, t]);

  const canManage = profile?.role === "admin" || profile?.role === "manager";
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-brand-700">{t("clients.eyebrow")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("clients.title")}</h1>
          <p className="text-sm text-slate-500">{t("clients.description")}</p>
        </div>
        {canManage ? (
          <Link href="/admin/clients/new" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">
            <Plus className="h-4 w-4" />
            {t("clients.create")}
          </Link>
        ) : null}
      </div>
      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      {!adminMode ? (
        <section className="space-y-4 border-y border-slate-200 py-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-slate-950">{t("clients.opportunitiesTitle")}</h2>
            <Link href="/opportunities" className="inline-flex min-h-11 items-center justify-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">
              {t("clients.viewAllOpportunities")}
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              [t("opportunities.metrics.total"), opportunities.totals.totalOpportunities],
              [t("opportunities.metrics.immediate"), opportunities.totals.immediateSale],
              [t("opportunities.metrics.partial"), opportunities.totals.partialSale],
              [t("opportunities.metrics.sourcing"), opportunities.totals.sourcingNeeded],
              [t("opportunities.metrics.highConfidence"), `${opportunities.totals.highConfidence}${opportunities.meta.confidenceTruncated ? "+" : ""}`]
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
                <p className="mt-2 text-xl font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <ClientGrid clients={clients} loading={loading} canManage={canManage} />
    </div>
  );
}
