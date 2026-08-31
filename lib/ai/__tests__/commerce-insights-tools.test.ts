import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";
import type { UserRole } from "@/lib/types";

const organizationMocks = vi.hoisted(() => ({
  loadOrganizationDirectory: vi.fn()
}));
const commerceMocks = vi.hoisted(() => ({
  listCommerceManageableClientIds: vi.fn()
}));

vi.mock("@/lib/organization/service", () => ({
  loadOrganizationDirectory: organizationMocks.loadOrganizationDirectory
}));
vi.mock("@/lib/commerce/service", () => ({
  listCommerceManageableClientIds: commerceMocks.listCommerceManageableClientIds
}));

import {
  getClientLookup,
  getRfqSummary,
  parseClientInsightMode,
  parseRfqInsightMode
} from "@/lib/ai/commerce-insights-tools";

function contextFor(role: UserRole, supabase: unknown): AuthContext {
  return {
    user: null,
    supabase: supabase as AuthContext["supabase"],
    isDemoMode: false,
    profile: {
      id: `00000000-0000-4000-8000-00000000000${role === "admin" ? 1 : role === "manager" ? 2 : 3}`,
      full_name: role === "employee" ? "Maya Torres" : `Demo ${role}`,
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

function queryBuilder(response: { data: unknown; error: unknown; count?: number | null }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "is", "ilike", "in", "gte", "order"]) {
    query[method] = vi.fn(() => query);
  }
  query.limit = vi.fn(async () => response);
  query.maybeSingle = vi.fn(async () => response);
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  commerceMocks.listCommerceManageableClientIds.mockResolvedValue([]);
  organizationMocks.loadOrganizationDirectory.mockResolvedValue({
    actor: {
      id: "00000000-0000-4000-8000-000000000001",
      technicalRole: "admin",
      businessRank: "owner",
      canEditGlobal: true,
      canReadCompensation: true
    },
    members: []
  });
});

describe("RFQ and client intent parameters", () => {
  it.each([
    ["cuantos RFQs nuevos tenemos", "new_count"],
    ["muestrame los RFQs sin asignar", "unassigned"],
    ["que RFQ llego mas recientemente", "latest"],
    ["cuantos RFQs tiene Maya", "employee"]
  ] as const)("parses RFQ mode for %s", (question, mode) => {
    expect(parseRfqInsightMode(question)).toBe(mode);
  });

  it.each([
    ["cuantos clientes tenemos", "count"],
    ["busca Amazon-demo", "search"],
    ["quien atiende Google-demo", "owner"],
    ["que RFQs tiene Microsoft-demo", "rfqs"],
    ["que cotizaciones tiene Amazon-demo", "quotes"]
  ] as const)("parses client mode for %s", (question, mode) => {
    expect(parseClientInsightMode(question)).toBe(mode);
  });
});

describe("authorized RFQ insights", () => {
  it("counts UI-new RFQs with an exact RLS query and exposes no contact or pricing fields", async () => {
    const rfqQuery = queryBuilder({
      data: [{
        external_rfq_id: "WEB-2026-0042",
        status: "unassigned",
        source: "quiksol-web",
        created_at: "2026-08-30T10:00:00.000Z",
        contact_snapshot: {
          companyOrName: "Amazon-demo",
          email: "private@example.com",
          phone: "+1-secret",
          notes: "private note"
        },
        client: null,
        seller: null,
        items: [{ id: "line", target_price: 999, supplier_cost: 1 }]
      }],
      error: null,
      count: 7
    });
    const supabase = { from: vi.fn(() => rfqQuery) };

    const output = await getRfqSummary(
      contextFor("admin", supabase),
      "cuantos RFQs nuevos tenemos"
    );

    expect(rfqQuery.in).toHaveBeenCalledWith("status", ["unassigned", "assigned"]);
    expect(rfqQuery.gte).toHaveBeenCalledWith("created_at", expect.stringMatching(/^\d{4}-/));
    expect(rfqQuery.select).toHaveBeenCalledWith("id", { count: "exact" });
    expect(output).toEqual(expect.objectContaining({
      tool: "rfq_summary",
      scope: "company",
      total: 7,
      empty: false,
      deterministic: true
    }));
    expect(output.data).toEqual(expect.objectContaining({ mode: "new_count", count: 7, rfqs: [] }));
    expect(JSON.stringify(output)).not.toMatch(/private@example|\+1-secret|private note|target_price|supplier_cost|999/);
  });

  it("returns zero rather than broadening scope when RLS hides unassigned RFQs", async () => {
    const rfqQuery = queryBuilder({ data: [], error: null, count: 0 });
    const supabase = { from: vi.fn(() => rfqQuery) };
    const output = await getRfqSummary(
      contextFor("employee", supabase),
      "muestrame los RFQs sin asignar"
    );

    expect(output.scope).toBe("own");
    expect(output.total).toBe(0);
    expect(output.empty).toBe(false);
    expect(rfqQuery.eq).toHaveBeenCalledWith("status", "unassigned");
  });
});

describe("authorized client insights", () => {
  it("counts only IDs from the canonical commerce scope", async () => {
    const ids = Array.from({ length: 19 }, (_, index) => `client-${index + 1}`);
    commerceMocks.listCommerceManageableClientIds.mockResolvedValueOnce(ids);
    const supabase = { from: vi.fn(), rpc: vi.fn() };
    const output = await getClientLookup(
      contextFor("employee", supabase),
      "cuantos clientes tenemos"
    );

    expect(commerceMocks.listCommerceManageableClientIds).toHaveBeenCalledWith(supabase);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(output.data).toEqual({ mode: "count", count: 19, clients: [] });
    expect(output.total).toBe(19);
    expect(output.scope).toBe("own");
  });

  it("searches names only inside canonical commerce-manageable IDs", async () => {
    commerceMocks.listCommerceManageableClientIds.mockResolvedValueOnce([
      "client-amazon",
      "client-google"
    ]);
    const clientsQuery = queryBuilder({
      data: [{ id: "client-amazon", name: "Amazon-demo" }],
      error: null
    });
    const supabase = { from: vi.fn(() => clientsQuery), rpc: vi.fn() };
    const output = await getClientLookup(
      contextFor("manager", supabase),
      "busca Amazon-demo"
    );

    expect(clientsQuery.in).toHaveBeenCalledWith("id", ["client-amazon", "client-google"]);
    expect(clientsQuery.ilike).toHaveBeenCalledWith("name", "amazon-demo");
    expect(output.data).toEqual({
      mode: "search",
      count: 1,
      clients: [{ name: "Amazon-demo", isDemoAccount: true }]
    });
    expect(JSON.stringify(output)).not.toMatch(/email|phone|notes/i);
  });

  it("checks commerce read authority before revealing an assigned seller", async () => {
    const searchQuery = queryBuilder({
      data: [{ id: "client-google", name: "Google-demo" }],
      error: null,
      count: 1
    });
    const ownerQuery = queryBuilder({
      data: { seller: { full_name: "Maya Torres", email: "hidden@demo.invalid" } },
      error: null
    });
    let clientCalls = 0;
    const supabase = {
      from: vi.fn((table: string) => {
        expect(table).toBe("clients");
        clientCalls += 1;
        return clientCalls === 1 ? searchQuery : ownerQuery;
      }),
      rpc: vi.fn(async () => ({ data: true, error: null }))
    };

    const output = await getClientLookup(
      contextFor("manager", supabase),
      "quien atiende Google-demo"
    );

    expect(supabase.rpc).toHaveBeenCalledWith("commerce_can_read_client_v2", {
      target_client_id: "client-google"
    });
    expect(output.data).toEqual({
      mode: "owner",
      client: { name: "Google-demo", isDemoAccount: true },
      assignedSellerName: "Maya Torres"
    });
    expect(JSON.stringify(output)).not.toContain("hidden@demo.invalid");
  });

  it("fails closed when a named client's commerce activity is outside scope", async () => {
    const searchQuery = queryBuilder({
      data: [{ id: "client-google", name: "Google-demo" }],
      error: null,
      count: 1
    });
    const supabase = {
      from: vi.fn(() => searchQuery),
      rpc: vi.fn(async () => ({ data: false, error: null }))
    };
    const output = await getClientLookup(
      contextFor("employee", supabase),
      "que RFQs tiene Google-demo"
    );

    expect(output).toEqual(expect.objectContaining({
      ok: false,
      empty: true,
      scope: "own",
      total: 0
    }));
    expect(JSON.stringify(output.data)).not.toContain("Google-demo");
  });
});
