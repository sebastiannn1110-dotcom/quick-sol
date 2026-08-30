import { BUSINESS_RANKS } from "@/lib/organization/contracts";
import type {
  AnalyticsEmployee,
  AnalyticsQuote,
  AnalyticsQuoteEvent,
  AnalyticsQuoteItem,
  AnalyticsScope,
  EmployeeAnalyticsFilterOptions,
  EmployeeAnalyticsFilters,
  EmployeeAnalyticsPayload,
  EmployeeQuoteMetrics,
  RegionQuoteMetrics
} from "./contracts";
import { ANALYTICS_QUOTE_STATUSES } from "./contracts";

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function conversion(accepted: number, sent: number) {
  return sent > 0 ? round((accepted / sent) * 100) : 0;
}

function dimension(value: string | null) {
  return value?.trim() || null;
}

function normalizeFilters(filters: EmployeeAnalyticsFilters): EmployeeAnalyticsFilters {
  const normalized: EmployeeAnalyticsFilters = {};
  const country = filters.country?.trim();
  const region = filters.region?.trim();
  const department = filters.department?.trim();
  if (country) normalized.country = country;
  if (region) normalized.region = region;
  if (department) normalized.department = department;
  if (filters.businessRank) normalized.businessRank = filters.businessRank;
  if (filters.teamManagerId) normalized.teamManagerId = filters.teamManagerId;
  if (filters.sellerId) normalized.sellerId = filters.sellerId;
  if (filters.quoteStatus) normalized.quoteStatus = filters.quoteStatus;
  return normalized;
}

function sortedDistinct(values: Array<string | null>) {
  return [...new Set(values.map(dimension).filter((value): value is string => Boolean(value)))]
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

export function analyticsTeamEmployeeIds(
  employees: AnalyticsEmployee[],
  managerId: string
) {
  if (!employees.some((employee) => employee.employeeId === managerId)) {
    return new Set<string>();
  }

  const children = new Map<string, string[]>();
  for (const employee of employees) {
    if (!employee.managerId) continue;
    children.set(employee.managerId, [
      ...(children.get(employee.managerId) ?? []),
      employee.employeeId
    ]);
  }

  const team = new Set<string>();
  const pending = [managerId];
  while (pending.length) {
    const employeeId = pending.shift()!;
    if (team.has(employeeId)) continue;
    team.add(employeeId);
    pending.push(...(children.get(employeeId) ?? []));
  }
  return team;
}

function filterEmployees(
  employees: AnalyticsEmployee[],
  filters: EmployeeAnalyticsFilters
) {
  const teamIds = filters.teamManagerId
    ? analyticsTeamEmployeeIds(employees, filters.teamManagerId)
    : null;

  return employees.filter((employee) => {
    if (filters.country && dimension(employee.country) !== filters.country) return false;
    if (filters.region && dimension(employee.region) !== filters.region) return false;
    if (filters.department && dimension(employee.department) !== filters.department) return false;
    if (filters.businessRank && employee.businessRank !== filters.businessRank) return false;
    if (teamIds && !teamIds.has(employee.employeeId)) return false;
    if (filters.sellerId && employee.employeeId !== filters.sellerId) return false;
    return true;
  });
}

function filterOptions(
  employees: AnalyticsEmployee[],
  validQuotes: AnalyticsQuote[]
): EmployeeAnalyticsFilterOptions {
  const directManagers = new Set(
    employees
      .map((employee) => employee.managerId)
      .filter((managerId): managerId is string => Boolean(managerId))
  );
  const activeSellerIds = new Set(validQuotes.map((quote) => quote.sellerId));
  const byName = (a: AnalyticsEmployee, b: AnalyticsEmployee) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" });

  return {
    countries: sortedDistinct(employees.map((employee) => employee.country)),
    regions: sortedDistinct(employees.map((employee) => employee.region)),
    departments: sortedDistinct(employees.map((employee) => employee.department)),
    businessRanks: BUSINESS_RANKS.filter((rank) =>
      employees.some((employee) => employee.businessRank === rank)
    ),
    teams: [...employees]
      .filter((employee) => directManagers.has(employee.employeeId))
      .sort(byName)
      .map((manager) => ({
        managerId: manager.employeeId,
        name: manager.name,
        businessTitle: manager.businessTitle,
        memberCount: analyticsTeamEmployeeIds(employees, manager.employeeId).size
      })),
    sellers: [...employees]
      .filter((employee) =>
        employee.businessRank === "salesperson" || activeSellerIds.has(employee.employeeId)
      )
      .sort(byName)
      .map((employee) => ({
        employeeId: employee.employeeId,
        name: employee.name,
        businessTitle: employee.businessTitle
      })),
    quoteStatuses: [...ANALYTICS_QUOTE_STATUSES]
  };
}

function aggregateTotals(metrics: EmployeeQuoteMetrics[]) {
  const totals = metrics.reduce(
    (current, metric) => ({
      quotesCreated: current.quotesCreated + metric.quotesCreated,
      quotesSent: current.quotesSent + metric.quotesSent,
      quotesAccepted: current.quotesAccepted + metric.quotesAccepted,
      quotesRejected: current.quotesRejected + metric.quotesRejected,
      quotedValue: current.quotedValue + metric.quotedValue,
      acceptedQuoteValue: current.acceptedQuoteValue + metric.acceptedQuoteValue,
      customersServed: current.customersServed + metric.customersServed,
      newCustomers: current.newCustomers + metric.newCustomers
    }),
    {
      quotesCreated: 0,
      quotesSent: 0,
      quotesAccepted: 0,
      quotesRejected: 0,
      quotedValue: 0,
      acceptedQuoteValue: 0,
      customersServed: 0,
      newCustomers: 0
    }
  );

  return {
    ...totals,
    quoteConversionRate: conversion(totals.quotesAccepted, totals.quotesSent),
    quotedValue: round(totals.quotedValue),
    acceptedQuoteValue: round(totals.acceptedQuoteValue)
  };
}

function regionMetrics(
  metrics: EmployeeQuoteMetrics[],
  quotes: AnalyticsQuote[]
): RegionQuoteMetrics[] {
  const groups = new Map<string, EmployeeQuoteMetrics[]>();
  for (const metric of metrics) {
    const region = metric.region?.trim();
    if (!region) continue;
    groups.set(region, [...(groups.get(region) ?? []), metric]);
  }

  return [...groups.entries()]
    .map(([region, employees]) => {
      const totals = aggregateTotals(employees);
      const employeeIds = new Set(employees.map((employee) => employee.employeeId));
      const customers = new Set(
        quotes
          .filter((quote) => employeeIds.has(quote.sellerId))
          .map((quote) => quote.clientId)
      );
      return {
        region,
        employeeCount: employees.length,
        quotesCreated: totals.quotesCreated,
        quotesAccepted: totals.quotesAccepted,
        quoteConversionRate: totals.quoteConversionRate,
        quotedValue: totals.quotedValue,
        acceptedQuoteValue: totals.acceptedQuoteValue,
        customersServed: customers.size
      };
    })
    .sort((a, b) => b.acceptedQuoteValue - a.acceptedQuoteValue || a.region.localeCompare(b.region));
}

export function buildEmployeeAnalytics({
  scope,
  employees,
  quotes,
  items,
  events,
  filters = {}
}: {
  scope: AnalyticsScope;
  employees: AnalyticsEmployee[];
  quotes: AnalyticsQuote[];
  items: AnalyticsQuoteItem[];
  events: AnalyticsQuoteEvent[];
  filters?: EmployeeAnalyticsFilters;
}): EmployeeAnalyticsPayload {
  const normalizedFilters = normalizeFilters(filters);
  const authorizedEmployeeIds = new Set(employees.map((employee) => employee.employeeId));
  const quoteIdsWithItems = new Set(items.map((item) => item.quoteId));
  const validQuotes = quotes.filter(
    (quote) => quoteIdsWithItems.has(quote.id) && authorizedEmployeeIds.has(quote.sellerId)
  );
  const options = filterOptions(employees, validQuotes);
  const firstQuoteByClient = new Map<string, AnalyticsQuote>();

  for (const quote of [...validQuotes].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )) {
    if (!firstQuoteByClient.has(quote.clientId)) {
      firstQuoteByClient.set(quote.clientId, quote);
    }
  }

  const filteredEmployees = filterEmployees(employees, normalizedFilters);
  const filteredEmployeeIds = new Set(filteredEmployees.map((employee) => employee.employeeId));
  const filteredQuotes = validQuotes.filter((quote) =>
    filteredEmployeeIds.has(quote.sellerId)
    && (!normalizedFilters.quoteStatus || quote.status === normalizedFilters.quoteStatus)
  );
  const eventTypesByQuote = new Map<string, Set<AnalyticsQuoteEvent["eventType"]>>();
  for (const event of events) {
    const eventTypes = eventTypesByQuote.get(event.quoteId) ?? new Set();
    eventTypes.add(event.eventType);
    eventTypesByQuote.set(event.quoteId, eventTypes);
  }

  const metrics = filteredEmployees.map((employee): EmployeeQuoteMetrics => {
    const employeeQuotes = filteredQuotes.filter((quote) => quote.sellerId === employee.employeeId);
    const sentQuotes: AnalyticsQuote[] = [];
    const acceptedQuotes: AnalyticsQuote[] = [];
    const rejectedQuotes: AnalyticsQuote[] = [];

    for (const quote of employeeQuotes) {
      const quoteEvents = eventTypesByQuote.get(quote.id) ?? new Set();
      if (
        quoteEvents.has("sent") ||
        Boolean(quote.sentAt) ||
        ["sent", "accepted", "rejected", "expired"].includes(quote.status)
      ) sentQuotes.push(quote);
      if (quoteEvents.has("accepted") || quote.status === "accepted") acceptedQuotes.push(quote);
      if (quoteEvents.has("rejected") || quote.status === "rejected") rejectedQuotes.push(quote);
    }

    const clients = new Set(employeeQuotes.map((quote) => quote.clientId));
    const newCustomers = employeeQuotes.filter(
      (quote) => firstQuoteByClient.get(quote.clientId)?.id === quote.id
    ).length;

    return {
      ...employee,
      quotesCreated: employeeQuotes.length,
      quotesSent: sentQuotes.length,
      quotesAccepted: acceptedQuotes.length,
      quotesRejected: rejectedQuotes.length,
      quoteConversionRate: conversion(acceptedQuotes.length, sentQuotes.length),
      quotedValue: round(employeeQuotes.reduce((sum, quote) => sum + quote.total, 0)),
      acceptedQuoteValue: round(acceptedQuotes.reduce((sum, quote) => sum + quote.total, 0)),
      customersServed: clients.size,
      newCustomers
    };
  });

  const totals = aggregateTotals(metrics);
  totals.customersServed = new Set(filteredQuotes.map((quote) => quote.clientId)).size;

  return {
    scope,
    currency: "USD",
    generatedAt: new Date().toISOString(),
    filters: normalizedFilters,
    filterOptions: options,
    metrics,
    ranking: [...metrics]
      .filter((metric) => metric.quotesCreated > 0)
      .sort(
        (a, b) => b.acceptedQuoteValue - a.acceptedQuoteValue || a.name.localeCompare(b.name)
      ),
    regions: regionMetrics(metrics, filteredQuotes),
    totals,
    definitions: {
      ranking: "Accepted Quote Value",
      newCustomers: "Customer whose earliest valid quote in the authorized scope belongs to the employee and remains in the filtered result."
    }
  };
}
