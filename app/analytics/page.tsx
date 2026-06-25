"use client";

import { useEffect, useState } from "react";
import AnalyticsCards, { ChartCard, MetricCard } from "@/components/AnalyticsCards";
import { useLanguage } from "@/components/LanguageProvider";
import type { AnalyticsModule, PlatformAnalyticsSummary } from "@/lib/types";

function ModuleSection({ title, module }: { title: string; module: AnalyticsModule }) {
  const { t, tc } = useLanguage();

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-950">{tc(title)} {t("analytics.moduleSuffix")}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {module.stats.map((stat) => (
          <MetricCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Object.entries(module.groups).map(([groupTitle, items]) => (
          <ChartCard key={groupTitle} title={groupTitle} items={items} />
        ))}
      </div>
    </section>
  );
}

export default function AnalyticsPage() {
  const { t } = useLanguage();
  const [analytics, setAnalytics] = useState<PlatformAnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAnalytics() {
      setLoading(true);
      const response = await fetch("/api/analytics", { cache: "no-store" });
      const payload = (await response.json()) as { analytics: PlatformAnalyticsSummary };
      setAnalytics(payload.analytics);
      setLoading(false);
    }

    loadAnalytics();
  }, []);

  if (loading || !analytics) {
    return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("analytics.loading")}</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-medium text-brand-700">{t("analytics.eyebrow")}</p>
        <h1 className="text-2xl font-semibold text-slate-950">{t("analytics.title")}</h1>
      </div>
      <AnalyticsCards analytics={analytics} />
      {Object.entries(analytics.categoryModules).map(([title, module]) => (
        <ModuleSection key={title} title={title} module={module} />
      ))}
    </div>
  );
}
