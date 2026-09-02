import type { AuthContext } from "@/lib/auth/context";
import type { SafeHistoryMessage } from "@/lib/ai/conversation-memory";
import type { AiToolResult } from "@/lib/ai/database-tools";
import { getAiPermissionScope } from "@/lib/ai/ai-permissions";
import {
  detectAssistantLanguage,
  type AssistantLanguage
} from "@/lib/ai/language-detection";
import { loadEmployeeAnalytics } from "@/lib/employee-analytics/service";
import type {
  EmployeeAnalyticsFilters,
  EmployeeAnalyticsPayload,
  EmployeeQuoteMetrics
} from "@/lib/employee-analytics/contracts";
import { analyticsVisibleEmployeeIds } from "@/lib/organization/scope";
import { loadOrganizationDirectory } from "@/lib/organization/service";
import { mpnIdentity } from "@/lib/opportunity-finder/normalization";

export type CommerceAiToolName =
  | "quote_summary"
  | "employee_quote_metrics"
  | "client_quote_summary"
  | "sourcing_lookup";

type JsonRow = Record<string, unknown>;

type SafeQuote = {
  number: string;
  sellerName: string;
  clientName: string;
  status: "draft" | "sent" | "accepted" | "rejected" | "expired";
  total: number;
  currency: "USD";
  createdAt: string;
  validUntil: string;
};

const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired"] as const;
const QUOTE_SELECT = [
  "quote_number",
  "seller_id",
  "client_id",
  "status",
  "total",
  "currency",
  "created_at",
  "valid_until",
  "customer:clients!commerce_quotes_client_id_fkey(name)",
  "seller:profiles!commerce_quotes_seller_id_fkey(full_name)"
].join(",");

function text(value: unknown, max = 160) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F<>`\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function relationOne(value: unknown) {
  if (Array.isArray(value)) return value[0] as JsonRow | undefined;
  return value && typeof value === "object" ? value as JsonRow : undefined;
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aiResult(
  context: AuthContext,
  tool: CommerceAiToolName,
  data: unknown,
  rows: unknown[],
  summary: string,
  empty: boolean
): AiToolResult {
  return {
    ok: !empty,
    tool,
    scope: getAiPermissionScope(context).mode,
    total: rows.length,
    rows,
    data,
    summary,
    empty,
    truncated: false,
    deterministic: true
  };
}

export type EmployeePerformanceSort =
  | "overall"
  | "accepted_quotes"
  | "conversion_rate"
  | "accepted_quote_value"
  | "sent_quotes"
  | "created_quotes"
  | "customers_served"
  | "draft_quotes";

export interface EmployeeQuoteMetricsOptions {
  language?: AssistantLanguage;
  history?: SafeHistoryMessage[];
}

type SafeAppliedFilters = {
  country?: string;
  region?: string;
  department?: string;
  team?: string;
};

type EmployeeResolution = {
  matches: EmployeeQuoteMetrics[];
  ambiguous: EmployeeQuoteMetrics[][];
};

const EMPLOYEE_NAME_STOP_WORDS = new Set([
  "admin",
  "employee",
  "empleado",
  "manager",
  "sales",
  "seller",
  "vendedor",
  "ventas",
  "comercial",
  "equipo",
  "team"
]);

function safeMetric(metric: EmployeeQuoteMetrics, draftQuotes?: number) {
  return {
    name: text(metric.name),
    businessTitle: text(metric.businessTitle),
    country: text(metric.country),
    department: text(metric.department),
    region: text(metric.region),
    quotesCreated: numberValue(metric.quotesCreated),
    quotesSent: numberValue(metric.quotesSent),
    quotesAccepted: numberValue(metric.quotesAccepted),
    quotesRejected: numberValue(metric.quotesRejected),
    quoteConversionRate: numberValue(metric.quoteConversionRate),
    quotedValue: numberValue(metric.quotedValue),
    acceptedQuoteValue: numberValue(metric.acceptedQuoteValue),
    customersServed: numberValue(metric.customersServed),
    newCustomers: numberValue(metric.newCustomers),
    draftQuotes: draftQuotes == null ? null : numberValue(draftQuotes)
  };
}

function normalizedPhraseIncludes(value: string, phrase: string) {
  const normalizedValue = ` ${normalize(value)} `;
  const normalizedPhrase = normalize(phrase);
  return Boolean(normalizedPhrase && normalizedValue.includes(` ${normalizedPhrase} `));
}

function uniqueMetrics(metrics: EmployeeQuoteMetrics[]) {
  const byId = new Map(metrics.map((metric) => [metric.employeeId, metric]));
  return [...byId.values()];
}

function resolveEmployees(
  question: string,
  metrics: EmployeeQuoteMetrics[]
): EmployeeResolution {
  const normalizedQuestion = normalize(question);
  const fullNameGroups = new Map<string, EmployeeQuoteMetrics[]>();
  for (const metric of metrics) {
    const name = normalize(metric.name);
    if (!name) continue;
    fullNameGroups.set(name, [...(fullNameGroups.get(name) ?? []), metric]);
  }

  const exactGroups = [...fullNameGroups.entries()]
    .filter(([name]) => normalizedPhraseIncludes(normalizedQuestion, name))
    .map(([, group]) => group);
  if (exactGroups.length) {
    return {
      matches: uniqueMetrics(exactGroups.filter((group) => group.length === 1).flat()),
      ambiguous: exactGroups.filter((group) => group.length > 1)
    };
  }

  const questionTokens = new Set(normalizedQuestion.split(" ").filter(Boolean));
  const tokenGroups = new Map<string, EmployeeQuoteMetrics[]>();
  for (const metric of metrics) {
    const tokens = normalize(metric.name)
      .split(" ")
      .filter((token) => token.length >= 3 && !EMPLOYEE_NAME_STOP_WORDS.has(token));
    for (const token of tokens) {
      if (!questionTokens.has(token)) continue;
      tokenGroups.set(token, [...(tokenGroups.get(token) ?? []), metric]);
    }
  }

  const groups = [...tokenGroups.values()];
  return {
    matches: uniqueMetrics(groups.filter((group) => group.length === 1).flat()),
    ambiguous: groups.filter((group) => group.length > 1)
  };
}

function explicitSort(question: string): EmployeePerformanceSort | null {
  const value = normalize(question);
  if (/\b(draft|drafts|borrador|borradores)\b|\u8349\u7a3f/.test(value)) {
    return "draft_quotes";
  }
  if (
    /accepted quote value|accepted value|valor (?:de )?(?:las )?cotizaciones? aceptadas?|\u5df2\u63a5\u53d7\u62a5\u4ef7(?:\u91d1\u989d|\u4ef7\u503c)/.test(value)
  ) {
    return "accepted_quote_value";
  }
  if (/conversion|conversion rate|tasa de conversion|\u8f6c\u5316\u7387|\u8f6c\u6362\u7387/.test(value)) {
    return "conversion_rate";
  }
  if (/accepted quotes?|quotes? accepted|cotizaciones? aceptadas?|\u5df2\u63a5\u53d7\u62a5\u4ef7/.test(value)) {
    return "accepted_quotes";
  }
  if (/sent quotes?|quotes? sent|cotizaciones? enviadas?|(?:ha|han|has) enviado .{0,20}cotizaciones?|\u5df2\u53d1\u9001\u62a5\u4ef7/.test(value)) {
    return "sent_quotes";
  }
  if (/created quotes?|quotes? created|cotizaciones? creadas?|(?:ha|han|has) creado .{0,20}cotizaciones?|\u5df2\u521b\u5efa\u62a5\u4ef7/.test(value)) {
    return "created_quotes";
  }
  if (
    /customers? served|served customers?|clientes? atendidos?|clientes? (?:ha|han) atendido|\u670d\u52a1\u5ba2\u6237/.test(value)
  ) {
    return "customers_served";
  }
  if (
    /best (?:seller|salesperson|sales rep|performer)|top (?:seller|salesperson|sales reps?)|mejor(?:es)? (?:vendedor|vendedores|empleado|empleados|comercial|comerciales|metricas|desempeno|rendimiento)|sales performance|rendimiento (?:comercial|de ventas)|\u6700\u4f73\u9500\u552e|\u8868\u73b0\u6700\u597d\u7684\u9500\u552e/.test(value)
  ) {
    return "overall";
  }
  return null;
}

function contextualSort(
  question: string,
  history: SafeHistoryMessage[]
): EmployeePerformanceSort {
  const current = explicitSort(question);
  if (current) return current;
  for (const message of [...history].reverse()) {
    if (message.role !== "user") continue;
    const previous = explicitSort(message.content);
    if (previous) return previous;
  }
  return "overall";
}

function numberWord(value: string) {
  const normalizedValue = normalize(value);
  const words: Array<[RegExp, number]> = [
    [/\b(?:one|uno|una|un)\b|\u4e00/, 1],
    [/\b(?:two|dos)\b|\u4e8c|\u4e24/, 2],
    [/\b(?:three|tres)\b|\u4e09/, 3],
    [/\b(?:four|cuatro)\b|\u56db/, 4],
    [/\b(?:five|cinco)\b|\u4e94/, 5],
    [/\b(?:six|seis)\b|\u516d/, 6],
    [/\b(?:seven|siete)\b|\u4e03/, 7],
    [/\b(?:eight|ocho)\b|\u516b/, 8],
    [/\b(?:nine|nueve)\b|\u4e5d/, 9],
    [/\b(?:ten|diez)\b|\u5341/, 10]
  ];
  return words.find(([pattern]) => pattern.test(normalizedValue))?.[1] ?? null;
}

function ordinalRank(question: string) {
  const value = normalize(question);
  const digit = value.match(/\b(?:rank|puesto|posicion|numero|number|#)\s*(\d{1,2})\b/)?.[1];
  if (digit) return Math.min(Math.max(Number(digit), 1), 10);
  const ordinals: Array<[RegExp, number]> = [
    [/\b(?:first|primero|primera)\b|\u7b2c\u4e00/, 1],
    [/\b(?:second|segundo|segunda)\b|\u7b2c\u4e8c/, 2],
    [/\b(?:third|tercero|tercera)\b|\u7b2c\u4e09/, 3],
    [/\b(?:fourth|cuarto|cuarta)\b|\u7b2c\u56db/, 4],
    [/\b(?:fifth|quinto|quinta)\b|\u7b2c\u4e94/, 5],
    [/\b(?:sixth|sexto|sexta)\b|\u7b2c\u516d/, 6],
    [/\b(?:seventh|septimo|septima)\b|\u7b2c\u4e03/, 7],
    [/\b(?:eighth|octavo|octava)\b|\u7b2c\u516b/, 8],
    [/\b(?:ninth|noveno|novena)\b|\u7b2c\u4e5d/, 9],
    [/\b(?:tenth|decimo|decima)\b|\u7b2c\u5341/, 10]
  ];
  return ordinals.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

function requestedLimit(question: string) {
  const value = normalize(question);
  const digit = value.match(
    /\b(?:top|mejores?|vendedores?|sellers?|salespersons?)\s*(\d{1,2})\b|\b(\d{1,2})\s*(?:mejores?|vendedores?|sellers?|salespersons?)\b|\u524d\s*(\d{1,2})/
  );
  const parsedDigit = digit?.slice(1).find(Boolean);
  if (parsedDigit) return Math.min(Math.max(Number(parsedDigit), 1), 10);
  if (
    /\btop\b|\bmejores\b|\bbest (?:sellers|salespersons|sales reps)\b|\u524d/.test(value)
  ) {
    return numberWord(value) ?? 5;
  }
  return null;
}

function previousRankingWindow(history: SafeHistoryMessage[]) {
  const message = [...history].reverse().find((item) => item.role === "user");
  if (!message) return { start: 1, limit: 1 };
  const rank = ordinalRank(message.content);
  const limit = requestedLimit(message.content) ?? 1;
  if (rank || explicitSort(message.content)) return { start: rank ?? 1, limit };
  return { start: 1, limit: 1 };
}

function rankingWindow(question: string, history: SafeHistoryMessage[]) {
  const value = normalize(question);
  const rank = ordinalRank(question);
  if (rank) return { start: rank, limit: 1 };
  if (/\b(next|siguientes?)\b|\u63a5\u4e0b\u6765/.test(value)) {
    const previous = previousRankingWindow(history);
    return {
      start: Math.min(previous.start + previous.limit, 10),
      limit: requestedLimit(question) ?? numberWord(value) ?? 1
    };
  }
  const limit = requestedLimit(question);
  if (limit) return { start: 1, limit };
  return { start: 1, limit: 1 };
}

function asksForComparison(question: string) {
  const value = normalize(question);
  return /\b(compare|comparison|compara|comparar|versus|vs)\b|\b(?:better|mejor)\b.{0,30}\b(?:than|que|or|o)\b|\u6bd4\u8f83|\u8c01.{0,20}\u66f4/.test(value);
}

function asksForComparisonFollowUp(question: string) {
  const value = normalize(question);
  return /\b(?:who|quien)\b.{0,30}\b(?:better|mejor)\b|\u8c01.{0,20}\u66f4/.test(value);
}

function asksForAggregate(question: string) {
  const value = normalize(question);
  return /\b(?:tenemos|global|overall team|team performance|sales team|equipo de ventas|rendimiento del equipo|total|totales|active sellers?|vendedores? activos?)\b|\u56e2\u961f|\u603b\u4f53|\u6d3b\u8dc3\u9500\u552e/.test(value);
}

function asksForBelowAverage(question: string) {
  const value = normalize(question);
  return /below (?:the )?average|under (?:the )?average|por debajo (?:de la|del) promedio|inferior (?:a la|al) promedio|\u4f4e\u4e8e\u5e73\u5747/.test(value);
}

function asksForNeedsImprovement(question: string) {
  const value = normalize(question);
  return /needs? (?:to )?improve|needs? improvement|necesita mejorar|debe mejorar|peor desempeno|lowest performer|\u9700\u8981\u6539\u8fdb|\u8868\u73b0\u6700\u5dee/.test(value);
}

function asksForSpecificUnknownEmployee(question: string) {
  const value = normalize(question);
  return /how many .+ does|quotes? for .+|performance of .+|cuantas? .+ tiene|cotizaciones? de .+|metricas? de .+/.test(value);
}

function historyComparisonPair(
  history: SafeHistoryMessage[],
  metrics: EmployeeQuoteMetrics[]
) {
  const message = [...history].reverse().find((item) => item.role === "user");
  if (message) {
    const resolved = resolveEmployees(message.content, metrics);
    if (!resolved.ambiguous.length && resolved.matches.length === 2) return resolved.matches;
  }
  return [];
}

function metricValue(
  metric: EmployeeQuoteMetrics,
  sortBy: EmployeePerformanceSort,
  draftsByEmployee: Map<string, number>
) {
  switch (sortBy) {
    case "accepted_quotes": return numberValue(metric.quotesAccepted);
    case "conversion_rate": return numberValue(metric.quoteConversionRate);
    case "sent_quotes": return numberValue(metric.quotesSent);
    case "created_quotes": return numberValue(metric.quotesCreated);
    case "customers_served": return numberValue(metric.customersServed);
    case "draft_quotes": return numberValue(draftsByEmployee.get(metric.employeeId) ?? 0);
    case "accepted_quote_value":
    case "overall":
      return numberValue(metric.acceptedQuoteValue);
  }
}

function orderedMetrics(
  analytics: EmployeeAnalyticsPayload,
  sortBy: EmployeePerformanceSort,
  draftsByEmployee: Map<string, number>
) {
  if (sortBy === "overall") return [...analytics.ranking];
  const officialRank = new Map(
    analytics.ranking.map((metric, index) => [metric.employeeId, index])
  );
  return [...analytics.ranking].sort((left, right) =>
    metricValue(right, sortBy, draftsByEmployee) - metricValue(left, sortBy, draftsByEmployee) ||
    (officialRank.get(left.employeeId) ?? Number.MAX_SAFE_INTEGER) -
      (officialRank.get(right.employeeId) ?? Number.MAX_SAFE_INTEGER) ||
    left.name.localeCompare(right.name)
  );
}

function safeTotals(analytics: EmployeeAnalyticsPayload, draftQuotes: number | null) {
  return {
    quotesCreated: numberValue(analytics.totals.quotesCreated),
    quotesSent: numberValue(analytics.totals.quotesSent),
    quotesAccepted: numberValue(analytics.totals.quotesAccepted),
    quotesRejected: numberValue(analytics.totals.quotesRejected),
    quoteConversionRate: numberValue(analytics.totals.quoteConversionRate),
    quotedValue: numberValue(analytics.totals.quotedValue),
    acceptedQuoteValue: numberValue(analytics.totals.acceptedQuoteValue),
    customersServed: numberValue(analytics.totals.customersServed),
    newCustomers: numberValue(analytics.totals.newCustomers),
    draftQuotes
  };
}

function availableFilters(
  analytics: EmployeeAnalyticsPayload,
  question: string
): { filters: EmployeeAnalyticsFilters; publicFilters: SafeAppliedFilters } {
  const options = analytics.filterOptions;
  if (!options) return { filters: {}, publicFilters: {} };
  const longestMatch = (values: string[]) => [...values]
    .sort((left, right) => right.length - left.length)
    .find((value) => normalizedPhraseIncludes(question, value));
  const country = longestMatch(options.countries ?? []);
  const region = longestMatch(options.regions ?? []);
  const department = longestMatch(options.departments ?? []);
  const team = /\b(team|equipo)\b|\u56e2\u961f/.test(normalize(question))
    ? [...(options.teams ?? [])]
      .sort((left, right) => right.name.length - left.name.length)
      .find((item) => normalizedPhraseIncludes(question, item.name))
    : undefined;
  return {
    filters: {
      ...(country ? { country } : {}),
      ...(region ? { region } : {}),
      ...(department ? { department } : {}),
      ...(team ? { teamManagerId: team.managerId } : {})
    },
    publicFilters: {
      ...(country ? { country } : {}),
      ...(region ? { region } : {}),
      ...(department ? { department } : {}),
      ...(team ? { team: team.name } : {})
    }
  };
}

function localizedSummary(input: {
  language: AssistantLanguage;
  queryMode: string;
  sortBy: EmployeePerformanceSort;
  selected: ReturnType<typeof safeMetric> | null;
  ranking: ReturnType<typeof safeMetric>[];
  comparison: {
    employees: ReturnType<typeof safeMetric>[];
    winner: ReturnType<typeof safeMetric> | null;
    tied: boolean;
  } | null;
  totals: ReturnType<typeof safeTotals>;
  average: number | null;
  clarification: string | null;
}) {
  if (input.clarification) return input.clarification;
  if (input.queryMode === "aggregate") {
    if (input.language === "zh") {
      return `\u6388\u6743\u8303\u56f4\u5185\u5171\u6709 ${input.totals.quotesAccepted} \u4efd\u5df2\u63a5\u53d7\u62a5\u4ef7\uff0c\u6574\u4f53\u8f6c\u5316\u7387\u4e3a ${input.totals.quoteConversionRate}%\u3002`;
    }
    if (input.language === "es") {
      return `En el alcance autorizado hay ${input.totals.quotesAccepted} cotizaciones aceptadas y la conversi\u00f3n global es ${input.totals.quoteConversionRate}%.`;
    }
    return `The authorized scope has ${input.totals.quotesAccepted} accepted quotes and an overall conversion rate of ${input.totals.quoteConversionRate}%.`;
  }
  if (input.comparison) {
    const names = input.comparison.employees.map((employee) => employee.name).join(" / ");
    if (input.comparison.tied) {
      if (input.language === "zh") return `${names} \u5728\u6240\u9009\u6307\u6807\u4e0a\u5e76\u5217\u3002`;
      if (input.language === "es") return `${names} est\u00e1n empatados en la m\u00e9trica seleccionada.`;
      return `${names} are tied on the selected metric.`;
    }
    const winner = input.comparison.winner?.name ?? "";
    if (input.language === "zh") return `${winner} \u5728\u6240\u9009\u6307\u6807\u4e0a\u9886\u5148\u3002`;
    if (input.language === "es") return `${winner} lidera la comparaci\u00f3n en la m\u00e9trica seleccionada.`;
    return `${winner} leads the comparison on the selected metric.`;
  }
  if (input.queryMode === "below_average" && input.average != null) {
    if (input.language === "zh") return `${input.ranking.length} \u540d\u53ef\u89c1\u9500\u552e\u4eba\u5458\u4f4e\u4e8e\u5e73\u5747\u503c ${input.average}\u3002`;
    if (input.language === "es") return `${input.ranking.length} vendedores visibles est\u00e1n por debajo del promedio de ${input.average}.`;
    return `${input.ranking.length} visible sellers are below the average of ${input.average}.`;
  }
  if (!input.selected) {
    if (input.language === "zh") return "\u672a\u627e\u5230\u7b26\u5408\u6761\u4ef6\u7684\u6388\u6743\u9500\u552e\u6307\u6807\u3002";
    if (input.language === "es") return "No encontr\u00e9 m\u00e9tricas comerciales autorizadas que coincidan.";
    return "No matching authorized employee performance metrics were found.";
  }
  if (input.language === "zh") {
    return `${input.selected.name} \u5728\u6240\u9009\u6392\u540d\u4e2d\u9886\u5148\uff1a${input.selected.quotesAccepted} \u4efd\u5df2\u63a5\u53d7\u62a5\u4ef7\uff0c\u8f6c\u5316\u7387 ${input.selected.quoteConversionRate}%\uff0c\u5df2\u63a5\u53d7\u62a5\u4ef7\u91d1\u989d USD ${input.selected.acceptedQuoteValue}\u3002`;
  }
  if (input.language === "es") {
    return `${input.selected.name} lidera el ranking seleccionado: ${input.selected.quotesAccepted} cotizaciones aceptadas, ${input.selected.quoteConversionRate}% de conversi\u00f3n y USD ${input.selected.acceptedQuoteValue} en valor de cotizaciones aceptadas.`;
  }
  return `${input.selected.name} leads the selected ranking with ${input.selected.quotesAccepted} accepted quotes, ${input.selected.quoteConversionRate}% conversion, and USD ${input.selected.acceptedQuoteValue} in Accepted Quote Value.`;
}

async function visibleSellerIds(context: AuthContext) {
  const directory = await loadOrganizationDirectory(context);
  return [...analyticsVisibleEmployeeIds(directory.actor, directory.members)];
}

function safeQuote(row: JsonRow): SafeQuote | null {
  const status = text(row.status, 20) as SafeQuote["status"];
  if (!QUOTE_STATUSES.includes(status)) return null;
  const customer = relationOne(row.customer);
  const seller = relationOne(row.seller);
  return {
    number: text(row.quote_number, 80),
    sellerName: text(seller?.full_name),
    clientName: text(customer?.name, 200),
    status,
    total: numberValue(row.total),
    currency: "USD",
    createdAt: text(row.created_at, 40),
    validUntil: text(row.valid_until, 40)
  };
}

async function loadVisibleQuotes(context: AuthContext) {
  if (!context.supabase) return [];
  const sellerIds = await visibleSellerIds(context);
  if (!sellerIds.length) return [];
  const { data, error } = await context.supabase
    .from("commerce_quotes")
    .select(QUOTE_SELECT)
    .in("seller_id", sellerIds)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as unknown as JsonRow[])
    .map(safeQuote)
    .filter((quote): quote is SafeQuote => Boolean(quote));
}

export async function getQuoteSummary(context: AuthContext) {
  const quotes = await loadVisibleQuotes(context);
  const statusCounts = Object.fromEntries(
    QUOTE_STATUSES.map((status) => [status, quotes.filter((quote) => quote.status === status).length])
  );
  const sum = (rows: SafeQuote[]) => numberValue(rows.reduce((total, quote) => total + quote.total, 0));
  const accepted = quotes.filter((quote) => quote.status === "accepted");
  const open = quotes.filter((quote) => quote.status === "draft" || quote.status === "sent");
  const recentQuotes = quotes.slice(0, 10);
  const data = {
    currency: "USD" as const,
    quoteCount: quotes.length,
    statusCounts,
    quotedValue: sum(quotes),
    acceptedQuoteValue: sum(accepted),
    openQuoteValue: sum(open),
    recentQuotes
  };
  return aiResult(
    context,
    "quote_summary",
    data,
    recentQuotes,
    "Authorized quote summary loaded from the current commerce scope.",
    quotes.length === 0
  );
}

export async function getEmployeeQuoteMetrics(
  context: AuthContext,
  question: string,
  options: EmployeeQuoteMetricsOptions = {}
) {
  const history = options.history ?? [];
  const language = options.language ?? detectAssistantLanguage(question);
  const unfilteredAnalytics = await loadEmployeeAnalytics(context);
  const requestedFilters = availableFilters(unfilteredAnalytics, question);
  const analytics = Object.keys(requestedFilters.filters).length
    ? await loadEmployeeAnalytics(context, requestedFilters.filters)
    : unfilteredAnalytics;
  const sortBy = contextualSort(question, history);

  let draftAnalytics: EmployeeAnalyticsPayload | null = null;
  const draftsByEmployee = new Map<string, number>();
  if (sortBy === "draft_quotes") {
    draftAnalytics = await loadEmployeeAnalytics(context, {
      ...requestedFilters.filters,
      quoteStatus: "draft"
    });
    for (const metric of draftAnalytics.metrics) {
      draftsByEmployee.set(metric.employeeId, numberValue(metric.quotesCreated));
    }
  }

  const ordered = orderedMetrics(analytics, sortBy, draftsByEmployee);
  const currentResolution = resolveEmployees(question, analytics.metrics);
  const possibleHistoricalPair = currentResolution.matches.length === 0
    ? historyComparisonPair(history, analytics.metrics)
    : [];
  const comparisonRequested = asksForComparison(question) || (
    possibleHistoricalPair.length === 2 && asksForComparisonFollowUp(question)
  );
  const historicalPair = comparisonRequested ? possibleHistoricalPair : [];
  const comparisonEmployees = currentResolution.matches.length >= 2
    ? currentResolution.matches
    : historicalPair;
  const window = rankingWindow(question, history);
  const totalDraftQuotes = draftAnalytics
    ? numberValue(draftAnalytics.totals.quotesCreated)
    : null;
  const totals = safeTotals(analytics, totalDraftQuotes);
  const safe = (metric: EmployeeQuoteMetrics) =>
    safeMetric(metric, sortBy === "draft_quotes" ? draftsByEmployee.get(metric.employeeId) ?? 0 : undefined);

  const commonData = {
    analyticsScope: analytics.scope,
    currency: "USD" as const,
    generatedAt: analytics.generatedAt,
    sortBy,
    metricDefinition: sortBy === "overall"
      ? analytics.definitions.ranking
      : sortBy,
    requestedLimit: window.limit,
    rankStart: window.start,
    activeSellerCount: ordered.length,
    appliedFilters: requestedFilters.publicFilters,
    totals
  };

  if (currentResolution.ambiguous.length) {
    const ambiguousMetrics = uniqueMetrics(currentResolution.ambiguous.flat());
    const candidates = ambiguousMetrics.map(safe);
    const names = [...new Set(candidates.map((candidate) => candidate.name))].join(", ");
    const clarification = language === "zh"
      ? `\u627e\u5230\u591a\u4e2a\u540c\u540d\u53ef\u89c1\u5458\u5de5\uff08${names}\uff09\u3002\u8bf7\u63d0\u4f9b\u804c\u4f4d\u6216\u5730\u533a\u3002`
      : language === "es"
        ? `Hay m\u00e1s de un empleado visible que coincide con ${names}. Indica el cargo o la regi\u00f3n.`
        : `More than one visible employee matches ${names}. Specify the business title or region.`;
    return aiResult(
      context,
      "employee_quote_metrics",
      {
        ...commonData,
        queryMode: "clarification" as const,
        selectedEmployee: null,
        ranking: [],
        comparison: null,
        average: null,
        belowAverage: [],
        needsImprovement: [],
        clarification: {
          required: true,
          reason: "ambiguous_employee_name",
          message: clarification,
          candidates
        }
      },
      candidates,
      clarification,
      false
    );
  }

  if (comparisonRequested && comparisonEmployees.length !== 2) {
    const candidates = currentResolution.matches.map(safe);
    const clarification = language === "zh"
      ? "\u8bf7\u6307\u5b9a\u4e24\u540d\u53ef\u89c1\u5458\u5de5\u8fdb\u884c\u6bd4\u8f83\u3002"
      : language === "es"
        ? "Indica exactamente dos empleados visibles para realizar la comparaci\u00f3n."
        : "Specify exactly two visible employees to compare.";
    return aiResult(
      context,
      "employee_quote_metrics",
      {
        ...commonData,
        queryMode: "clarification" as const,
        selectedEmployee: null,
        ranking: [],
        comparison: null,
        average: null,
        belowAverage: [],
        needsImprovement: [],
        clarification: {
          required: true,
          reason: "comparison_requires_two_employees",
          message: clarification,
          candidates
        }
      },
      candidates,
      clarification,
      false
    );
  }

  if (comparisonRequested && comparisonEmployees.length === 2) {
    const [left, right] = comparisonEmployees;
    const leftValue = metricValue(left, sortBy, draftsByEmployee);
    const rightValue = metricValue(right, sortBy, draftsByEmployee);
    const tied = leftValue === rightValue;
    const winner = tied ? null : leftValue > rightValue ? left : right;
    const employees = [left, right].map(safe);
    const comparison = {
      metric: sortBy,
      employees,
      winner: winner ? safe(winner) : null,
      tied
    };
    const summary = localizedSummary({
      language,
      queryMode: "comparison",
      sortBy,
      selected: comparison.winner,
      ranking: employees,
      comparison,
      totals,
      average: null,
      clarification: null
    });
    return aiResult(
      context,
      "employee_quote_metrics",
      {
        ...commonData,
        queryMode: "comparison" as const,
        selectedEmployee: comparison.winner,
        ranking: employees,
        comparison,
        average: null,
        belowAverage: [],
        needsImprovement: [],
        clarification: null
      },
      employees,
      summary,
      false
    );
  }

  const target = currentResolution.matches.length === 1
    ? currentResolution.matches[0]
    : null;
  if (target) {
    const selected = safe(target);
    const summary = localizedSummary({
      language,
      queryMode: "employee",
      sortBy,
      selected,
      ranking: [selected],
      comparison: null,
      totals,
      average: null,
      clarification: null
    });
    return aiResult(
      context,
      "employee_quote_metrics",
      {
        ...commonData,
        queryMode: "employee" as const,
        selectedEmployee: selected,
        ranking: [selected],
        comparison: null,
        average: null,
        belowAverage: [],
        needsImprovement: [],
        clarification: null
      },
      [selected],
      summary,
      false
    );
  }

  if (asksForSpecificUnknownEmployee(question)) {
    const summary = localizedSummary({
      language,
      queryMode: "employee",
      sortBy,
      selected: null,
      ranking: [],
      comparison: null,
      totals,
      average: null,
      clarification: null
    });
    return aiResult(
      context,
      "employee_quote_metrics",
      {
        ...commonData,
        queryMode: "employee" as const,
        selectedEmployee: null,
        ranking: [],
        comparison: null,
        average: null,
        belowAverage: [],
        needsImprovement: [],
        clarification: null
      },
      [],
      summary,
      true
    );
  }

  if (asksForAggregate(question)) {
    const summary = localizedSummary({
      language,
      queryMode: "aggregate",
      sortBy,
      selected: null,
      ranking: [],
      comparison: null,
      totals,
      average: null,
      clarification: null
    });
    return aiResult(
      context,
      "employee_quote_metrics",
      {
        ...commonData,
        queryMode: "aggregate" as const,
        selectedEmployee: null,
        ranking: [],
        comparison: null,
        average: null,
        belowAverage: [],
        needsImprovement: [],
        clarification: null
      },
      [],
      summary,
      false
    );
  }

  const average = ordered.length
    ? numberValue(
      ordered.reduce(
        (sum, metric) => sum + metricValue(metric, sortBy, draftsByEmployee),
        0
      ) / ordered.length
    )
    : null;

  if (asksForBelowAverage(question)) {
    const below = average == null
      ? []
      : ordered
        .filter((metric) => metricValue(metric, sortBy, draftsByEmployee) < average)
        .map(safe);
    const summary = localizedSummary({
      language,
      queryMode: "below_average",
      sortBy,
      selected: below[0] ?? null,
      ranking: below,
      comparison: null,
      totals,
      average,
      clarification: null
    });
    return aiResult(
      context,
      "employee_quote_metrics",
      {
        ...commonData,
        queryMode: "below_average" as const,
        selectedEmployee: below[0] ?? null,
        ranking: below,
        comparison: null,
        average: average == null ? null : { metric: sortBy, value: average },
        belowAverage: below,
        needsImprovement: [],
        clarification: null
      },
      below,
      summary,
      false
    );
  }

  if (asksForNeedsImprovement(question)) {
    const improvement = [...ordered]
      .sort((left, right) =>
        metricValue(left, sortBy, draftsByEmployee) -
          metricValue(right, sortBy, draftsByEmployee) ||
        left.name.localeCompare(right.name)
      )
      .slice(0, window.limit)
      .map(safe);
    const summary = localizedSummary({
      language,
      queryMode: "needs_improvement",
      sortBy,
      selected: improvement[0] ?? null,
      ranking: improvement,
      comparison: null,
      totals,
      average,
      clarification: null
    });
    return aiResult(
      context,
      "employee_quote_metrics",
      {
        ...commonData,
        queryMode: "needs_improvement" as const,
        selectedEmployee: improvement[0] ?? null,
        ranking: improvement,
        comparison: null,
        average: average == null ? null : { metric: sortBy, value: average },
        belowAverage: [],
        needsImprovement: improvement,
        clarification: null
      },
      improvement,
      summary,
      improvement.length === 0
    );
  }

  const ranking = ordered
    .slice(window.start - 1, window.start - 1 + window.limit)
    .map(safe);
  const selected = ranking[0] ?? null;
  const summary = localizedSummary({
    language,
    queryMode: "ranking",
    sortBy,
    selected,
    ranking,
    comparison: null,
    totals,
    average,
    clarification: null
  });
  return aiResult(
    context,
    "employee_quote_metrics",
    {
      ...commonData,
      queryMode: "ranking" as const,
      selectedEmployee: selected,
      ranking,
      comparison: null,
      average: average == null ? null : { metric: sortBy, value: average },
      belowAverage: [],
      needsImprovement: [],
      clarification: null
    },
    ranking,
    summary,
    ranking.length === 0
  );
}

export async function getClientQuoteSummary(context: AuthContext) {
  const quotes = await loadVisibleQuotes(context);
  const openQuotes = quotes.filter((quote) => quote.status === "draft" || quote.status === "sent");
  const grouped = new Map<string, SafeQuote[]>();
  for (const quote of openQuotes) {
    const key = quote.clientName || "Authorized client";
    grouped.set(key, [...(grouped.get(key) ?? []), quote]);
  }
  const clients = [...grouped.entries()]
    .map(([name, rows]) => ({
      name,
      openQuoteCount: rows.length,
      openQuoteValue: numberValue(rows.reduce((sum, quote) => sum + quote.total, 0)),
      draftQuotes: rows.filter((quote) => quote.status === "draft").length,
      sentQuotes: rows.filter((quote) => quote.status === "sent").length
    }))
    .sort((left, right) => right.openQuoteValue - left.openQuoteValue || left.name.localeCompare(right.name))
    .slice(0, 25);
  const data = {
    currency: "USD" as const,
    definition: "Open quotes are quotes in draft or sent status.",
    topClient: clients[0] ?? null,
    clients
  };
  return aiResult(
    context,
    "client_quote_summary",
    data,
    clients,
    "Authorized open-quote totals by client loaded from the current commerce scope.",
    clients.length === 0
  );
}

function safeApproval(row: JsonRow) {
  return {
    mpn: text(row.mpn),
    manufacturer: text(row.manufacturer),
    authorizedUnitPrice: numberValue(row.authorized_unit_price),
    currency: text(row.currency, 3) || "USD",
    coarseAvailability: text(row.coarse_availability, 30),
    leadTimeDays: row.lead_time_days == null ? null : numberValue(row.lead_time_days),
    minimumOrderQuantity: numberValue(row.minimum_order_quantity) || 1,
    validUntil: text(row.valid_until, 40)
  };
}

export async function getSourcingLookup(context: AuthContext, mpnInput: string) {
  const identity = mpnIdentity(mpnInput);
  if (!context.supabase || !identity.normalizedMpn) {
    return aiResult(
      context,
      "sourcing_lookup",
      { accessMode: "seller_safe", mpn: identity.displayMpn, approvals: [] },
      [],
      "No authorized sourcing information was found.",
      true
    );
  }

  const approvalResult = await context.supabase.rpc(
    "get_seller_safe_sourcing_approvals_v1",
    { input_mpn: identity.normalizedMpn }
  );
  if (approvalResult.error) throw approvalResult.error;
  const approvals = ((approvalResult.data ?? []) as unknown as JsonRow[]).map(safeApproval);
  const data = {
    accessMode: "seller_safe" as const,
    mpn: identity.normalizedMpn,
    approvals
  };
  return aiResult(
    context,
    "sourcing_lookup",
    data,
    approvals,
    "Seller-safe commercial sourcing options loaded without supplier cost or exact supply quantity.",
    approvals.length === 0
  );
}
