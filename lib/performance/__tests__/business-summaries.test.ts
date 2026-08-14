import { describe, expect, it } from "vitest";
import { buildBusinessMpnSummaryRows, buildBusinessOpportunityEntityRows, loadCompleteUploadRecords } from "@/lib/performance/business-summaries";
import { buildSalesOpportunitiesResult } from "@/lib/opportunities/opportunities";
import { buildStockNeedsResult, type StockNeedsRecord } from "@/lib/stock-needs/stock-needs";

function fixture() {
  const records: StockNeedsRecord[] = [
    { upload_batch_id: "stock", raw_data: { MPN: "ABC-1", "STOCK QTY": 10, MFG: "Maker" }, upload_batches: { detected_category: "Inventory" } },
    { upload_batch_id: "demand", raw_data: { Item: "ABC-1", "Required Qty": 4, Customer: "Buyer" }, upload_batches: { detected_category: "pricing" } },
    { upload_batch_id: "demand", raw_data: { Item: "NEED-2", "Required Qty": 7, Customer: "Buyer" }, upload_batches: { detected_category: "pricing" } }
  ];
  const profiles = [
    { upload_batch_id: "stock", detected_template: "inventario" },
    { upload_batch_id: "demand", detected_template: "pricing" }
  ];
  return { records, profiles };
}

describe("versioned business summaries", () => {
  it("preserves exact canonical quantities used by stock and opportunities", () => {
    const input = fixture();
    const rows = buildBusinessMpnSummaryRows(input);
    const abc = rows.find((row) => row.normalized_mpn === "ABC-1");
    const stock = buildStockNeedsResult({ ...input, includeAllItems: true });
    const opportunities = buildSalesOpportunitiesResult(input);
    expect(abc).toMatchObject({
      demand_qty: 4,
      stock_qty: 10,
      stock_required_qty: stock.items.find((item) => item.mpn === "ABC-1")?.requiredQty,
      stock_available_qty: stock.items.find((item) => item.mpn === "ABC-1")?.stockQty
    });
    expect(opportunities.items.find((item) => item.mpn === "ABC-1")).toMatchObject({
      requiredQty: abc?.demand_qty,
      availableQty: abc?.stock_qty,
      opportunityType: "immediate_sale"
    });
  });

  it("materializes each source record as a separate versioned demand or supply entity", () => {
    const records = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        upload_batch_id: "upload",
        raw_data: { MPN: "ABC-1", "Required Qty": 7, "Required Date": "2099-01-01", UOM: "EA", Customer: "A" },
        upload_batches: { detected_category: "pricing" }
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        upload_batch_id: "upload",
        raw_data: { MPN: "ABC-1", "Required Qty": 5, "Required Date": "2099-02-01", UOM: "EA", Customer: "B" },
        upload_batches: { detected_category: "pricing" }
      },
      {
        id: "10000000-0000-4000-8000-000000000003",
        upload_batch_id: "upload",
        raw_data: { MPN: "ABC-1", "STOCK QTY": 10, UOM: "EA" },
        upload_batches: { detected_category: "Inventory" }
      }
    ] as StockNeedsRecord[];
    const entities = buildBusinessOpportunityEntityRows({ records });
    expect(entities.filter((row) => row.entity_kind === "demand")).toHaveLength(2);
    expect(entities.filter((row) => row.entity_kind === "stock")).toHaveLength(1);
    expect(entities.map((row) => row.entity_key)).toHaveLength(new Set(entities.map((row) => row.entity_key)).size);
  });

  it("keeps canonical first-value metadata when records arrive newest first", () => {
    const records = [
      {
        id: "10000000-0000-4000-8000-000000000002",
        upload_batch_id: "upload",
        raw_data: { MPN: "ABC-1", "Required Qty": 5, Customer: "Newest customer", MFG: "Newest maker" },
        upload_batches: { detected_category: "pricing" }
      },
      {
        id: "10000000-0000-4000-8000-000000000001",
        upload_batch_id: "upload",
        raw_data: { MPN: "ABC-1", "Required Qty": 7, Customer: "Older customer", MFG: "Older maker" },
        upload_batches: { detected_category: "pricing" }
      }
    ] as StockNeedsRecord[];

    const [summary] = buildBusinessMpnSummaryRows({ records });
    const canonical = buildSalesOpportunitiesResult({ records }).items[0];

    expect(summary.customer_name).toBe(canonical.customerNeedName);
    expect(summary.manufacturer_name).toBe(canonical.manufacturerName);
    expect(summary.manufacturer_names).toEqual(["Newest maker", "Older maker"]);
  });

  it.each([999, 1000, 1001, 5000, 10000])("loads all %i rows across PostgREST page boundaries", async (count) => {
    const source = Array.from({ length: count }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      upload_batch_id: "00000000-0000-4000-8000-000000000001"
    }));
    const query = {
      select() { return this; }, eq() { return this; }, is() { return this; }, order() { return this; },
      async range(from: number, to: number) { return { data: source.slice(from, to + 1), error: null }; }
    };
    const supabase = { from: () => query };
    const result = await loadCompleteUploadRecords(supabase as never, "00000000-0000-4000-8000-000000000001");
    expect(result).toHaveLength(count);
    expect(new Set(result.map((row) => row.id)).size).toBe(count);
  });
});
