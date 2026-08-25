import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { hydrateUserScopedOpportunityAllocations } from "@/lib/opportunity-finder/api";
import type { OpportunityAllocationTrace } from "@/lib/opportunity-finder/types";

const JOB_ID = "00000000-0000-4000-8000-000000000003";
const RESULT_ID = "00000000-0000-4000-8000-000000000004";

function allocationRow(index: number) {
  return {
    id: `00000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
    result_id: RESULT_ID,
    demand_part_option_id: "00000000-0000-4000-8000-000000000005",
    supply_lot_id: `00000000-0000-4000-8002-${String(index + 1).padStart(12, "0")}`,
    supply_lot_key: `synthetic-lot-${String(index).padStart(4, "0")}`,
    allocated_qty: "1",
    reserved_qty: "1",
    available_before: String(2_000 - index),
    remaining_qty: String(1_999 - index),
    deterministic_rank: index,
    supply_trace: {
      fileId: "00000000-0000-4000-8000-000000000012",
      fileName: "synthetic-supply.xlsx",
      sheetName: "Supply",
      sourceRow: index + 2,
      hidden: false,
      headerRow: 1,
      columns: { mpn: "A" },
      originalIndex: index
    }
  };
}

function allocationClient(rows: Record<string, unknown>[]) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.eq = vi.fn(() => query);
  query.in = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.range = vi.fn(async (from: number, to: number) => ({
    data: rows.slice(from, to + 1),
    error: null
  }));
  const select = vi.fn(() => query);
  const from = vi.fn((table: string) => {
    if (table !== "opportunity_finder_allocations") {
      throw new Error(`Unexpected table ${table}`);
    }
    return { select };
  });
  return {
    supabase: { from } as unknown as SupabaseClient,
    from,
    query
  };
}

describe("user-scoped Opportunity Finder allocation hydration", () => {
  it("does not query normalized allocations below the capped-preview threshold", async () => {
    const database = allocationClient([]);
    const preview = Array.from({ length: 31 }, (_, index) => ({ lotKey: `preview-${index}` }));
    const row = { id: RESULT_ID, allocations_trace: preview };

    const hydrated = await hydrateUserScopedOpportunityAllocations(
      database.supabase,
      JOB_ID,
      [row]
    );

    expect(hydrated.error).toBeNull();
    expect(hydrated.rows).toEqual([row]);
    expect(database.from).not.toHaveBeenCalled();
  });

  it("loads every normalized allocation in deterministic paginated order at 32 previews", async () => {
    const normalizedRows = Array.from({ length: 1_001 }, (_, index) => allocationRow(index));
    const database = allocationClient(normalizedRows);
    const preview = Array.from({ length: 32 }, (_, index) => ({ lotKey: `preview-${index}` }));

    const hydrated = await hydrateUserScopedOpportunityAllocations(
      database.supabase,
      JOB_ID,
      [{ id: RESULT_ID, allocations_trace: preview }]
    );
    const allocations = hydrated.rows[0].allocations_trace as OpportunityAllocationTrace[];

    expect(hydrated.error).toBeNull();
    expect(allocations).toHaveLength(1_001);
    expect(allocations[0]).toMatchObject({
      lotKey: "synthetic-lot-0000",
      allocatedQty: 1,
      reservedQty: 1,
      availableBefore: 2_000,
      remainingQty: 1_999
    });
    expect(allocations.at(-1)).toMatchObject({
      lotKey: "synthetic-lot-1000",
      availableBefore: 1_000,
      remainingQty: 999
    });
    expect(database.query.eq).toHaveBeenCalledWith("job_id", JOB_ID);
    expect(database.query.in).toHaveBeenCalledWith("result_id", [RESULT_ID]);
    expect(database.query.order).toHaveBeenCalledWith("result_id", { ascending: true });
    expect(database.query.order).toHaveBeenCalledWith("deterministic_rank", { ascending: true });
    expect(database.query.order).toHaveBeenCalledWith("id", { ascending: true });
    expect(database.query.range).toHaveBeenNthCalledWith(1, 0, 999);
    expect(database.query.range).toHaveBeenNthCalledWith(2, 1000, 1999);
  });

  it("preserves a legacy preview when normalized rows are unavailable", async () => {
    const database = allocationClient([]);
    const preview = Array.from({ length: 32 }, (_, index) => ({ lotKey: `preview-${index}` }));

    const hydrated = await hydrateUserScopedOpportunityAllocations(
      database.supabase,
      JOB_ID,
      [{ id: RESULT_ID, allocations_trace: preview }]
    );

    expect(hydrated.error).toBeNull();
    expect(hydrated.rows[0].allocations_trace).toEqual(preview);
    expect(database.query.range).toHaveBeenCalledTimes(1);
  });
});
