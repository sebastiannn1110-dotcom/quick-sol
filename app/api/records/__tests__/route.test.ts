import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { UserRole } from "@/lib/types";

const IDS = {
  row: "00000000-0000-4000-8000-000000000101",
  user: "00000000-0000-4000-8000-000000000102",
  batch: "00000000-0000-4000-8000-000000000103"
};

function loggerMock() {
  return {
    debug: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    fatal: vi.fn(async () => undefined),
    security: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined)
  };
}

function queryBuilder(result: { data: unknown[]; error: null; count: number | null }) {
  const builder: Record<string, ReturnType<typeof vi.fn>> & PromiseLike<typeof result> = {
    select: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    or: vi.fn(),
    eq: vi.fn(),
    ilike: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve) => Promise.resolve(result).then(resolve))
  };
  for (const method of ["select", "is", "order", "or", "eq", "ilike", "gte", "lte", "limit"] as const) {
    builder[method].mockReturnValue(builder);
  }
  return builder;
}

function safeRow() {
  return {
    id: IDS.row,
    upload_batch_id: IDS.batch,
    uploaded_by: IDS.user,
    category: "stock",
    created_at: "2026-08-24T00:00:00.000Z",
    archived_at: null,
    mpn: "SAFE-MPN",
    qty: 5,
    profiles: { full_name: "Safe User", department: "Sales", region: "Global", role: "employee" },
    upload_batches: { original_file_name: "safe.xlsx", status: "completed" }
  };
}

function commercialRow() {
  return {
    ...safeRow(),
    client: "Allowed client",
    customer: "Allowed customer",
    supplier: "Allowed supplier",
    supplier_name: "Allowed supplier",
    manufacturer: "Allowed manufacturer",
    po: "PRIVATE-PO",
    cost: 10,
    price: 20,
    total_price: 100,
    gp_rate: 0.5,
    gp: 50,
    commission: 2,
    comments: "PRIVATE-NOTE"
  };
}

describe("GET /api/records role and privacy contract", () => {
  const getAuthContext = vi.fn();
  const logger = loggerMock();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/logger/performance", () => ({
      measureAsync: vi.fn(async (_operation, _module, _context, fn) => fn())
    }));
  });

  async function invokeAs(role: UserRole) {
    const row = role === "employee" ? safeRow() : commercialRow();
    const builder = queryBuilder({ data: [row], error: null, count: null });
    const from = vi.fn(() => builder);
    const rpc = vi.fn(async () => ({ data: [{ record_count: 1 }], error: null }));
    getAuthContext.mockResolvedValue({
      user: { id: IDS.user },
      profile: {
        id: IDS.user,
        email: "redacted@example.test",
        full_name: "Test User",
        role,
        department: "Sales",
        region: "Global",
        is_active: true,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      },
      supabase: { from, rpc },
      isDemoMode: false,
      requestMeta: {
        traceId: "00000000-0000-4000-8000-000000000104",
        requestId: "00000000-0000-4000-8000-000000000105",
        route: "/api/records",
        ipAddress: "192.0.2.30",
        userAgent: "test"
      }
    });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://quick-sol.onrender.com/api/records?pageSize=25"));
    return { response, body: await response.json(), builder, from };
  }

  for (const role of ["super_admin_dev", "admin", "manager", "employee"] as const) {
    it(`returns 200 for ${role} using its allowlisted view`, async () => {
      const { response, body, builder, from } = await invokeAs(role);
      expect(response.status).toBe(200);
      expect(body.records).toHaveLength(1);
      expect(from).toHaveBeenCalledWith(
        role === "employee" ? "business_records_safe_v1" : "business_records_commercial_v1"
      );
      const select = String(builder.select.mock.calls[0]?.[0] ?? "");
      const selectedFields = new Set(select.split(","));
      for (const forbiddenField of ["raw_data", "normalized_data", "searchable_text", "errors"]) {
        expect(selectedFields.has(forbiddenField), forbiddenField).toBe(false);
      }
    });
  }

  it("keeps employee output free of commercial and financial fields", async () => {
    const { body } = await invokeAs("employee");
    expect(body.records[0]).not.toHaveProperty("raw_data");
    expect(body.records[0]).not.toHaveProperty("supplier");
    expect(body.records[0]).not.toHaveProperty("customer");
    expect(body.records[0]).not.toHaveProperty("cost");
    expect(body.records[0]).not.toHaveProperty("price");
    expect(body.records[0]).not.toHaveProperty("gp");
  });

  it("redacts manager finance, purchase order and internal notes while retaining permitted parties", async () => {
    const { body } = await invokeAs("manager");
    const row = body.records[0];
    expect(row.supplier).toBe("Allowed supplier");
    expect(row.customer).toBe("Allowed customer");
    for (const field of ["cost", "price", "total_price", "gp_rate", "gp", "commission", "po", "comments"]) {
      expect(row[field]).not.toBe(commercialRow()[field as keyof ReturnType<typeof commercialRow>]);
    }
    expect(row).not.toHaveProperty("raw_data");
  });

  it("returns 401 to anonymous requests before querying a record source", async () => {
    getAuthContext.mockResolvedValueOnce(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    const { GET } = await import("../route");
    const response = await GET(new Request("https://quick-sol.onrender.com/api/records?pageSize=25"));
    expect(response.status).toBe(401);
  });
});
