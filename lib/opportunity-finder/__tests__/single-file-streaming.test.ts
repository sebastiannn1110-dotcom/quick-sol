import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  opportunitySnapshotChunkFingerprint,
  splitOpportunitySnapshotRows,
  streamAuthorizedPlatformCandidatePages,
  streamOpportunityFinderUploadedMpnChunks,
  streamPlatformSnapshotChunks,
  type OpportunityPlatformEntityRow,
  type OpportunitySnapshotCandidateRow
} from "@/lib/opportunity-finder/single-file";
import { BUSINESS_OPPORTUNITY_ENTITIES_SAFE_VIEW } from "@/lib/security/business-records";

function platformRow(index: number): OpportunityPlatformEntityRow {
  return {
    upload_batch_id: "00000000-0000-4000-8000-000000000010",
    owner_id: "00000000-0000-4000-8000-000000000001",
    data_version: 7,
    source_record_id: `record-${String(index).padStart(6, "0")}`,
    entity_kind: "stock",
    entity_key: `entity-${index}`,
    normalized_mpn: `MPN-${index}`,
    display_mpn: `MPN-${index}`,
    customer_name: null,
    supplier_name: "Safe supplier",
    manufacturer_name: "Safe manufacturer",
    required_qty: null,
    available_qty: 1,
    excess_qty: null,
    required_date: null,
    lead_time_weeks: null,
    moq: null,
    spq: null,
    date_code: null,
    coo: null,
    condition: null,
    expires_at: null,
    unit_of_measure: null,
    is_active_demand: true,
    is_live_supply: true,
    warnings: []
  };
}

describe("single-file snapshot streaming", () => {
  it("packs pages into bounded 1000-row chunks without accumulating the result set", async () => {
    async function* pages() {
      yield Array.from({ length: 1000 }, (_, index) => platformRow(index));
      yield Array.from({ length: 1000 }, (_, index) => platformRow(index + 1000));
      yield Array.from({ length: 501 }, (_, index) => platformRow(index + 2000));
    }

    const chunks = [];
    for await (const chunk of streamPlatformSnapshotChunks({ uploadedRole: "demand", candidatePages: pages() })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.rows.length)).toEqual([1000, 1000, 501]);
    expect(chunks.every((chunk) => chunk.payloadBytes <= 8 * 1024 * 1024)).toBe(true);
    expect(chunks.every((chunk) => /^[0-9a-f]{64}$/.test(chunk.chunkFingerprint))).toBe(true);
  });

  it("also enforces the byte boundary and produces stable SHA-256 chunk fingerprints", () => {
    const base = {
      role: "stock",
      source_upload_id: "00000000-0000-4000-8000-000000000010",
      source_data_version: 7,
      normalized_mpn: "MPN",
      display_mpn: "MPN",
      manufacturer: null,
      customer_context: null,
      supplier_context: "x".repeat(300),
      required_qty: null,
      available_qty: 1,
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
      quality_flags: []
    } satisfies Omit<OpportunitySnapshotCandidateRow, "source_key">;
    const rows = Array.from({ length: 8 }, (_, index) => ({ ...base, source_key: `source-${index}` }));
    const chunks = splitOpportunitySnapshotRows(rows, 1000, 1500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.payloadBytes <= 1500)).toBe(true);
    expect(opportunitySnapshotChunkFingerprint(rows)).toBe(opportunitySnapshotChunkFingerprint([...rows]));
    expect(opportunitySnapshotChunkFingerprint(rows)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pages the DISTINCT ordered MPN RPC and deduplicates only an overlapping boundary", async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({ normalized_mpn: `MPN-${String(index).padStart(4, "0")}` }));
    const second = [{ normalized_mpn: "MPN-0999" }, { normalized_mpn: "MPN-1000" }];
    const range = vi.fn(async (from: number) => ({ data: from === 0 ? first : second, error: null }));
    const rpc = vi.fn(() => ({ range }));
    const chunks: string[][] = [];
    for await (const chunk of streamOpportunityFinderUploadedMpnChunks({ rpc } as unknown as SupabaseClient, "job")) {
      chunks.push([...chunk]);
    }

    const mpns = chunks.flat();
    expect(mpns).toHaveLength(1001);
    expect(new Set(mpns).size).toBe(1001);
    expect(range).toHaveBeenNthCalledWith(1, 0, 999);
    expect(range).toHaveBeenNthCalledWith(2, 1000, 1999);
    expect(rpc).toHaveBeenCalledWith("get_opportunity_finder_uploaded_mpns", { job_id: "job" });
  });

  it("uses only the R5 safe view with bounded keyset pages", async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, index) => platformRow(index)),
      [platformRow(1000)]
    ];
    let pageIndex = 0;
    const or = vi.fn();
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit"]) {
      query[method] = vi.fn(() => query);
    }
    query.or = vi.fn((filter: string) => {
      or(filter);
      return query;
    });
    query.then = (resolve: (value: unknown) => void) => resolve({ data: pages[pageIndex++], error: null });
    const from = vi.fn(() => query);
    const output = [];
    for await (const page of streamAuthorizedPlatformCandidatePages({
      supabase: { from } as unknown as SupabaseClient,
      manifest: [{
        uploadBatchId: "00000000-0000-4000-8000-000000000010",
        ownerId: "00000000-0000-4000-8000-000000000001",
        dataVersion: 7
      }],
      normalizedMpnChunks: [["MPN"]]
    })) output.push(page);

    expect(output.map((page) => page.length)).toEqual([1000, 1]);
    expect(from).toHaveBeenCalledTimes(2);
    expect(from).toHaveBeenCalledWith(BUSINESS_OPPORTUNITY_ENTITIES_SAFE_VIEW);
    expect(String((query.select as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).not.toMatch(/raw_data|normalized_data/);
    expect(or).toHaveBeenCalledTimes(1);
  });
});
