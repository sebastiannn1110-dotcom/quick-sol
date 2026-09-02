import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";
import type { UserRole } from "@/lib/types";
import type {
  EmployeeAnalyticsPayload,
  EmployeeQuoteMetrics
} from "@/lib/employee-analytics/contracts";
import type { OrganizationDirectory, OrganizationMember } from "@/lib/organization/contracts";

const serviceMocks = vi.hoisted(() => ({
  loadEmployeeAnalytics: vi.fn(),
  loadOrganizationDirectory: vi.fn()
}));

vi.mock("@/lib/employee-analytics/service", () => ({
  loadEmployeeAnalytics: serviceMocks.loadEmployeeAnalytics
}));
vi.mock("@/lib/organization/service", () => ({
  loadOrganizationDirectory: serviceMocks.loadOrganizationDirectory
}));

import {
  getClientQuoteSummary,
  getEmployeeQuoteMetrics,
  getQuoteSummary,
  getSourcingLookup
} from "@/lib/ai/commerce-tools";
import { detectAssistantIntent } from "@/lib/ai/intent-catalog";
import { localizeToolSummary } from "@/lib/ai/messages";
import { sanitizeToolResultForLlm } from "@/lib/ai/tool-contracts";

const IDS = {
  employee: "00000000-0000-4000-8000-000000000101",
  manager: "00000000-0000-4000-8000-000000000102",
  admin: "00000000-0000-4000-8000-000000000103",
  super_admin_dev: "00000000-0000-4000-8000-000000000104",
  outside: "00000000-0000-4000-8000-000000000105"
} as const;

function contextFor(role: UserRole, supabase: unknown = null): AuthContext {
  return {
    user: null,
    supabase: supabase as AuthContext["supabase"],
    isDemoMode: false,
    profile: {
      id: IDS[role],
      full_name: role === "employee" ? "Maya Torres" : `Synthetic ${role}`,
      email: `${role}@demo.invalid`,
      role,
      department: "Sales",
      region: "Americas",
      is_active: true,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/assistant",
      traceId: "trace",
      requestId: "request"
    }
  };
}

function member(
  profileId: string,
  name: string,
  managerId: string | null,
  technicalRole: UserRole
): OrganizationMember {
  return {
    profileId,
    managerId,
    businessTitle: technicalRole === "manager" ? "Sales Manager" : "Account Executive",
    businessRank: technicalRole === "manager" ? "manager" : "individual_contributor",
    department: "Sales",
    country: "US",
    location: "Americas",
    responsibilities: "Commercial sales",
    version: 1,
    updatedAt: "2026-08-29T00:00:00.000Z",
    name,
    email: `${name.replace(/\s+/g, ".").toLowerCase()}@demo.invalid`,
    technicalRole,
    region: "Americas",
    avatarPath: null,
    canEdit: false
  };
}

const MEMBERS: OrganizationMember[] = [
  member(IDS.admin, "Admin Owner", null, "admin"),
  member(IDS.manager, "Morgan Manager", IDS.admin, "manager"),
  member(IDS.employee, "Maya Torres", IDS.manager, "employee"),
  member(IDS.outside, "Jordan Outside", IDS.admin, "employee"),
  member(IDS.super_admin_dev, "Super Dev", null, "super_admin_dev")
];

function directoryFor(context: AuthContext): OrganizationDirectory {
  return {
    actor: {
      id: context.profile.id,
      technicalRole: context.profile.role,
      businessRank: context.profile.role === "admin" ? "owner" : null,
      canEditGlobal: context.profile.role === "admin" || context.profile.role === "super_admin_dev",
      canReadCompensation: context.profile.role === "admin" || context.profile.role === "super_admin_dev"
    },
    members: MEMBERS
  };
}

function metric(
  employeeId: string,
  name: string,
  acceptedQuoteValue: number
): EmployeeQuoteMetrics {
  return {
    employeeId,
    name,
    businessTitle: "Account Executive",
    businessRank: "individual_contributor",
    region: "Americas",
    avatarPath: null,
    quotesCreated: 4,
    quotesSent: 3,
    quotesAccepted: 2,
    quotesRejected: 1,
    quoteConversionRate: 50,
    quotedValue: acceptedQuoteValue + 250,
    acceptedQuoteValue,
    customersServed: 3,
    newCustomers: 1
  };
}

const METRICS = {
  employee: metric(IDS.employee, "Maya Torres", 500),
  manager: metric(IDS.manager, "Morgan Manager", 200),
  outside: metric(IDS.outside, "Jordan Outside", 900),
  admin: metric(IDS.admin, "Admin Owner", 100),
  super_admin_dev: metric(IDS.super_admin_dev, "Super Dev", 50)
};

function analyticsFor(role: UserRole): EmployeeAnalyticsPayload {
  const visible = role === "employee"
    ? [METRICS.employee]
    : role === "manager"
      ? [METRICS.manager, METRICS.employee]
      : Object.values(METRICS);
  const ranking = [...visible].sort(
    (left, right) => right.acceptedQuoteValue - left.acceptedQuoteValue
  );
  return {
    scope: role === "employee" ? "self" : role === "manager" ? "subtree" : "global",
    currency: "USD",
    generatedAt: "2026-08-29T00:00:00.000Z",
    metrics: visible,
    ranking,
    regions: [],
    totals: {
      quotesCreated: visible.reduce((sum, item) => sum + item.quotesCreated, 0),
      quotesSent: visible.reduce((sum, item) => sum + item.quotesSent, 0),
      quotesAccepted: visible.reduce((sum, item) => sum + item.quotesAccepted, 0),
      quotesRejected: visible.reduce((sum, item) => sum + item.quotesRejected, 0),
      quoteConversionRate: 50,
      quotedValue: visible.reduce((sum, item) => sum + item.quotedValue, 0),
      acceptedQuoteValue: visible.reduce((sum, item) => sum + item.acceptedQuoteValue, 0),
      customersServed: visible.reduce((sum, item) => sum + item.customersServed, 0),
      newCustomers: visible.reduce((sum, item) => sum + item.newCustomers, 0)
    },
    definitions: {
      ranking: "Accepted Quote Value",
      newCustomers: "First quote in the selected period"
    }
  };
}

function performanceAnalytics(): EmployeeAnalyticsPayload {
  const metrics: EmployeeQuoteMetrics[] = [
    {
      ...METRICS.employee,
      country: "Colombia",
      department: "Sales",
      quotesCreated: 6,
      quotesSent: 5,
      quotesAccepted: 4,
      quoteConversionRate: 80,
      acceptedQuoteValue: 1_000,
      customersServed: 5
    },
    {
      ...METRICS.outside,
      name: "Jordan Lee",
      country: "US",
      department: "Sales",
      quotesCreated: 12,
      quotesSent: 10,
      quotesAccepted: 7,
      quoteConversionRate: 70,
      acceptedQuoteValue: 900,
      customersServed: 8
    },
    {
      ...METRICS.manager,
      name: "Morgan Reed",
      country: "Colombia",
      department: "Sales",
      quotesCreated: 4,
      quotesSent: 4,
      quotesAccepted: 3,
      quoteConversionRate: 75,
      acceptedQuoteValue: 800,
      customersServed: 4
    },
    {
      ...METRICS.admin,
      name: "Alex Rivera",
      country: "US",
      department: "Sales",
      quotesCreated: 9,
      quotesSent: 5,
      quotesAccepted: 2,
      quoteConversionRate: 40,
      acceptedQuoteValue: 700,
      customersServed: 6
    },
    {
      ...METRICS.super_admin_dev,
      name: "Taylor Chen",
      country: "US",
      department: "Sales",
      quotesCreated: 3,
      quotesSent: 5,
      quotesAccepted: 1,
      quoteConversionRate: 20,
      acceptedQuoteValue: 600,
      customersServed: 2
    }
  ];
  const totals = {
    quotesCreated: metrics.reduce((sum, item) => sum + item.quotesCreated, 0),
    quotesSent: metrics.reduce((sum, item) => sum + item.quotesSent, 0),
    quotesAccepted: metrics.reduce((sum, item) => sum + item.quotesAccepted, 0),
    quotesRejected: metrics.reduce((sum, item) => sum + item.quotesRejected, 0),
    quoteConversionRate: 62.07,
    quotedValue: metrics.reduce((sum, item) => sum + item.quotedValue, 0),
    acceptedQuoteValue: metrics.reduce((sum, item) => sum + item.acceptedQuoteValue, 0),
    customersServed: 25,
    newCustomers: metrics.reduce((sum, item) => sum + item.newCustomers, 0)
  };
  return {
    ...analyticsFor("admin"),
    filters: {},
    filterOptions: {
      countries: ["Colombia", "US"],
      regions: ["Americas"],
      departments: ["Sales"],
      businessRanks: ["individual_contributor"],
      teams: [],
      sellers: metrics.map((item) => ({
        employeeId: item.employeeId,
        name: item.name,
        businessTitle: item.businessTitle
      })),
      quoteStatuses: ["draft", "sent", "accepted", "rejected", "expired"]
    },
    metrics,
    ranking: [...metrics].sort(
      (left, right) => right.acceptedQuoteValue - left.acceptedQuoteValue
    ),
    totals
  };
}

const QUOTES = [
  {
    quote_number: "Q-MAYA-OPEN",
    seller_id: IDS.employee,
    client_id: "client-acme",
    status: "sent",
    total: 100,
    currency: "USD",
    created_at: "2026-08-29T10:00:00.000Z",
    valid_until: "2026-09-29",
    customer: { name: "Acme" },
    seller: { full_name: "Maya Torres" }
  },
  {
    quote_number: "Q-MAYA-ACCEPTED",
    seller_id: IDS.employee,
    client_id: "client-acme",
    status: "accepted",
    total: 300,
    currency: "USD",
    created_at: "2026-08-28T10:00:00.000Z",
    valid_until: "2026-09-28",
    customer: { name: "Acme" },
    seller: { full_name: "Maya Torres" }
  },
  {
    quote_number: "Q-MANAGER-OPEN",
    seller_id: IDS.manager,
    client_id: "client-beta",
    status: "draft",
    total: 200,
    currency: "USD",
    created_at: "2026-08-27T10:00:00.000Z",
    valid_until: "2026-09-27",
    customer: { name: "Beta" },
    seller: { full_name: "Morgan Manager" }
  },
  {
    quote_number: "Q-OUTSIDE-OPEN",
    seller_id: IDS.outside,
    client_id: "client-gamma",
    status: "sent",
    total: 999,
    currency: "USD",
    created_at: "2026-08-26T10:00:00.000Z",
    valid_until: "2026-09-26",
    customer: { name: "Gamma" },
    seller: { full_name: "Jordan Outside" }
  }
];

function supabaseFixture(quotes = QUOTES) {
  let sellerIds: string[] = [];
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.in = vi.fn((_column: string, ids: string[]) => {
    sellerIds = ids;
    return query;
  });
  query.order = vi.fn(() => query);
  query.limit = vi.fn(async () => ({
    data: quotes.filter((quote) => sellerIds.includes(quote.seller_id)),
    error: null
  }));
  const client = {
    from: vi.fn(() => query),
    rpc: vi.fn(async () => ({
      data: [{
        mpn: "EPD-DEMO-MCU-042",
        manufacturer: "DemoSemi",
        authorized_unit_price: 12.5,
        currency: "USD",
        coarse_availability: "available",
        lead_time_days: 5,
        minimum_order_quantity: 10,
        valid_until: "2026-09-30",
        supplier_name: "Must not leave RPC boundary",
        raw_unit_cost: 8.25,
        available_quantity: 1234
      }],
      error: null
    }))
  };
  return { client, query };
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.loadOrganizationDirectory.mockImplementation(
    async (context: AuthContext) => directoryFor(context)
  );
  serviceMocks.loadEmployeeAnalytics.mockImplementation(
    async (context: AuthContext) => analyticsFor(context.profile.role)
  );
});

describe("read-only commerce AI tools", () => {
  it.each([
    ["employee", [IDS.employee], "own", "Acme"],
    ["manager", [IDS.manager, IDS.employee], "team", "Beta"],
    ["admin", MEMBERS.map((item) => item.profileId), "company", "Gamma"],
    ["super_admin_dev", MEMBERS.map((item) => item.profileId), "company", "Gamma"]
  ] as const)(
    "applies the UI/API organization scope to quote and client summaries for %s",
    async (role, expectedIds, expectedScope, expectedTopClient) => {
      const { client, query } = supabaseFixture();
      const context = contextFor(role, client);
      const quoteSummary = await getQuoteSummary(context);
      const clientSummary = await getClientQuoteSummary(context);

      expect(client.from).toHaveBeenCalledWith("commerce_quotes");
      expect(query.in).toHaveBeenCalledWith("seller_id", [...expectedIds]);
      expect(quoteSummary.scope).toBe(expectedScope);
      expect(clientSummary.scope).toBe(expectedScope);
      expect((clientSummary.data as { topClient: { name: string } }).topClient.name)
        .toBe(expectedTopClient);

      const serialized = JSON.stringify([quoteSummary.data, clientSummary.data]);
      expect(serialized).not.toMatch(/seller_id|client_id|@demo\.invalid|salary|compensation/i);
      if (role === "employee" || role === "manager") {
        expect(serialized).not.toMatch(/Jordan Outside|Q-OUTSIDE-OPEN|Gamma/);
      }
    }
  );

  it.each([
    ["employee", "self", "Maya Torres"],
    ["manager", "subtree", "Maya Torres"],
    ["admin", "global", "Jordan Outside"],
    ["super_admin_dev", "global", "Jordan Outside"]
  ] as const)(
    "uses the employee analytics scope and Accepted Quote Value ranking for %s",
    async (role, expectedAnalyticsScope, expectedLeader) => {
      const context = contextFor(role);
      const output = await getEmployeeQuoteMetrics(
        context,
        "Who has the highest Accepted Quote Value?"
      );
      const data = output.data as {
        analyticsScope: string;
        selectedEmployee: { name: string };
      };

      expect(serviceMocks.loadEmployeeAnalytics).toHaveBeenCalledWith(context);
      expect(data.analyticsScope).toBe(expectedAnalyticsScope);
      expect(data.selectedEmployee.name).toBe(expectedLeader);
      expect(JSON.stringify(data)).not.toMatch(/salary|compensation|employeeId|email/i);
      if (role === "employee" || role === "manager") {
        expect(JSON.stringify(data)).not.toContain("Jordan Outside");
      }
    }
  );

  it.each(["employee", "manager"] as const)(
    "does not reveal an out-of-scope employee to %s",
    async (role) => {
      const output = await getEmployeeQuoteMetrics(
        contextFor(role),
        "How many quotes does Jordan Outside have?"
      );

      expect(JSON.stringify(output.data)).not.toContain("Jordan Outside");
      expect(JSON.stringify(output.data)).not.toMatch(/salary|compensation/i);
    }
  );

  it("returns an explicit empty ranking when visible employees have no quote activity", async () => {
    const zeroMetric: EmployeeQuoteMetrics = {
      ...METRICS.employee,
      quotesCreated: 0,
      quotesSent: 0,
      quotesAccepted: 0,
      quotesRejected: 0,
      quoteConversionRate: 0,
      quotedValue: 0,
      acceptedQuoteValue: 0,
      customersServed: 0,
      newCustomers: 0
    };
    serviceMocks.loadEmployeeAnalytics.mockResolvedValueOnce({
      ...analyticsFor("employee"),
      metrics: [zeroMetric],
      ranking: [],
      totals: {
        quotesCreated: 0,
        quotesSent: 0,
        quotesAccepted: 0,
        quotesRejected: 0,
        quoteConversionRate: 0,
        quotedValue: 0,
        acceptedQuoteValue: 0,
        customersServed: 0,
        newCustomers: 0
      }
    });

    const output = await getEmployeeQuoteMetrics(
      contextFor("employee"),
      "Who has the highest Accepted Quote Value?"
    );

    expect(output).toEqual(expect.objectContaining({
      ok: false,
      empty: true,
      total: 0,
      rows: []
    }));
    expect(output.data).toHaveProperty("selectedEmployee", null);
    expect(JSON.stringify(output.data)).not.toMatch(/salary|compensation/i);
  });

  it.each([
    ["es", "quien es el mejor vendedor"],
    ["es", "de los empleados en la base de datos quien tiene las mejores metricas"],
    ["en", "who is the best salesperson"],
    ["zh", "\u8c01\u662f\u8868\u73b0\u6700\u597d\u7684\u9500\u552e\u4eba\u5458"]
  ] as const)("uses the canonical Employee Analytics overall ranking for %s natural language", async (language, question) => {
    const analytics = performanceAnalytics();
    serviceMocks.loadEmployeeAnalytics.mockResolvedValueOnce(analytics);

    const output = await getEmployeeQuoteMetrics(contextFor("admin"), question, { language });
    const data = output.data as {
      queryMode: string;
      sortBy: string;
      selectedEmployee: { name: string };
      metricDefinition: string;
    };

    expect(data.queryMode).toBe("ranking");
    expect(data.sortBy).toBe("overall");
    expect(data.metricDefinition).toBe(analytics.definitions.ranking);
    expect(data.selectedEmployee.name).toBe(analytics.ranking[0].name);
    expect(JSON.stringify(data)).not.toMatch(/employeeId|email|salary|compensation/i);
  });

  it("keeps the natural-language → intent → canonical metrics → answer contract deterministic", async () => {
    serviceMocks.loadEmployeeAnalytics.mockResolvedValueOnce(performanceAnalytics());
    const question = "quien es el mejor vendedor";
    const detected = detectAssistantIntent(question, "es");

    expect(detected).toEqual(expect.objectContaining({
      intent: "employee_quote_metrics",
      tool: "employee_quote_metrics",
      ambiguous: false
    }));

    const toolResult = await getEmployeeQuoteMetrics(contextFor("admin"), question, {
      language: "es"
    });
    const answer = localizeToolSummary(toolResult, "es");

    expect(toolResult.data).toEqual(expect.objectContaining({
      selectedEmployee: expect.objectContaining({
        name: "Maya Torres",
        quotesAccepted: 4,
        quoteConversionRate: 80,
        acceptedQuoteValue: 1_000
      })
    }));
    expect(answer).toContain("Maya Torres");
    expect(answer).toContain("4 cotizaciones aceptadas");
    expect(answer).toContain("80% de conversión");
    expect(answer).toContain("Accepted Quote Value");
    expect(answer).not.toMatch(/\b(?:salary|compensation|revenue|ventas?)\b/i);
  });

  it.each([
    ["quien ha conseguido mas cotizaciones aceptadas", "accepted_quotes", "Jordan Lee"],
    ["quien tiene mayor conversion", "conversion_rate", "Maya Torres"],
    ["quien ha enviado mas cotizaciones", "sent_quotes", "Jordan Lee"],
    ["quien ha creado mas cotizaciones", "created_quotes", "Jordan Lee"],
    ["quien tiene mas clientes atendidos", "customers_served", "Jordan Lee"],
    ["who has the highest accepted quote value", "accepted_quote_value", "Maya Torres"]
  ] as const)("sorts %s by %s", async (question, expectedSort, expectedName) => {
    serviceMocks.loadEmployeeAnalytics.mockResolvedValueOnce(performanceAnalytics());

    const output = await getEmployeeQuoteMetrics(contextFor("admin"), question);
    const data = output.data as {
      sortBy: string;
      selectedEmployee: { name: string };
    };

    expect(data.sortBy).toBe(expectedSort);
    expect(data.selectedEmployee.name).toBe(expectedName);
  });

  it("returns a requested top N and resolves ordinal/next-ranking follow-ups", async () => {
    serviceMocks.loadEmployeeAnalytics.mockResolvedValue(performanceAnalytics());
    const context = contextFor("admin");

    const topFive = await getEmployeeQuoteMetrics(
      context,
      "cuales son los 5 mejores vendedores",
      { language: "es" }
    );
    const second = await getEmployeeQuoteMetrics(
      context,
      "y el segundo",
      {
        language: "es",
        history: [{ role: "user", content: "quien es el mejor vendedor" }]
      }
    );
    const nextFour = await getEmployeeQuoteMetrics(
      context,
      "y los siguientes cuatro",
      {
        language: "es",
        history: [{ role: "user", content: "quien es el mejor vendedor" }]
      }
    );

    expect((topFive.data as { ranking: unknown[] }).ranking).toHaveLength(5);
    expect((second.data as { rankStart: number; selectedEmployee: { name: string } })).toEqual(
      expect.objectContaining({
        rankStart: 2,
        selectedEmployee: expect.objectContaining({ name: "Jordan Lee" })
      })
    );
    expect((nextFour.data as { rankStart: number; ranking: Array<{ name: string }> })).toEqual(
      expect.objectContaining({
        rankStart: 2,
        ranking: [
          expect.objectContaining({ name: "Jordan Lee" }),
          expect.objectContaining({ name: "Morgan Reed" }),
          expect.objectContaining({ name: "Alex Rivera" }),
          expect.objectContaining({ name: "Taylor Chen" })
        ]
      })
    );

    const topFiveAnswer = localizeToolSummary(topFive, "es");
    const nextFourAnswer = localizeToolSummary(nextFour, "es");
    expect(topFiveAnswer).toContain("1. Maya Torres");
    expect(topFiveAnswer).toContain("5. Taylor Chen");
    expect(nextFourAnswer).toContain("puestos 2 a 5");
    expect(nextFourAnswer).toContain("2. Jordan Lee");
    expect(nextFourAnswer).toContain("5. Taylor Chen");
  });

  it("returns aggregate metrics from Employee Analytics without selecting an employee", async () => {
    serviceMocks.loadEmployeeAnalytics.mockResolvedValueOnce(performanceAnalytics());

    const output = await getEmployeeQuoteMetrics(
      contextFor("admin"),
      "cuantas cotizaciones aceptadas tenemos",
      { language: "es" }
    );
    const data = output.data as {
      queryMode: string;
      selectedEmployee: null;
      activeSellerCount: number;
      totals: { quotesAccepted: number; quoteConversionRate: number };
    };

    expect(data).toEqual(expect.objectContaining({
      queryMode: "aggregate",
      selectedEmployee: null,
      activeSellerCount: 5,
      totals: expect.objectContaining({
        quotesAccepted: 17,
        quoteConversionRate: 62.07
      })
    }));
    expect(output.summary).toContain("17 cotizaciones aceptadas");
    expect(localizeToolSummary(output, "es")).toContain("17 cotizaciones aceptadas");
  });

  it.each([
    ["cuantas cotizaciones enviadas tenemos", "sent_quotes", "29 cotizaciones enviadas"],
    ["cuantas cotizaciones creadas tenemos", "created_quotes", "34 cotizaciones creadas"],
    ["cuantos clientes atendidos tenemos", "customers_served", "25 clientes atendidos"]
  ] as const)("renders canonical aggregate %s", async (question, sortBy, expected) => {
    serviceMocks.loadEmployeeAnalytics.mockResolvedValueOnce(performanceAnalytics());

    const output = await getEmployeeQuoteMetrics(contextFor("admin"), question, { language: "es" });

    expect(output.data).toEqual(expect.objectContaining({ queryMode: "aggregate", sortBy }));
    expect(localizeToolSummary(output, "es")).toContain(expected);
  });

  it("answers an individual customers-served question with only safe visible fields", async () => {
    serviceMocks.loadEmployeeAnalytics.mockResolvedValueOnce(performanceAnalytics());

    const output = await getEmployeeQuoteMetrics(
      contextFor("admin"),
      "cuantos clientes ha atendido Maya"
    );
    const data = output.data as {
      queryMode: string;
      sortBy: string;
      selectedEmployee: { name: string; customersServed: number };
    };

    expect(data).toEqual(expect.objectContaining({
      queryMode: "employee",
      sortBy: "customers_served",
      selectedEmployee: expect.objectContaining({
        name: "Maya Torres",
        customersServed: 5
      })
    }));
    expect(JSON.stringify(data)).not.toMatch(/employeeId|email|salary|compensation/i);
  });

  it("compares two visible employees and keeps the pair for a metric follow-up", async () => {
    serviceMocks.loadEmployeeAnalytics.mockResolvedValue(performanceAnalytics());
    const context = contextFor("admin");

    const comparison = await getEmployeeQuoteMetrics(
      context,
      "Compara Maya con Morgan",
      { language: "es" }
    );
    const followUp = await getEmployeeQuoteMetrics(
      context,
      "quien tiene mejor conversion",
      {
        language: "es",
        history: [{ role: "user", content: "Compara Maya con Morgan" }]
      }
    );
    const staleFollowUp = await getEmployeeQuoteMetrics(
      context,
      "quien tiene mejor conversion",
      {
        language: "es",
        history: [
          { role: "user", content: "Compara Maya con Morgan" },
          { role: "assistant", content: "Maya lidera." },
          { role: "user", content: "busca MPN ABC123" },
          { role: "assistant", content: "Encontré ABC123." }
        ]
      }
    );

    expect(comparison.data).toEqual(expect.objectContaining({
      queryMode: "comparison",
      sortBy: "overall",
      comparison: expect.objectContaining({
        winner: expect.objectContaining({ name: "Maya Torres" }),
        tied: false
      })
    }));
    expect(followUp.data).toEqual(expect.objectContaining({
      queryMode: "comparison",
      sortBy: "conversion_rate",
      comparison: expect.objectContaining({
        winner: expect.objectContaining({ name: "Maya Torres" }),
        employees: [
          expect.objectContaining({ name: "Maya Torres", quoteConversionRate: 80 }),
          expect.objectContaining({ name: "Morgan Reed", quoteConversionRate: 75 })
        ]
      })
    }));
    expect(staleFollowUp.data).toEqual(expect.objectContaining({
      queryMode: "ranking",
      sortBy: "conversion_rate",
      selectedEmployee: expect.objectContaining({ name: "Maya Torres" })
    }));
    const answer = localizeToolSummary(followUp, "es");
    expect(answer).toContain("Maya Torres");
    expect(answer).toContain("80%");
    expect(answer).toContain("Morgan Reed");
    expect(answer).toContain("75%");
    expect(answer).toContain("Maya Torres lidera");
  });

  it("asks for clarification when a visible employee name is duplicated", async () => {
    const analytics = performanceAnalytics();
    const duplicates: EmployeeQuoteMetrics[] = [
      { ...analytics.metrics[0], employeeId: "duplicate-one", name: "Sam Lee", region: "Americas" },
      { ...analytics.metrics[1], employeeId: "duplicate-two", name: "Sam Lee", region: "APAC" }
    ];
    serviceMocks.loadEmployeeAnalytics.mockResolvedValueOnce({
      ...analytics,
      metrics: [...analytics.metrics, ...duplicates],
      ranking: [...analytics.ranking, ...duplicates]
    });

    const output = await getEmployeeQuoteMetrics(
      contextFor("admin"),
      "Compara Sam Lee con Maya",
      { language: "es" }
    );
    const data = output.data as {
      queryMode: string;
      clarification: { required: boolean; reason: string; candidates: Array<{ name: string }> };
    };

    expect(data.queryMode).toBe("clarification");
    expect(data.clarification).toEqual(expect.objectContaining({
      required: true,
      reason: "ambiguous_employee_name"
    }));
    expect(data.clarification.candidates.filter((item) => item.name === "Sam Lee")).toHaveLength(2);
    expect(JSON.stringify(data)).not.toMatch(/duplicate-one|duplicate-two|employeeId|email/i);
    const answer = localizeToolSummary(output, "es");
    expect(answer).toContain("Opciones:");
    expect(answer).toContain("Americas");
    expect(answer).toContain("APAC");
  });

  it("uses the canonical draft filter and ranks by draft quote count", async () => {
    const analytics = performanceAnalytics();
    const draftCounts = new Map([
      [IDS.employee, 2],
      [IDS.outside, 4],
      [IDS.manager, 8],
      [IDS.admin, 1],
      [IDS.super_admin_dev, 0]
    ]);
    const draftMetrics = analytics.metrics.map((item) => ({
      ...item,
      quotesCreated: draftCounts.get(item.employeeId) ?? 0
    }));
    const draftAnalytics = {
      ...analytics,
      filters: { quoteStatus: "draft" as const },
      metrics: draftMetrics,
      totals: {
        ...analytics.totals,
        quotesCreated: draftMetrics.reduce((sum, item) => sum + item.quotesCreated, 0)
      }
    };
    serviceMocks.loadEmployeeAnalytics.mockImplementation(async (_context, filters) =>
      filters?.quoteStatus === "draft" ? draftAnalytics : analytics
    );
    const context = contextFor("admin");

    const output = await getEmployeeQuoteMetrics(
      context,
      "que vendedor tiene mas quotes en draft"
    );

    expect(serviceMocks.loadEmployeeAnalytics).toHaveBeenNthCalledWith(1, context);
    expect(serviceMocks.loadEmployeeAnalytics).toHaveBeenNthCalledWith(2, context, {
      quoteStatus: "draft"
    });
    expect(output.data).toEqual(expect.objectContaining({
      sortBy: "draft_quotes",
      selectedEmployee: expect.objectContaining({
        name: "Morgan Reed",
        draftQuotes: 8
      }),
      totals: expect.objectContaining({ draftQuotes: 15 })
    }));
  });

  it("reuses Employee Analytics filters for a country-specific ranking", async () => {
    const analytics = performanceAnalytics();
    const colombiaMetrics = analytics.metrics.filter((item) => item.country === "Colombia");
    const colombiaAnalytics = {
      ...analytics,
      filters: { country: "Colombia" },
      metrics: colombiaMetrics,
      ranking: [colombiaMetrics[1], colombiaMetrics[0]]
    };
    serviceMocks.loadEmployeeAnalytics.mockImplementation(async (_context, filters) =>
      filters?.country === "Colombia" ? colombiaAnalytics : analytics
    );
    const context = contextFor("admin");

    const output = await getEmployeeQuoteMetrics(
      context,
      "cual es el mejor vendedor de Colombia"
    );

    expect(serviceMocks.loadEmployeeAnalytics).toHaveBeenNthCalledWith(1, context);
    expect(serviceMocks.loadEmployeeAnalytics).toHaveBeenNthCalledWith(2, context, {
      country: "Colombia"
    });
    expect(output.data).toEqual(expect.objectContaining({
      appliedFilters: { country: "Colombia" },
      selectedEmployee: expect.objectContaining({ name: "Morgan Reed" })
    }));
    const answer = localizeToolSummary(output, "es");
    expect(answer).toContain("Morgan Reed");
    expect(answer).toContain("país Colombia");
  });

  it("returns below-average and needs-improvement views without inventing a score", async () => {
    serviceMocks.loadEmployeeAnalytics.mockResolvedValue(performanceAnalytics());
    const context = contextFor("admin");

    const belowAverage = await getEmployeeQuoteMetrics(
      context,
      "quien esta por debajo del promedio de accepted quote value"
    );
    const needsImprovement = await getEmployeeQuoteMetrics(
      context,
      "que vendedor necesita mejorar"
    );

    expect(belowAverage.data).toEqual(expect.objectContaining({
      queryMode: "below_average",
      sortBy: "accepted_quote_value",
      average: { metric: "accepted_quote_value", value: 800 },
      belowAverage: [
        expect.objectContaining({ name: "Alex Rivera", acceptedQuoteValue: 700 }),
        expect.objectContaining({ name: "Taylor Chen", acceptedQuoteValue: 600 })
      ]
    }));
    expect(needsImprovement.data).toEqual(expect.objectContaining({
      queryMode: "needs_improvement",
      sortBy: "overall",
      selectedEmployee: expect.objectContaining({ name: "Taylor Chen" }),
      metricDefinition: "Accepted Quote Value"
    }));
  });

  it.each(["employee", "manager", "admin", "super_admin_dev"] as const)(
    "returns only seller-safe sourcing fields for %s",
    async (role) => {
      const { client } = supabaseFixture();
      const output = await getSourcingLookup(
        contextFor(role, client),
        "epd-demo-mcu-042"
      );

      expect(client.rpc).toHaveBeenCalledWith(
        "get_seller_safe_sourcing_approvals_v1",
        { input_mpn: "EPD-DEMO-MCU-042" }
      );
      expect(client.from).not.toHaveBeenCalled();
      expect(output.data).toEqual(expect.objectContaining({
        accessMode: "seller_safe",
        mpn: "EPD-DEMO-MCU-042",
        approvals: [expect.objectContaining({
          authorizedUnitPrice: 12.5,
          coarseAvailability: "available"
        })]
      }));
      expect(JSON.stringify(output.data)).not.toMatch(
        /supplier_name|supplierName|raw_unit_cost|rawUnitCost|available_quantity|availableQuantity|salary|compensation/i
      );
    }
  );

  it("returns deterministic no-data results without broadening the actor scope", async () => {
    const { client, query } = supabaseFixture([]);
    serviceMocks.loadEmployeeAnalytics.mockResolvedValueOnce({
      ...analyticsFor("employee"),
      metrics: [],
      ranking: []
    });

    const context = contextFor("employee", client);
    const quotes = await getQuoteSummary(context);
    const employees = await getEmployeeQuoteMetrics(context, "quotes for Maya Torres");

    expect(quotes).toEqual(expect.objectContaining({
      ok: false,
      scope: "own",
      empty: true,
      deterministic: true
    }));
    expect(employees).toEqual(expect.objectContaining({
      ok: false,
      scope: "own",
      empty: true,
      deterministic: true
    }));
    expect(query.in).toHaveBeenCalledWith("seller_id", [IDS.employee]);
  });

  it("allowlists LLM fields and strips salary and raw sourcing payloads", () => {
    const employee = sanitizeToolResultForLlm({
      ok: true,
      tool: "employee_quote_metrics",
      scope: "company",
      total: 1,
      rows: [],
      data: {
        analyticsScope: "global",
        generatedAt: "2026-08-30T12:00:00.000Z",
        queryMode: "comparison",
        sortBy: "conversion_rate",
        metricDefinition: "conversion_rate",
        requestedLimit: 2,
        rankStart: 1,
        activeSellerCount: 5,
        appliedFilters: { country: "Colombia", teamManagerId: "secret-manager-id" },
        selectedEmployee: {
          name: "Maya Torres",
          employeeId: "secret-employee-id",
          country: "Colombia",
          department: "Sales",
          draftQuotes: 2,
          acceptedQuoteValue: 500,
          salary: 999999,
          compensation: { amount: 999999 }
        },
        comparison: {
          metric: "conversion_rate",
          employees: [{ name: "Maya Torres", quoteConversionRate: 80, email: "hidden@example.com" }],
          winner: { name: "Maya Torres", quoteConversionRate: 80, employeeId: "secret" },
          tied: false
        },
        average: { metric: "conversion_rate", value: 62.5 },
        belowAverage: [{ name: "Taylor Chen", quoteConversionRate: 20, email: "hidden@example.com" }],
        needsImprovement: [{ name: "Taylor Chen", quoteConversionRate: 20, salary: 999999 }],
        salary: 999999
      },
      summary: "",
      empty: false,
      deterministic: true
    });
    const sourcing = sanitizeToolResultForLlm({
      ok: true,
      tool: "sourcing_lookup",
      scope: "company",
      total: 1,
      rows: [],
      data: {
        accessMode: "raw",
        mpn: "EPD-DEMO-MCU-042",
        approvals: [{
          authorizedUnitPrice: 12.5,
          rawUnitCost: 8.25,
          supplierName: "Secret Supplier",
          availableQuantity: 1234
        }]
      },
      summary: "",
      empty: false,
      deterministic: true
    });

    expect(employee.data).toEqual(expect.objectContaining({
      queryMode: "comparison",
      sortBy: "conversion_rate",
      appliedFilters: { country: "Colombia" },
      selectedEmployee: expect.objectContaining({
        name: "Maya Torres",
        country: "Colombia",
        department: "Sales",
        draftQuotes: 2
      }),
      comparison: expect.objectContaining({
        metric: "conversion_rate",
        winner: expect.objectContaining({ name: "Maya Torres", quoteConversionRate: 80 }),
        tied: false
      }),
      average: { metric: "conversion_rate", value: 62.5 },
      belowAverage: [expect.objectContaining({ name: "Taylor Chen", quoteConversionRate: 20 })],
      needsImprovement: [expect.objectContaining({ name: "Taylor Chen", quoteConversionRate: 20 })]
    }));
    expect(JSON.stringify(employee.data)).not.toMatch(/salary|compensation|999999|employeeId|email|secret/i);
    expect(sourcing.data).toEqual(expect.objectContaining({ accessMode: "seller_safe" }));
    expect(JSON.stringify(sourcing.data)).not.toMatch(/rawUnitCost|supplierName|availableQuantity|Secret Supplier/i);
  });

  it.each([
    ["es", "mayor Accepted Quote Value"],
    ["en", "highest Accepted Quote Value"],
    ["zh", "\u5df2\u63a5\u53d7\u62a5\u4ef7\u91d1\u989d\u6700\u9ad8"]
  ] as const)("renders the same safe employee facts in %s", async (language, phrase) => {
    const output = await getEmployeeQuoteMetrics(
      contextFor("manager"),
      "Who has the highest Accepted Quote Value?"
    );
    const answer = localizeToolSummary(output, language);

    expect(answer).toContain("Maya Torres");
    expect(answer).toContain(phrase);
    expect(answer).not.toMatch(/salary|compensation/i);
  });

  it.each([
    ["es", "La IA no incluye costo de proveedor"],
    ["en", "Supplier cost and exact internal quantity are not included"],
    ["zh", "\u4f9b\u5e94\u5546\u6210\u672c\u548c\u7cbe\u786e\u5e93\u5b58\u672a\u5305\u542b"]
  ] as const)("states the seller-safe sourcing boundary in %s", async (language, phrase) => {
    const { client } = supabaseFixture();
    const output = await getSourcingLookup(
      contextFor("admin", client),
      "EPD-DEMO-MCU-042"
    );
    const answer = localizeToolSummary(output, language);

    expect(answer).toContain("EPD-DEMO-MCU-042");
    expect(answer).toContain(phrase);
    expect(answer).not.toContain("Must not leave RPC boundary");
    expect(answer).not.toContain("8.25");
  });
});
