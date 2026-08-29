import type {
  AnalyticsEmployee,
  AnalyticsQuote,
  AnalyticsQuoteEvent,
  AnalyticsQuoteItem,
  AnalyticsScope,
  EmployeeAnalyticsPayload,
  EmployeeQuoteMetrics,
  RegionQuoteMetrics
} from "./contracts";

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function conversion(accepted: number, sent: number) {
  return sent > 0 ? round((accepted / sent) * 100) : 0;
}

function eventSet(events: AnalyticsQuoteEvent[], quoteId: string) {
  return new Set(
    events.filter((event) => event.quoteId === quoteId).map((event) => event.eventType)
  );
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
  events
}: {
  scope: AnalyticsScope;
  employees: AnalyticsEmployee[];
  quotes: AnalyticsQuote[];
  items: AnalyticsQuoteItem[];
  events: AnalyticsQuoteEvent[];
}): EmployeeAnalyticsPayload {
  const quoteIdsWithItems = new Set(items.map((item) => item.quoteId));
  const validQuotes = quotes.filter((quote) => quoteIdsWithItems.has(quote.id));
  const firstQuoteByClient = new Map<string, AnalyticsQuote>();

  for (const quote of [...validQuotes].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )) {
    if (!firstQuoteByClient.has(quote.clientId)) {
      firstQuoteByClient.set(quote.clientId, quote);
    }
  }

  const metrics = employees.map((employee): EmployeeQuoteMetrics => {
    const employeeQuotes = validQuotes.filter((quote) => quote.sellerId === employee.employeeId);
    const sentQuotes: AnalyticsQuote[] = [];
    const acceptedQuotes: AnalyticsQuote[] = [];
    const rejectedQuotes: AnalyticsQuote[] = [];

    for (const quote of employeeQuotes) {
      const quoteEvents = eventSet(events, quote.id);
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
  totals.customersServed = new Set(validQuotes.map((quote) => quote.clientId)).size;
  totals.newCustomers = firstQuoteByClient.size;

  return {
    scope,
    currency: "USD",
    generatedAt: new Date().toISOString(),
    metrics,
    ranking: [...metrics].sort(
      (a, b) => b.acceptedQuoteValue - a.acceptedQuoteValue || a.name.localeCompare(b.name)
    ),
    regions: regionMetrics(metrics, validQuotes),
    totals,
    definitions: {
      ranking: "Accepted Quote Value",
      newCustomers: "Customer whose earliest visible quote belongs to the employee."
    }
  };
}
