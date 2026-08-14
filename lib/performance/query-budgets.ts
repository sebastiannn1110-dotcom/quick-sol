export const QUERY_BUDGETS = {
  clientsInitial: 5,
  recordsPage: 2,
  recordsFilterOptions: 1,
  executiveMpn: 1,
  opportunityFinderStatus: 1,
  opportunityFinderTerminal: 5,
  opportunityFinderSupplemental: 2,
  dashboardAssistant: 2,
  stockPage: 1,
  opportunitiesPage: 2
} as const;

export type SafePerformanceMetric = {
  route: string;
  dbTimeMs: number;
  queryCount: number;
  rows: number;
  bytes: number;
  backendCpuMs: number | null;
  serializationMs: number;
  cache: "hit" | "miss" | "not_applicable";
};

export function safePerformanceMetric(metric: SafePerformanceMetric) {
  return {
    route: metric.route.replace(/\?.*$/, "").slice(0, 120),
    dbTimeMs: Math.max(0, Math.round(metric.dbTimeMs)),
    queryCount: Math.max(0, Math.trunc(metric.queryCount)),
    rows: Math.max(0, Math.trunc(metric.rows)),
    bytes: Math.max(0, Math.trunc(metric.bytes)),
    backendCpuMs: metric.backendCpuMs === null ? null : Math.max(0, Math.round(metric.backendCpuMs)),
    serializationMs: Math.max(0, Math.round(metric.serializationMs)),
    cache: metric.cache
  };
}

export function latencyPercentiles(samples: number[]) {
  const ordered = samples.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (ratio: number) => ordered.length ? ordered[Math.ceil(ordered.length * ratio) - 1] : null;
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}
