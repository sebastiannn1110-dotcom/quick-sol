import { describe, expect, it, vi } from "vitest";
import { getCommerceRfq } from "@/lib/commerce/service";
import {
  ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS,
  ELECTRONIC_PARTS_DEMO_OWNER_EMAIL,
  ELECTRONIC_PARTS_DEMO_SEED_MARKER
} from "@/lib/demo/employee-scope";
import type { Profile } from "@/lib/types";

function queryResult<T>(data: T) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    maybeSingle: vi.fn(),
    then: (resolve: (value: { data: T; error: null }) => unknown) => Promise.resolve({ data, error: null }).then(resolve)
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data, error: null });
  return query;
}

describe("commerce demo seller scope", () => {
  it("limits the RFQ seller selector to the canonical 19 people", async () => {
    const retained = ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS.map((email, index) => ({
      id: `retained-${index}`,
      full_name: `Retained ${index}`,
      email,
      role: "employee",
      bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER,
      is_active: true
    }));
    const historical = Array.from({ length: 107 }, (_, index) => ({
      id: `historical-${index}`,
      full_name: `Historical ${index}`,
      email: `historical-${index}@example.com`,
      role: "employee",
      bio: null,
      is_active: true
    }));
    const owner = {
      id: "owner",
      full_name: "user.test.demo.com",
      email: ELECTRONIC_PARTS_DEMO_OWNER_EMAIL,
      role: "admin",
      bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER,
      is_active: true
    };
    const sellers = [...retained, ...historical, owner];
    expect(sellers).toHaveLength(127);

    const rfq = {
      id: "rfq-1",
      external_rfq_id: "DEMO-RFQ-1",
      client_id: "client-1",
      status: "assigned",
      source: "internal",
      contact_snapshot: {},
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      client: { id: "client-1", name: "Amazon-demo" },
      seller: null,
      items: [],
      quotes: []
    };
    const supabase = {
      from: vi.fn((table: string) => table === "commerce_rfqs" ? queryResult(rfq) : queryResult(sellers)),
      rpc: vi.fn(async (name: string) => ({
        data: name === "list_commerce_assignable_sellers_v2" ? sellers : [],
        error: null
      }))
    };
    const actor = {
      id: "admin",
      full_name: "Admin",
      email: "admin@example.com",
      role: "admin",
      department: "Executive",
      region: "Global",
      is_active: true,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z"
    } as Profile;

    const result = await getCommerceRfq(supabase as never, actor, "rfq-1");

    expect(result?.assignableSellers).toHaveLength(19);
    expect(result?.assignableSellers.map((seller) => seller.email)).toEqual(ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS);
    expect(JSON.stringify(result?.assignableSellers)).not.toMatch(/user\.test\.demo\.com|historical/i);
  });
});
