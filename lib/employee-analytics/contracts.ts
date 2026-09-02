import { z } from "zod";
import { BUSINESS_RANKS, type BusinessRank } from "@/lib/organization/contracts";

export type AnalyticsScope = "self" | "subtree" | "global";

export const ANALYTICS_QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired"
] as const;

export type AnalyticsQuoteStatus = (typeof ANALYTICS_QUOTE_STATUSES)[number];

export type EmployeeAnalyticsFilters = {
  country?: string;
  region?: string;
  department?: string;
  businessRank?: BusinessRank;
  teamManagerId?: string;
  sellerId?: string;
  quoteStatus?: AnalyticsQuoteStatus;
};

const optionalFilterText = (maxLength: number) => z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).max(maxLength).optional()
);

export const employeeAnalyticsFiltersSchema = z.object({
  country: optionalFilterText(100),
  region: optionalFilterText(100),
  department: optionalFilterText(160),
  businessRank: z.enum(BUSINESS_RANKS).optional(),
  teamManagerId: z.string().uuid().optional(),
  sellerId: z.string().uuid().optional(),
  quoteStatus: z.enum(ANALYTICS_QUOTE_STATUSES).optional()
}).strict();

export const EMPLOYEE_ANALYTICS_FILTER_NAMES = [
  "country",
  "region",
  "department",
  "businessRank",
  "teamManagerId",
  "sellerId",
  "quoteStatus"
] as const;

const employeeAnalyticsFilterNameSet = new Set<string>(EMPLOYEE_ANALYTICS_FILTER_NAMES);

export function parseEmployeeAnalyticsFilters(searchParams: URLSearchParams) {
  for (const key of searchParams.keys()) {
    if (!employeeAnalyticsFilterNameSet.has(key) || searchParams.getAll(key).length !== 1) {
      throw new Error("EMPLOYEE_ANALYTICS_FILTERS_INVALID");
    }
  }

  const raw: Record<string, string> = {};
  for (const name of EMPLOYEE_ANALYTICS_FILTER_NAMES) {
    const value = searchParams.get(name);
    if (value !== null) raw[name] = value;
  }
  const parsed = employeeAnalyticsFiltersSchema.safeParse(raw);
  if (!parsed.success) throw new Error("EMPLOYEE_ANALYTICS_FILTERS_INVALID");
  return parsed.data as EmployeeAnalyticsFilters;
}

export type AnalyticsEmployee = {
  employeeId: string;
  managerId: string | null;
  name: string;
  businessTitle: string;
  businessRank: BusinessRank;
  department: string | null;
  country: string | null;
  region: string | null;
  avatarPath: string | null;
};

export type AnalyticsQuote = {
  id: string;
  sellerId: string;
  clientId: string;
  status: AnalyticsQuoteStatus;
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

export type EmployeeAnalyticsFilterOptions = {
  countries: string[];
  regions: string[];
  departments: string[];
  businessRanks: BusinessRank[];
  teams: Array<{
    managerId: string;
    name: string;
    businessTitle: string;
    memberCount: number;
  }>;
  sellers: Array<{
    employeeId: string;
    name: string;
    businessTitle: string;
  }>;
  quoteStatuses: AnalyticsQuoteStatus[];
};

export type EmployeeAnalyticsPayload = {
  scope: AnalyticsScope;
  currency: "USD";
  generatedAt: string;
  filters: EmployeeAnalyticsFilters;
  filterOptions: EmployeeAnalyticsFilterOptions;
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
