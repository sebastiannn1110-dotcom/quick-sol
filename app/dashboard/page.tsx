"use client";

import { useEffect, useState } from "react";
import AnalyticsCards, { ChartCard } from "@/components/AnalyticsCards";
import { useLanguage } from "@/components/LanguageProvider";
import type { PlatformAnalyticsSummary } from "@/lib/types";

export default function DashboardPage() {
  const { t } = useLanguage();
  const [analytics, setAnalytics] = useState<PlatformAnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadAnalytics() {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch("/api/analytics", { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as {
          analytics?: PlatformAnalyticsSummary;
          error?: string;
        } | null;
        if (!response.ok || !payload?.analytics) throw new Error(payload?.error ?? t("dashboard.unavailable"));
        setAnalytics(payload.analytics);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : t("dashboard.unavailable"));
      } finally {
        setLoading(false);
      }
    }

    loadAnalytics();
  }, [t]);

  if (loading) {
    return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("dashboard.loading")}</div>;
  }

  if (error || !analytics) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error ?? t("dashboard.unavailable")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-brand-700">{t("dashboard.eyebrow")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("dashboard.title")}</h1>
        </div>
        <p className="text-sm text-slate-500">{t("dashboard.protected")}</p>
      </div>

      <AnalyticsCards analytics={analytics} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Records by customer" items={analytics.recordsByCustomer} />
        <ChartCard title="Records by supplier" items={analytics.recordsBySupplier} />
        <ChartCard title="Records by department" items={analytics.recordsByDepartment} />
        <ChartCard title="Uploads over time" items={analytics.recordsOverTime} />
      </div>
    </div>
  );
}
