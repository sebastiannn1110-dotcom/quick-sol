import type { AuthContext } from "@/lib/auth/context";
import type { AiToolResult } from "@/lib/ai/database-tools";
import { getAiPermissionScope } from "@/lib/ai/ai-permissions";
import { loadEmployeeAnalytics } from "@/lib/employee-analytics/service";
import type { EmployeeQuoteMetrics } from "@/lib/employee-analytics/contracts";
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

function safeMetric(metric: EmployeeQuoteMetrics) {
  return {
    name: text(metric.name),
    businessTitle: text(metric.businessTitle),
    region: text(metric.region),
    quotesCreated: numberValue(metric.quotesCreated),
    quotesSent: numberValue(metric.quotesSent),
    quotesAccepted: numberValue(metric.quotesAccepted),
    quotesRejected: numberValue(metric.quotesRejected),
    quoteConversionRate: numberValue(metric.quoteConversionRate),
    quotedValue: numberValue(metric.quotedValue),
    acceptedQuoteValue: numberValue(metric.acceptedQuoteValue),
    customersServed: numberValue(metric.customersServed),
    newCustomers: numberValue(metric.newCustomers)
  };
}

function mentionedEmployee(metrics: EmployeeQuoteMetrics[], question: string) {
  const normalizedQuestion = normalize(question);
  return metrics.find((metric) => {
    const name = normalize(metric.name);
    if (name.length >= 3 && normalizedQuestion.includes(name)) return true;
    const tokens = name.split(" ").filter((token) => token.length >= 3);
    return tokens.length >= 2 && tokens.every((token) => normalizedQuestion.includes(token));
  });
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

export async function getEmployeeQuoteMetrics(context: AuthContext, question: string) {
  const analytics = await loadEmployeeAnalytics(context);
  const target = mentionedEmployee(analytics.metrics, question);
  const asksForRanking = /\b(mayor|mas alto|top|highest|greatest|ranking)\b|\u6700\u9ad8|\u6392\u540d/i.test(
    normalize(question)
  );
  const selected = target ?? (asksForRanking ? analytics.ranking[0] : undefined);
  const ranking = analytics.ranking.slice(0, 10).map(safeMetric);
  const data = {
    analyticsScope: analytics.scope,
    currency: "USD" as const,
    queryMode: target ? "employee" as const : asksForRanking ? "ranking" as const : "summary" as const,
    selectedEmployee: selected ? safeMetric(selected) : null,
    ranking,
    totals: {
      quotesCreated: analytics.totals.quotesCreated,
      quotesSent: analytics.totals.quotesSent,
      quotesAccepted: analytics.totals.quotesAccepted,
      quotesRejected: analytics.totals.quotesRejected,
      quoteConversionRate: analytics.totals.quoteConversionRate,
      quotedValue: analytics.totals.quotedValue,
      acceptedQuoteValue: analytics.totals.acceptedQuoteValue,
      customersServed: analytics.totals.customersServed,
      newCustomers: analytics.totals.newCustomers
    }
  };
  return aiResult(
    context,
    "employee_quote_metrics",
    data,
    selected ? [safeMetric(selected)] : ranking,
    "Authorized employee quote metrics loaded from the current organization scope.",
    asksForRanking ? analytics.ranking.length === 0 : analytics.metrics.length === 0
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
