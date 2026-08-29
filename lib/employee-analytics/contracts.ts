export type AnalyticsScope = "self" | "subtree" | "global";

export type AnalyticsEmployee = {
  employeeId: string;
  name: string;
  businessTitle: string;
  businessRank: string;
  region: string | null;
  avatarPath: string | null;
};

export type AnalyticsQuote = {
  id: string;
  sellerId: string;
  clientId: string;
  status: "draft" | "sent" | "accepted" | "rejected" | "expired";
  total: number;
  createdAt: string;
  sentAt: string | null;
};

export type AnalyticsQuoteItem = { quoteId: string };
export type AnalyticsQuoteEvent = {
  quoteId: string;
  eventType: "created" | "updated" | "sent" | "accepted" | "rejected" | "expired";
};

export type EmployeeQuoteMetrics = AnalyticsEmployee & {
  quotesCreated: number;
  quotesSent: number;
  quotesAccepted: number;
  quotesRejected: number;
  quoteConversionRate: number;
  quotedValue: number;
  acceptedQuoteValue: number;
  customersServed: number;
  newCustomers: number;
};

export type RegionQuoteMetrics = {
  region: string;
  employeeCount: number;
  quotesCreated: number;
  quotesAccepted: number;
  quoteConversionRate: number;
  quotedValue: number;
  acceptedQuoteValue: number;
  customersServed: number;
};

export type EmployeeAnalyticsPayload = {
  scope: AnalyticsScope;
  currency: "USD";
  generatedAt: string;
  metrics: EmployeeQuoteMetrics[];
  ranking: EmployeeQuoteMetrics[];
  regions: RegionQuoteMetrics[];
  totals: Pick<
    EmployeeQuoteMetrics,
    | "quotesCreated"
    | "quotesSent"
    | "quotesAccepted"
    | "quotesRejected"
    | "quoteConversionRate"
    | "quotedValue"
    | "acceptedQuoteValue"
    | "customersServed"
    | "newCustomers"
  >;
  definitions: {
    ranking: "Accepted Quote Value";
    newCustomers: string;
  };
};
