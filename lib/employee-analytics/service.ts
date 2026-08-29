import type { AuthContext } from "@/lib/auth/context";
import { analyticsVisibleEmployeeIds } from "@/lib/organization/scope";
import { loadOrganizationDirectory } from "@/lib/organization/service";
import { buildEmployeeAnalytics } from "./aggregate";
import type {
  AnalyticsEmployee,
  AnalyticsQuote,
  AnalyticsQuoteEvent,
  AnalyticsQuoteItem,
  AnalyticsScope,
  EmployeeAnalyticsPayload
} from "./contracts";

const QUOTE_SELECT = "id,seller_id,client_id,status,total,created_at,sent_at";

function scopeForRole(role: AuthContext["profile"]["role"]): AnalyticsScope {
  if (role === "admin" || role === "super_admin_dev") return "global";
  if (role === "manager") return "subtree";
  return "self";
}

function emptyAnalytics(
  context: AuthContext,
  employees: AnalyticsEmployee[]
): EmployeeAnalyticsPayload {
  return buildEmployeeAnalytics({
    scope: scopeForRole(context.profile.role),
    employees,
    quotes: [],
    items: [],
    events: []
  });
}

export async function loadEmployeeAnalytics(
  context: AuthContext
): Promise<EmployeeAnalyticsPayload> {
  const directory = await loadOrganizationDirectory(context);
  const visibleIds = analyticsVisibleEmployeeIds(directory.actor, directory.members);
  const employees: AnalyticsEmployee[] = directory.members
    .filter((member) => visibleIds.has(member.profileId))
    .map((member) => ({
      employeeId: member.profileId,
      name: member.name,
      businessTitle: member.businessTitle,
      businessRank: member.businessRank,
      region: member.region,
      avatarPath: member.avatarPath
    }));

  if (!context.supabase || !employees.length) return emptyAnalytics(context, employees);

  const employeeIds = employees.map((employee) => employee.employeeId);
  const quotesResult = await context.supabase
    .from("commerce_quotes")
    .select(QUOTE_SELECT)
    .in("seller_id", employeeIds)
    .order("created_at", { ascending: true });
  if (quotesResult.error) throw quotesResult.error;

  const quotes: AnalyticsQuote[] = (quotesResult.data ?? []).map((row) => ({
    id: String(row.id),
    sellerId: String(row.seller_id),
    clientId: String(row.client_id),
    status: row.status as AnalyticsQuote["status"],
    total: Number(row.total || 0),
    createdAt: String(row.created_at),
    sentAt: typeof row.sent_at === "string" ? row.sent_at : null
  }));
  if (!quotes.length) return emptyAnalytics(context, employees);

  const quoteIds = quotes.map((quote) => quote.id);
  const [itemsResult, eventsResult] = await Promise.all([
    context.supabase
      .from("commerce_quote_items")
      .select("quote_id")
      .in("quote_id", quoteIds),
    context.supabase
      .from("commerce_quote_events")
      .select("quote_id,event_type")
      .in("quote_id", quoteIds)
  ]);
  if (itemsResult.error) throw itemsResult.error;
  if (eventsResult.error) throw eventsResult.error;

  const items: AnalyticsQuoteItem[] = (itemsResult.data ?? []).map((row) => ({
    quoteId: String(row.quote_id)
  }));
  const events: AnalyticsQuoteEvent[] = (eventsResult.data ?? []).map((row) => ({
    quoteId: String(row.quote_id),
    eventType: row.event_type as AnalyticsQuoteEvent["eventType"]
  }));

  return buildEmployeeAnalytics({
    scope: scopeForRole(context.profile.role),
    employees,
    quotes,
    items,
    events
  });
}
