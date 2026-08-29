"use client";

import { useCallback, useMemo, useState } from "react";
import { BarChart3, RefreshCw, Trophy } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  useVisiblePolling,
  type VisiblePollingContext
} from "@/components/useVisiblePolling";
import type {
  EmployeeAnalyticsPayload,
  EmployeeQuoteMetrics
} from "@/lib/employee-analytics/contracts";
import type { Language } from "@/lib/i18n";

const METRIC_LABELS = [
  "Quotes Created",
  "Quotes Sent",
  "Quotes Accepted",
  "Quotes Rejected",
  "Quote Conversion Rate",
  "Quoted Value",
  "Accepted Quote Value",
  "Customers Served",
  "New Customers"
] as const;
const COMPARISON_LABELS = [
  "Quote Count",
  "Accepted Count",
  "Conversion",
  "Quoted Value",
  "Accepted Value",
  "Clients Served"
] as const;

type MetricLabel = (typeof METRIC_LABELS)[number];
type ComparisonLabel = (typeof COMPARISON_LABELS)[number];

const COPY: Record<Language, {
  eyebrow: string;
  title: string;
  description: string;
  scope: Record<EmployeeAnalyticsPayload["scope"], string>;
  refresh: string;
  loading: string;
  loadError: string;
  metrics: Record<MetricLabel, string>;
  ranking: string;
  employee: string;
  accepted: string;
  noActivity: string;
  compare: string;
  employeeA: string;
  employeeB: string;
  metric: string;
  comparisons: Record<ComparisonLabel, string>;
  selectTwo: string;
  regional: string;
  regionalHelp: string;
  employeeCount: (count: number) => string;
}> = {
  en: {
    eyebrow: "Commercial performance",
    title: "Employee Analytics",
    description: "Derived from quote lines and immutable quote events. Scope:",
    scope: { self: "self", subtree: "organization subtree", global: "global" },
    refresh: "Refresh",
    loading: "Loading Employee Analytics...",
    loadError: "Employee Analytics could not be loaded.",
    metrics: {
      "Quotes Created": "Quotes Created",
      "Quotes Sent": "Quotes Sent",
      "Quotes Accepted": "Quotes Accepted",
      "Quotes Rejected": "Quotes Rejected",
      "Quote Conversion Rate": "Quote Conversion Rate",
      "Quoted Value": "Quoted Value",
      "Accepted Quote Value": "Accepted Quote Value",
      "Customers Served": "Customers Served",
      "New Customers": "New Customers"
    },
    ranking: "Employee ranking",
    employee: "Employee",
    accepted: "Accepted",
    noActivity: "No quote activity in this scope.",
    compare: "Compare employees",
    employeeA: "Employee A",
    employeeB: "Employee B",
    metric: "Metric",
    comparisons: {
      "Quote Count": "Quote Count",
      "Accepted Count": "Accepted Count",
      Conversion: "Conversion",
      "Quoted Value": "Quoted Value",
      "Accepted Value": "Accepted Value",
      "Clients Served": "Clients Served"
    },
    selectTwo: "Select two employees to compare.",
    regional: "Regional grouping",
    regionalHelp: "Shown only for regions available in employee profiles.",
    employeeCount: (count) => `${count} employee${count === 1 ? "" : "s"}`
  },
  es: {
    eyebrow: "Rendimiento comercial",
    title: "Analítica de empleados",
    description: "Derivada de las líneas de cotización y de eventos inmutables. Alcance:",
    scope: { self: "propio", subtree: "subárbol organizacional", global: "global" },
    refresh: "Actualizar",
    loading: "Cargando analítica de empleados...",
    loadError: "No se pudo cargar la analítica de empleados.",
    metrics: {
      "Quotes Created": "Cotizaciones creadas",
      "Quotes Sent": "Cotizaciones enviadas",
      "Quotes Accepted": "Cotizaciones aceptadas",
      "Quotes Rejected": "Cotizaciones rechazadas",
      "Quote Conversion Rate": "Tasa de conversión de cotizaciones",
      "Quoted Value": "Valor cotizado",
      "Accepted Quote Value": "Valor de cotizaciones aceptadas",
      "Customers Served": "Clientes atendidos",
      "New Customers": "Clientes nuevos"
    },
    ranking: "Ranking de empleados",
    employee: "Empleado",
    accepted: "Aceptadas",
    noActivity: "No hay actividad de cotizaciones en este alcance.",
    compare: "Comparar empleados",
    employeeA: "Empleado A",
    employeeB: "Empleado B",
    metric: "Métrica",
    comparisons: {
      "Quote Count": "Cantidad de cotizaciones",
      "Accepted Count": "Cantidad aceptada",
      Conversion: "Conversión",
      "Quoted Value": "Valor cotizado",
      "Accepted Value": "Valor aceptado",
      "Clients Served": "Clientes atendidos"
    },
    selectTwo: "Selecciona dos empleados para comparar.",
    regional: "Agrupación regional",
    regionalHelp: "Se muestra solo para regiones disponibles en los perfiles.",
    employeeCount: (count) => `${count} empleado${count === 1 ? "" : "s"}`
  },
  zh: {
    eyebrow: "商业表现",
    title: "员工分析",
    description: "数据来自报价行和不可变报价事件。范围：",
    scope: { self: "本人", subtree: "组织子树", global: "全局" },
    refresh: "刷新",
    loading: "正在加载员工分析...",
    loadError: "无法加载员工分析。",
    metrics: {
      "Quotes Created": "已创建报价",
      "Quotes Sent": "已发送报价",
      "Quotes Accepted": "已接受报价",
      "Quotes Rejected": "已拒绝报价",
      "Quote Conversion Rate": "报价转化率",
      "Quoted Value": "报价金额",
      "Accepted Quote Value": "已接受报价金额",
      "Customers Served": "已服务客户",
      "New Customers": "新客户"
    },
    ranking: "员工排名",
    employee: "员工",
    accepted: "已接受",
    noActivity: "当前范围内没有报价活动。",
    compare: "员工对比",
    employeeA: "员工 A",
    employeeB: "员工 B",
    metric: "指标",
    comparisons: {
      "Quote Count": "报价数量",
      "Accepted Count": "接受数量",
      Conversion: "转化率",
      "Quoted Value": "报价金额",
      "Accepted Value": "已接受金额",
      "Clients Served": "已服务客户"
    },
    selectTwo: "请选择两名员工进行对比。",
    regional: "区域分组",
    regionalHelp: "仅显示员工档案中已有的区域。",
    employeeCount: (count) => `${count} 名员工`
  }
};

function money(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function number(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}

function metricValue(
  label: MetricLabel,
  analytics: EmployeeAnalyticsPayload,
  locale: string
) {
  const totals = analytics.totals;
  switch (label) {
    case "Quotes Created": return number(totals.quotesCreated, locale);
    case "Quotes Sent": return number(totals.quotesSent, locale);
    case "Quotes Accepted": return number(totals.quotesAccepted, locale);
    case "Quotes Rejected": return number(totals.quotesRejected, locale);
    case "Quote Conversion Rate": return `${totals.quoteConversionRate.toFixed(2)}%`;
    case "Quoted Value": return money(totals.quotedValue, locale);
    case "Accepted Quote Value": return money(totals.acceptedQuoteValue, locale);
    case "Customers Served": return number(totals.customersServed, locale);
    case "New Customers": return number(totals.newCustomers, locale);
  }
}

function comparisonValue(
  metric: EmployeeQuoteMetrics,
  key: ComparisonLabel,
  locale: string
) {
  switch (key) {
    case "Quote Count": return number(metric.quotesCreated, locale);
    case "Accepted Count": return number(metric.quotesAccepted, locale);
    case "Conversion": return `${metric.quoteConversionRate.toFixed(2)}%`;
    case "Quoted Value": return money(metric.quotedValue, locale);
    case "Accepted Value": return money(metric.acceptedQuoteValue, locale);
    case "Clients Served": return number(metric.customersServed, locale);
  }
}

export default function EmployeeAnalyticsDashboard() {
  const { language, locale } = useLanguage();
  const copy = COPY[language];
  const [analytics, setAnalytics] = useState<EmployeeAnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [firstId, setFirstId] = useState("");
  const [secondId, setSecondId] = useState("");

  const load = useCallback(async ({ signal, trigger }: VisiblePollingContext) => {
    if (trigger === "initial" || trigger === "manual") setLoading(true);
    try {
      const response = await fetch("/api/employee-analytics", {
        cache: "no-store",
        signal
      });
      const payload = (await response.json().catch(() => null)) as {
        analytics?: EmployeeAnalyticsPayload;
      } | null;

      if (signal.aborted) return;
      if (!response.ok || !payload?.analytics) {
        setError(copy.loadError);
        return;
      }

      setError("");
      setAnalytics(payload.analytics);
      setFirstId((current) => current || payload.analytics!.metrics[0]?.employeeId || "");
      setSecondId((current) => current || payload.analytics!.metrics[1]?.employeeId || payload.analytics!.metrics[0]?.employeeId || "");
    } catch {
      if (!signal.aborted) setError(copy.loadError);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [copy.loadError]);

  const { refresh } = useVisiblePolling(load, { intervalMs: 12_000 });

  const first = useMemo(
    () => analytics?.metrics.find((metric) => metric.employeeId === firstId) || null,
    [analytics, firstId]
  );
  const second = useMemo(
    () => analytics?.metrics.find((metric) => metric.employeeId === secondId) || null,
    [analytics, secondId]
  );

  if (loading && !analytics) {
    return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{copy.loading}</div>;
  }

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-orange-700">{copy.eyebrow}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{copy.title}</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            {copy.description} <span className="font-semibold">{copy.scope[analytics?.scope || "self"]}</span>.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> {copy.refresh}
        </button>
      </header>

      {error ? <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p> : null}

      {analytics ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {METRIC_LABELS.map((label) => (
              <article key={label} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{copy.metrics[label]}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{metricValue(label, analytics, locale)}</p>
              </article>
            ))}
          </section>

          <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <article className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4">
                <Trophy className="h-5 w-5 text-orange-600" />
                <div><h2 className="font-semibold text-slate-950">{copy.ranking}</h2><p className="text-xs font-medium text-slate-500">{copy.metrics["Accepted Quote Value"]}</p></div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">#</th><th className="px-4 py-3">{copy.employee}</th><th className="px-4 py-3">{copy.accepted}</th><th className="px-4 py-3">{copy.metrics["Accepted Quote Value"]}</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {analytics.ranking.map((metric, index) => (
                      <tr key={metric.employeeId}>
                        <td className="px-4 py-3 font-semibold text-slate-500">{index + 1}</td>
                        <td className="px-4 py-3"><p className="font-semibold text-slate-950">{metric.name}</p><p className="text-xs text-slate-500">{metric.businessTitle || metric.businessRank}</p></td>
                        <td className="px-4 py-3 text-slate-700">{metric.quotesAccepted}</td>
                        <td className="px-4 py-3 font-semibold text-slate-950">{money(metric.acceptedQuoteValue, locale)}</td>
                      </tr>
                    ))}
                    {!analytics.ranking.length ? <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">{copy.noActivity}</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-brand-600" /><h2 className="font-semibold text-slate-950">{copy.compare}</h2></div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[{ value: firstId, set: setFirstId, label: copy.employeeA }, { value: secondId, set: setSecondId, label: copy.employeeB }].map((selector) => (
                  <label key={selector.label} className="grid gap-1 text-xs font-semibold text-slate-600">{selector.label}<select value={selector.value} onChange={(event) => selector.set(event.target.value)} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">{analytics.metrics.map((metric) => <option key={metric.employeeId} value={metric.employeeId}>{metric.name}</option>)}</select></label>
                ))}
              </div>
              {first && second ? (
                <div className="mt-5 overflow-hidden rounded-md border border-slate-200">
                  <div className="grid grid-cols-[1.1fr_1fr_1fr] bg-slate-50 text-xs font-semibold text-slate-600"><span className="p-2">{copy.metric}</span><span className="p-2">{first.name}</span><span className="p-2">{second.name}</span></div>
                  {COMPARISON_LABELS.map((label) => (
                    <div key={label} className="grid grid-cols-[1.1fr_1fr_1fr] border-t border-slate-100 text-xs"><span className="p-2 font-medium text-slate-600">{copy.comparisons[label]}</span><span className="p-2 text-slate-900">{comparisonValue(first, label, locale)}</span><span className="p-2 text-slate-900">{comparisonValue(second, label, locale)}</span></div>
                  ))}
                </div>
              ) : <p className="mt-4 text-sm text-slate-500">{copy.selectTwo}</p>}
            </article>
          </section>

          {analytics.regions.length ? (
            <section className="space-y-3">
              <div><h2 className="text-lg font-semibold text-slate-950">{copy.regional}</h2><p className="text-sm text-slate-500">{copy.regionalHelp}</p></div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {analytics.regions.map((region) => (
                  <article key={region.region} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between"><div><h3 className="font-semibold text-slate-950">{region.region}</h3><p className="text-xs text-slate-500">{copy.employeeCount(region.employeeCount)}</p></div><p className="text-sm font-semibold text-brand-700">{region.quoteConversionRate.toFixed(2)}%</p></div>
                    <dl className="mt-4 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-slate-500">{copy.metrics["Accepted Quote Value"]}</dt><dd className="mt-1 font-semibold text-slate-950">{money(region.acceptedQuoteValue, locale)}</dd></div><div><dt className="text-slate-500">{copy.metrics["Quoted Value"]}</dt><dd className="mt-1 font-semibold text-slate-950">{money(region.quotedValue, locale)}</dd></div></dl>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
