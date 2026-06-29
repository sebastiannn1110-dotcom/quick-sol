"use client";

import { useEffect, useState } from "react";
import { ChartCard, MetricCard } from "@/components/AnalyticsCards";
import { useLanguage } from "@/components/LanguageProvider";
import type { PlatformAnalyticsSummary } from "@/lib/types";

export default function CategoriesPage() {
  const { t, tc } = useLanguage();
  const [analytics, setAnalytics] = useState<PlatformAnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadAnalytics() {
      try {
        const response = await fetch("/api/analytics", { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as {
          analytics?: PlatformAnalyticsSummary;
          error?: string;
        } | null;
        if (!response.ok || !payload?.analytics) throw new Error(payload?.error ?? t("dashboard.unavailable"));
        setAnalytics(payload.analytics);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : t("dashboard.unavailable"));
      }
    }
    loadAnalytics();
  }, [t]);

  if (!analytics) {
    if (error) {
      return <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>;
    }
    return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("categories.loading")}</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-700">{t("categories.eyebrow")}</p>
        <h1 className="text-2xl font-semibold text-slate-950">{t("categories.title")}</h1>
      </div>
      {Object.entries(analytics.categoryModules).map(([category, module]) => (
        <section key={category} className="space-y-4 rounded-md border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950">{tc(category)}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {module.stats.map((stat) => (
              <MetricCard key={stat.label} label={stat.label} value={stat.value} />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {Object.entries(module.groups).slice(0, 2).map(([title, items]) => (
              <ChartCard key={title} title={title} items={items} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
