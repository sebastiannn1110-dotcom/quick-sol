import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUSINESS_SUMMARY_PUBLISH_CHUNK_SIZE,
  buildBusinessMpnSummaryRows,
  buildBusinessOpportunityEntityRows,
  businessSummaryPublishChunks,
  loadCompleteUploadRecords,
  publishBusinessOpportunityEntityRows
} from "@/lib/performance/business-summaries";
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

  it("converts Excel serial dates before publishing PostgreSQL timestamps", () => {
    const records = [{
      id: "10000000-0000-4000-8000-000000000004",
      upload_batch_id: "upload",
      raw_data: { MPN: "ABC-2", QTY: 10, "Valid Until": 46228 },
      upload_batches: { detected_category: "supplier_offer" }
    }] as StockNeedsRecord[];
    const profiles = [{ upload_batch_id: "upload", detected_template: "supplier_offer" }];

    const [entity] = buildBusinessOpportunityEntityRows({ records, profiles });

    expect(entity).toMatchObject({
      entity_kind: "supplier_offer",
      expires_at: "2026-07-25T00:00:00.000Z"
    });
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
      upload_batch_id: "00000000-0000-4000-8000-000000000001",
      created_at: "2026-08-14T00:00:00.000Z"
    }));
    let offset = 0;
    const cursorIds: string[] = [];
    const query = {
      select() { return this; }, eq() { return this; }, is() { return this; }, order() { return this; },
      lt(column: string, value: string) { if (column === "id") cursorIds.push(value); return this; },
      async limit(value: number) {
        const data = source.slice(offset, offset + value);
        offset += value;
        return { data, error: null };
      }
    };
    const supabase = { from: () => query };
    const result = await loadCompleteUploadRecords(supabase as never, "00000000-0000-4000-8000-000000000001");
    expect(result).toHaveLength(count);
    expect(new Set(result.map((row) => row.id)).size).toBe(count);
    expect(cursorIds).toHaveLength(Math.floor(count / 1000));
  });

  it("ships the composite partial index required by large keyset rebuilds", () => {
    const migration = readFileSync(path.join(
      process.cwd(),
      "supabase/migrations/20260814130000_business_summary_keyset_index.sql"
    ), "utf8");

    expect(migration).toContain("business_records (upload_batch_id, created_at desc, id desc)");
    expect(migration).toContain("where archived_at is null");
    expect(migration).not.toMatch(/\b(drop|truncate|delete)\b/i);
  });

  it("ships the upload/id index used by the timeout-safe cursor", () => {
    const migration = readFileSync(path.join(
      process.cwd(),
      "supabase/migrations/20260814140000_business_summary_id_keyset_index.sql"
    ), "utf8");

    expect(migration).toContain("business_records (upload_batch_id, id desc)");
    expect(migration).toContain("where archived_at is null");
    expect(migration).not.toMatch(/\b(drop|truncate|delete)\b/i);
  });

  it("ships an authorized covering rollup for the opportunity summary", () => {
    const migration = readFileSync(path.join(
      process.cwd(),
      "supabase/migrations/20260814150000_opportunity_summary_rollup.sql"
    ), "utf8");

    expect(migration).toContain("business_mpn_summaries_rollup_idx");
    expect(migration).toContain("security definer");
    expect(migration).toContain("public.can_read_upload(upload.uploaded_by)");
    expect(migration).toContain("grant execute on function public.get_opportunity_summary_v1() to authenticated, service_role");
    expect(migration).not.toMatch(/\b(drop|truncate|delete)\b/i);
  });

  it("publishes large derived datasets in bounded chunks", () => {
    const rows = Array.from({ length: BUSINESS_SUMMARY_PUBLISH_CHUNK_SIZE * 2 + 1 }, (_, index) => index);
    const chunks = businessSummaryPublishChunks(rows);

    expect(chunks.map((chunk) => chunk.length)).toEqual([
      BUSINESS_SUMMARY_PUBLISH_CHUNK_SIZE,
      BUSINESS_SUMMARY_PUBLISH_CHUNK_SIZE,
      1
    ]);
    expect(chunks.flat()).toEqual(rows);
    expect(businessSummaryPublishChunks([])).toEqual([]);
  });

  it("publishes immutable opportunity entities in retry-safe chunks", async () => {
    const calls: Array<{ rows: unknown[]; options: Record<string, unknown> }> = [];
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const table = {
      async upsert(rows: unknown[], options: Record<string, unknown>) {
        calls.push({ rows, options });
        return { error: null };
      }
    };
    const supabase = {
      from: (name: string) => {
        expect(name).toBe("business_opportunity_entities");
        return table;
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return { error: null };
      }
    };
    const rows = Array.from({ length: BUSINESS_SUMMARY_PUBLISH_CHUNK_SIZE * 2 + 1 }, (_, index) => ({
      source_record_id: `record-${index}`,
      entity_kind: "demand" as const,
      entity_key: `record-${index}:demand`,
      normalized_mpn: `MPN-${index}`,
      display_mpn: `MPN-${index}`,
      manufacturer_name: null,
      customer_name: null,
      supplier_name: null,
      required_qty: 1,
      available_qty: null,
      excess_qty: null,
      required_date: null,
      unit_of_measure: null,
      lead_time_weeks: null,
      moq: null,
      spq: null,
      date_code: null,
      coo: null,
      condition: null,
      expires_at: null,
      is_active_demand: true,
      is_live_supply: true,
      warnings: [],
      upload_batch_id: "upload",
      owner_id: "owner",
      data_version: 1
    }));

    await publishBusinessOpportunityEntityRows(supabase as never, rows, "upload", 1);

    expect(calls.map((call) => call.rows.length)).toEqual([500, 500, 1]);
    expect(calls.every((call) => call.options.ignoreDuplicates === true)).toBe(true);
    expect(calls.every((call) => call.options.onConflict === "upload_batch_id,data_version,source_record_id,entity_kind")).toBe(true);
    expect(rpcCalls).toEqual([{
      name: "replace_business_upload_opportunity_entities_v1",
      args: {
        target_upload_batch_id: "upload",
        expected_data_version: 1,
        entity_rows: []
      }
    }]);
  });
});
