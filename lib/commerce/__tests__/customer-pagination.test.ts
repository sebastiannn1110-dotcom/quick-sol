import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { commerceCustomerSchema } from "@/lib/commerce/contracts";
import {
  createCommerceCustomer,
  getCommerceCustomer,
  listCommerceCustomers,
  updateCommerceCustomer
} from "@/lib/commerce/service";
import type { Profile } from "@/lib/types";

const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  role: "employee"
} as Profile;

function customerRow(id: string, name: string) {
  return {
    id,
    name,
    external_customer_id: null,
    assigned_salesperson_id: profile.id,
    created_at: "2026-08-30T00:00:00.000Z",
    created_by: profile.id,
    details: [{
      contact_name: `${name} Contact`,
      contact_email: `${id}@example.invalid`,
      preferred_language: "en"
    }]
  };
}

function customerSupabase(initialRows: Array<ReturnType<typeof customerRow>>) {
  const rows = new Map(initialRows.map((row) => [row.id, row]));
  const manageableIds = initialRows.map((row) => row.id);
  const ranges: Array<[number, number]> = [];
  const chunks: string[][] = [];

  const rpc = vi.fn((name: string, args?: Record<string, unknown>) => {
    if (name === "list_commerce_manageable_client_ids_v2") {
      return {
        range: vi.fn(async (from: number, to: number) => {
          ranges.push([from, to]);
          return {
            data: manageableIds.slice(from, to + 1).map((clientId) => ({ client_id: clientId })),
            error: null
          };
        })
      };
    }
    if (name === "create_commerce_customer_v1") {
      const id = "created-client";
      const input = args?.input_details as { companyOrName: string };
      rows.set(id, customerRow(id, input.companyOrName));
      manageableIds.push(id);
      return Promise.resolve({ data: id, error: null });
    }
    if (name === "update_commerce_customer_v1") {
      const id = String(args?.input_client_id);
      const input = args?.input_details as { companyOrName: string };
      rows.set(id, customerRow(id, input.companyOrName));
      return Promise.resolve({ data: id, error: null });
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const from = vi.fn((table: string) => {
    expect(table).toBe("clients");
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      is: vi.fn(() => builder),
      order: vi.fn(() => builder),
      in: vi.fn(async (_column: string, ids: string[]) => {
        chunks.push(ids);
        return { data: ids.flatMap((id) => rows.get(id) ?? []), error: null };
      })
    };
    return builder;
  });

  return {
    supabase: { rpc, from } as unknown as SupabaseClient,
    rpc,
    from,
    ranges,
    chunks
  };
}

describe("Commerce customer scoped pagination", () => {
  it("loads more than 500 manageable clients before applying search", async () => {
    const rows = Array.from({ length: 505 }, (_, index) => customerRow(
      `client-${String(index + 1).padStart(4, "0")}`,
      index === 504 ? "ZZZ Needle Outside Old Window" : `AAA Client ${String(index + 1).padStart(4, "0")}`
    ));
    const test = customerSupabase(rows);

    const customers = await listCommerceCustomers(test.supabase, profile);
    const search = await listCommerceCustomers(test.supabase, profile, "needle");

    expect(customers).toHaveLength(505);
    expect(customers.at(-1)?.companyOrName).toBe("ZZZ Needle Outside Old Window");
    expect(search.map((customer) => customer.companyOrName)).toEqual(["ZZZ Needle Outside Old Window"]);
    expect(test.ranges).toContainEqual([0, 499]);
    expect(test.ranges).toContainEqual([500, 999]);
    expect(test.chunks.some((chunk) => chunk.includes("client-0505"))).toBe(true);
    expect(Math.max(...test.chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(100);
  });

  it("avoids an empty IN query when no client is manageable", async () => {
    const test = customerSupabase([]);
    await expect(listCommerceCustomers(test.supabase, profile)).resolves.toEqual([]);
    expect(test.from).not.toHaveBeenCalled();
    expect(test.chunks).toEqual([]);
  });

  it("loads an exact manageable client outside the former 500-row window", async () => {
    const rows = Array.from({ length: 505 }, (_, index) => customerRow(
      `client-${String(index + 1).padStart(4, "0")}`,
      `Client ${String(index + 1).padStart(4, "0")}`
    ));
    const test = customerSupabase(rows);

    const customer = await getCommerceCustomer(test.supabase, profile, "client-0505");

    expect(customer?.id).toBe("client-0505");
    expect(test.chunks).toEqual([["client-0505"]]);
  });

  it("returns customers after create and update without a global-row cutoff", async () => {
    const test = customerSupabase([customerRow("existing-client", "Before")]);
    const createdInput = commerceCustomerSchema.parse({
      companyOrName: "Created Client",
      contact: "Created Contact",
      email: "created@example.invalid"
    });
    const updatedInput = commerceCustomerSchema.parse({
      companyOrName: "After",
      contact: "Updated Contact",
      email: "updated@example.invalid"
    });

    const created = await createCommerceCustomer(test.supabase, profile, createdInput);
    const updated = await updateCommerceCustomer(
      test.supabase,
      profile,
      "existing-client",
      updatedInput
    );

    expect(created?.companyOrName).toBe("Created Client");
    expect(updated?.companyOrName).toBe("After");
    expect(test.rpc).toHaveBeenCalledWith("create_commerce_customer_v1", { input_details: createdInput });
    expect(test.rpc).toHaveBeenCalledWith("update_commerce_customer_v1", {
      input_client_id: "existing-client",
      input_details: updatedInput
    });
  });
});
