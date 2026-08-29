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
        mpn: "QKS-DEMO-MCU-042",
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

  it.each(["employee", "manager", "admin", "super_admin_dev"] as const)(
    "returns only seller-safe sourcing fields for %s",
    async (role) => {
      const { client } = supabaseFixture();
      const output = await getSourcingLookup(
        contextFor(role, client),
        "qks-demo-mcu-042"
      );

      expect(client.rpc).toHaveBeenCalledWith(
        "get_seller_safe_sourcing_approvals_v1",
        { input_mpn: "QKS-DEMO-MCU-042" }
      );
      expect(client.from).not.toHaveBeenCalled();
      expect(output.data).toEqual(expect.objectContaining({
        accessMode: "seller_safe",
        mpn: "QKS-DEMO-MCU-042",
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
        selectedEmployee: {
          name: "Maya Torres",
          acceptedQuoteValue: 500,
          salary: 999999,
          compensation: { amount: 999999 }
        },
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
        mpn: "QKS-DEMO-MCU-042",
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

    expect(JSON.stringify(employee.data)).not.toMatch(/salary|compensation|999999/i);
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
      "QKS-DEMO-MCU-042"
    );
    const answer = localizeToolSummary(output, language);

    expect(answer).toContain("QKS-DEMO-MCU-042");
    expect(answer).toContain(phrase);
    expect(answer).not.toContain("Must not leave RPC boundary");
    expect(answer).not.toContain("8.25");
  });
});
