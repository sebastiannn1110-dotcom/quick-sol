"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, RefreshCw, SlidersHorizontal, Trophy } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  useVisiblePolling,
  type VisiblePollingContext
} from "@/components/useVisiblePolling";
import type {
  AnalyticsQuoteStatus,
  EmployeeAnalyticsFilters,
  EmployeeAnalyticsPayload,
  EmployeeQuoteMetrics
} from "@/lib/employee-analytics/contracts";
import type { Language } from "@/lib/i18n";
import type { BusinessRank } from "@/lib/organization/contracts";

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

const FILTER_PARAM_ORDER = [
  "country",
  "region",
  "department",
  "businessRank",
  "teamManagerId",
  "sellerId",
  "quoteStatus"
] as const satisfies ReadonlyArray<keyof EmployeeAnalyticsFilters>;

export function buildEmployeeAnalyticsEndpoint(filters: EmployeeAnalyticsFilters) {
  const searchParams = new URLSearchParams();
  for (const key of FILTER_PARAM_ORDER) {
    const value = filters[key];
    if (value) searchParams.set(key, value);
  }
  const query = searchParams.toString();
  return `/api/employee-analytics${query ? `?${query}` : ""}`;
}

export function reconcileEmployeeComparison(
  metrics: EmployeeQuoteMetrics[],
  current: { firstId: string; secondId: string }
) {
  const ids = new Set(metrics.map((metric) => metric.employeeId));
  const firstId = ids.has(current.firstId)
    ? current.firstId
    : metrics[0]?.employeeId ?? "";
  const secondId = ids.has(current.secondId) && current.secondId !== firstId
    ? current.secondId
    : metrics.find((metric) => metric.employeeId !== firstId)?.employeeId ?? firstId;
  return { firstId, secondId };
}

const COPY: Record<Language, {
  eyebrow: string;
  title: string;
  description: string;
  scope: Record<EmployeeAnalyticsPayload["scope"], string>;
  refresh: string;
  loading: string;
  loadError: string;
  filters: string;
  filtersHelp: string;
  country: string;
  region: string;
  department: string;
  businessRank: string;
  team: string;
  seller: string;
  quoteStatus: string;
  all: string;
  global: string;
  clearFilters: string;
  teamLabel: (name: string) => string;
  ranks: Record<BusinessRank, string>;
  statuses: Record<AnalyticsQuoteStatus, string>;
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
    filters: "Filters",
    filtersHelp: "Combine organization and current quote-status filters.",
    country: "Country",
    region: "Region",
    department: "Department",
    businessRank: "Business Rank",
    team: "Team / Manager",
    seller: "Seller",
    quoteStatus: "Quote status",
    all: "All",
    global: "Global",
    clearFilters: "Clear filters",
    teamLabel: (name) => `Team ${name}`,
    ranks: {
      owner: "Owner",
      executive: "Executive",
      director: "Director",
      manager: "Manager",
      salesperson: "Salesperson",
      sourcing_manager: "Sourcing Manager",
      sourcing_specialist: "Sourcing Specialist",
      individual_contributor: "Individual contributor"
    },
    statuses: {
      draft: "Draft",
      sent: "Sent",
      accepted: "Accepted",
      rejected: "Rejected",
      expired: "Expired"
    },
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
    filters: "Filtros",
    filtersHelp: "Combina filtros de organización y del estado actual de las cotizaciones.",
    country: "País",
    region: "Región",
    department: "Departamento",
    businessRank: "Rango empresarial",
    team: "Equipo / responsable",
    seller: "Vendedor",
    quoteStatus: "Estado de cotización",
    all: "Todos",
    global: "Global",
    clearFilters: "Limpiar filtros",
    teamLabel: (name) => `Equipo de ${name}`,
    ranks: {
      owner: "Propietario",
      executive: "Ejecutivo",
      director: "Director",
      manager: "Gerente",
      salesperson: "Vendedor",
      sourcing_manager: "Gerente de abastecimiento",
      sourcing_specialist: "Especialista de abastecimiento",
      individual_contributor: "Colaborador individual"
    },
    statuses: {
      draft: "Borrador",
      sent: "Enviada",
      accepted: "Aceptada",
      rejected: "Rechazada",
      expired: "Expirada"
    },
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
    filters: "筛选条件",
    filtersHelp: "可组合组织信息与报价当前状态筛选。",
    country: "国家",
    region: "区域",
    department: "部门",
    businessRank: "业务职级",
    team: "团队 / 经理",
    seller: "销售人员",
    quoteStatus: "报价状态",
    all: "全部",
    global: "全球",
    clearFilters: "清除筛选",
    teamLabel: (name) => `${name} 团队`,
    ranks: {
      owner: "所有者",
      executive: "高管",
      director: "总监",
      manager: "经理",
      salesperson: "销售人员",
      sourcing_manager: "采购经理",
      sourcing_specialist: "采购专员",
      individual_contributor: "个人贡献者"
    },
    statuses: {
      draft: "草稿",
      sent: "已发送",
      accepted: "已接受",
      rejected: "已拒绝",
      expired: "已过期"
    },
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
  const [filters, setFilters] = useState<EmployeeAnalyticsFilters>({});
  const endpoint = useMemo(() => buildEmployeeAnalyticsEndpoint(filters), [filters]);
  const endpointRef = useRef(endpoint);
  useEffect(() => {
    endpointRef.current = endpoint;
  }, [endpoint]);
  const [analyticsSnapshot, setAnalyticsSnapshot] = useState<{
    endpoint: string;
    analytics: EmployeeAnalyticsPayload;
  } | null>(null);
  const analytics = analyticsSnapshot?.endpoint === endpoint
    ? analyticsSnapshot.analytics
    : null;
  const optionAnalytics = analyticsSnapshot?.analytics ?? null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState({ firstId: "", secondId: "" });
  const filterRefreshReady = useRef(false);

  const load = useCallback(async ({ signal, trigger }: VisiblePollingContext) => {
    const requestEndpoint = endpoint;
    if (trigger === "initial" || trigger === "manual") setLoading(true);
    try {
      const response = await fetch(requestEndpoint, {
        cache: "no-store",
        signal
      });
      const payload = (await response.json().catch(() => null)) as {
        analytics?: EmployeeAnalyticsPayload;
      } | null;

      if (signal.aborted || endpointRef.current !== requestEndpoint) return;
      if (!response.ok || !payload?.analytics) {
        setError(copy.loadError);
        return;
      }

      setError("");
      setAnalyticsSnapshot({ endpoint: requestEndpoint, analytics: payload.analytics });
      setComparison((current) => reconcileEmployeeComparison(payload.analytics!.metrics, current));
    } catch {
      if (!signal.aborted && endpointRef.current === requestEndpoint) setError(copy.loadError);
    } finally {
      if (!signal.aborted && endpointRef.current === requestEndpoint) setLoading(false);
    }
  }, [copy.loadError, endpoint]);

  const { refresh } = useVisiblePolling(load, { intervalMs: 12_000 });

  useEffect(() => {
    if (!filterRefreshReady.current) {
      filterRefreshReady.current = true;
      return;
    }
    void refresh();
  }, [endpoint, refresh]);

  const firstId = comparison.firstId;
  const secondId = comparison.secondId;
  const hasFilters = Object.values(filters).some(Boolean);

  function updateFilter(key: keyof EmployeeAnalyticsFilters, value: string) {
    setLoading(true);
    setError("");
    setFilters((current) => {
      const next = { ...current } as Record<string, string | undefined>;
      if (value) next[key] = value;
      else delete next[key];
      return next as EmployeeAnalyticsFilters;
    });
  }

  function clearFilters() {
    setLoading(true);
    setError("");
    setFilters({});
  }

  const first = useMemo(
    () => analytics?.metrics.find((metric) => metric.employeeId === firstId) || null,
    [analytics, firstId]
  );
  const second = useMemo(
    () => analytics?.metrics.find((metric) => metric.employeeId === secondId) || null,
    [analytics, secondId]
  );

  if (loading && !analyticsSnapshot) {
    return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{copy.loading}</div>;
  }

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-orange-700">{copy.eyebrow}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{copy.title}</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            {copy.description} <span className="font-semibold">{copy.scope[analytics?.scope || optionAnalytics?.scope || "self"]}</span>.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> {copy.refresh}
        </button>
      </header>

      {error ? <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p> : null}

      {optionAnalytics ? (
          <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm" aria-label={copy.filters}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-2">
                <SlidersHorizontal className="mt-0.5 h-5 w-5 text-brand-600" />
                <div>
                  <h2 className="font-semibold text-slate-950">{copy.filters}</h2>
                  <p className="mt-1 text-sm text-slate-500">{copy.filtersHelp}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={clearFilters}
                disabled={!hasFilters || loading}
                className="focus-ring min-h-10 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 disabled:opacity-50"
              >
                {copy.clearFilters}
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                {copy.country}
                <select aria-label={copy.country} value={filters.country ?? ""} onChange={(event) => updateFilter("country", event.target.value)} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">
                  <option value="">{copy.all}</option>
                  {optionAnalytics.filterOptions.countries.map((country) => <option key={country} value={country}>{country}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                {copy.region}
                <select aria-label={copy.region} value={filters.region ?? ""} onChange={(event) => updateFilter("region", event.target.value)} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">
                  <option value="">{copy.global}</option>
                  {optionAnalytics.filterOptions.regions.map((region) => <option key={region} value={region}>{region}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                {copy.department}
                <select aria-label={copy.department} value={filters.department ?? ""} onChange={(event) => updateFilter("department", event.target.value)} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">
                  <option value="">{copy.all}</option>
                  {optionAnalytics.filterOptions.departments.map((department) => <option key={department} value={department}>{department}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                {copy.businessRank}
                <select aria-label={copy.businessRank} value={filters.businessRank ?? ""} onChange={(event) => updateFilter("businessRank", event.target.value)} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">
                  <option value="">{copy.all}</option>
                  {optionAnalytics.filterOptions.businessRanks.map((rank) => <option key={rank} value={rank}>{copy.ranks[rank]}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                {copy.team}
                <select aria-label={copy.team} value={filters.teamManagerId ?? ""} onChange={(event) => updateFilter("teamManagerId", event.target.value)} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">
                  <option value="">{copy.all}</option>
                  {optionAnalytics.filterOptions.teams.map((team) => <option key={team.managerId} value={team.managerId}>{copy.teamLabel(team.name)} ({team.memberCount})</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                {copy.seller}
                <select aria-label={copy.seller} value={filters.sellerId ?? ""} onChange={(event) => updateFilter("sellerId", event.target.value)} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">
                  <option value="">{copy.all}</option>
                  {optionAnalytics.filterOptions.sellers.map((seller) => <option key={seller.employeeId} value={seller.employeeId}>{seller.name}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                {copy.quoteStatus}
                <select aria-label={copy.quoteStatus} value={filters.quoteStatus ?? ""} onChange={(event) => updateFilter("quoteStatus", event.target.value)} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">
                  <option value="">{copy.all}</option>
                  {optionAnalytics.filterOptions.quoteStatuses.map((status) => <option key={status} value={status}>{copy.statuses[status]}</option>)}
                </select>
              </label>
            </div>
          </section>
      ) : null}

      {!analytics && loading ? (
        <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{copy.loading}</div>
      ) : null}

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
                {[
                  { key: "firstId" as const, value: firstId, label: copy.employeeA },
                  { key: "secondId" as const, value: secondId, label: copy.employeeB }
                ].map((selector) => (
                  <label key={selector.key} className="grid gap-1 text-xs font-semibold text-slate-600">{selector.label}<select value={selector.value} onChange={(event) => setComparison((current) => ({ ...current, [selector.key]: event.target.value }))} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">{analytics.metrics.map((metric) => <option key={metric.employeeId} value={metric.employeeId}>{metric.name}</option>)}</select></label>
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
