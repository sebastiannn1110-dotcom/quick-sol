import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUSINESS_SUMMARY_SOURCE_CHUNK_SIZE,
  buildBusinessMpnSummaryRows,
  buildBusinessOpportunityEntityRows,
  rebuildBusinessUploadSummary
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

  it("uses one claim evaluation time across supplier-offer chunks", () => {
    const makeRecord = (id: string) => ({
      id,
      upload_batch_id: "upload",
      raw_data: {
        MPN: id,
        QTY: 10,
        "Valid Until": "2030-01-01T00:00:00.000Z"
      },
      upload_batches: { detected_category: "supplier_offer" }
    }) as StockNeedsRecord;
    const profiles = [{ upload_batch_id: "upload", detected_template: "supplier_offer" }];
    const evaluationAt = "2029-12-31T23:59:59.000Z";

    const firstChunk = buildBusinessOpportunityEntityRows({
      records: [makeRecord("10000000-0000-4000-8000-000000000011")],
      profiles,
      evaluationAt
    });
    const laterChunk = buildBusinessOpportunityEntityRows({
      records: [makeRecord("10000000-0000-4000-8000-000000000012")],
      profiles,
      evaluationAt
    });
    const afterExpiry = buildBusinessOpportunityEntityRows({
      records: [makeRecord("10000000-0000-4000-8000-000000000013")],
      profiles,
      evaluationAt: "2030-01-01T00:00:01.000Z"
    });

    expect(firstChunk[0]?.is_live_supply).toBe(true);
    expect(laterChunk[0]?.is_live_supply).toBe(true);
    expect(afterExpiry[0]?.is_live_supply).toBe(false);
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

  it("ships a role-scoped page-first rollup for Stock Needs", () => {
    const migration = readFileSync(path.join(
      process.cwd(),
      "supabase/migrations/20260822130000_optimize_stock_needs_summary_fast_path.sql"
    ), "utf8");

    expect(migration).toContain("business_mpn_summaries_stock_rollup_idx");
    expect(migration).toContain("security definer");
    expect(migration).toContain("public.can_read_upload(upload.uploaded_by)");
    expect(migration).toContain("visible_uploads as materialized");
    expect(migration).toContain("page as materialized");
    expect(migration.indexOf("page_sources as")).toBeGreaterThan(migration.indexOf("page as materialized"));
    expect(migration).toContain("from page\n  join public.business_mpn_summaries");
    expect(migration).toContain("to authenticated, service_role");
    expect(migration).not.toMatch(/\b(drop|truncate|delete)\b/i);
  });

  it("streams keyset pages through fenced staging and one atomic publish", async () => {
    const uploadId = "00000000-0000-4000-8000-000000000010";
    const claim = {
      upload_batch_id: uploadId,
      target_data_version: 7,
      rebuild_id: "00000000-0000-4000-8000-000000000020",
      rebuild_generation: 3,
      fence_token: 9,
      lease_expires_at: "2099-01-01T00:00:00.000Z",
      evaluation_at: "2026-08-24T00:00:00.000Z"
    };
    const sourceRows = [0, 1, 2].map((index) => ({
      record_id: `00000000-0000-4000-8000-${String(index + 30).padStart(12, "0")}`,
      record_created_at: `2026-08-24T00:00:0${2 - index}.000Z`,
      record_payload: {
        upload_batch_id: uploadId,
        raw_data: { MPN: `MPN-${index}`, "Required Qty": index + 1, Customer: "Buyer" }
      }
    }));
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let readIndex = 0;
    const thenable = (result: unknown) => ({
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      limit() { return Promise.resolve(result); },
      single() { return Promise.resolve(result); },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(result).then(resolve); }
    });
    const supabase = {
      from(name: string) {
        if (name === "upload_batches") return thenable({
          data: { id: uploadId, detected_category: "pricing", status: "completed" }, error: null
        });
        if (name === "file_schema_profiles") return thenable({ data: [], error: null });
        if (name === "import_jobs") return thenable({ data: [], error: null });
        throw new Error(`unexpected table ${name}`);
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        if (name === "read_business_summary_source_chunk_v2") {
          const pages = [sourceRows.slice(0, 2), sourceRows.slice(2), []];
          return { data: pages[readIndex++] ?? [], error: null };
        }
        if (name === "heartbeat_business_summary_rebuild_v2") {
          return { data: "2099-01-01T00:00:00.000Z", error: null };
        }
        if (name === "stage_business_summary_chunk_v2") {
          return { data: { accepted: true }, error: null };
        }
        if (name === "publish_business_summary_rebuild_v2") {
          return { data: { status: "ready", version: 7 }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      }
    };

    const result = await rebuildBusinessUploadSummary(supabase as never, claim, "worker-1", {
      chunkSize: 2,
      leaseSeconds: 60
    });

    expect(result).toMatchObject({
      sourceRecords: 3,
      chunks: 2,
      peakChunkRows: 2,
      version: 7
    });
    expect(BUSINESS_SUMMARY_SOURCE_CHUNK_SIZE).toBe(500);
    const reads = rpcCalls.filter((call) => call.name === "read_business_summary_source_chunk_v2");
    expect(reads).toHaveLength(3);
    expect(reads[1].args).toMatchObject({
      input_after_created_at: sourceRows[1].record_created_at,
      input_after_id: sourceRows[1].record_id
    });
    const stages = rpcCalls.filter((call) => call.name === "stage_business_summary_chunk_v2");
    expect(stages.map((call) => call.args.input_source_rows)).toEqual([2, 1]);
    expect(stages.map((call) => call.args.input_chunk_sequence)).toEqual([0, 1]);
    expect(rpcCalls.filter((call) => call.name === "publish_business_summary_rebuild_v2")).toHaveLength(1);
    expect(rpcCalls.some((call) => call.name.includes("_v1"))).toBe(false);
  });
});
