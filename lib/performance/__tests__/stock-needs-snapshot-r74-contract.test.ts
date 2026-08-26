import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupStockNeedsSnapshotGenerations,
  rebuildStockNeedsSnapshot
} from "@/lib/performance/business-summaries";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260826160000_stock_needs_snapshot_r74.sql"
);

describe("R7.4 Stock Needs snapshot contract", () => {
  it("keeps v1 and exposes a separate fail-closed snapshot contract", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain("create or replace function public.get_stock_needs_snapshot_state_v1");
    expect(migration).toContain("create or replace function public.get_stock_needs_snapshot_page_v1");
    expect(migration).not.toContain("create or replace function public.get_stock_needs_page_v1");
    expect(migration).not.toContain("drop function public.get_stock_needs_page_v1");
    expect(migration).not.toContain("raw_data");
    expect(migration).not.toContain("normalized_data");
  });

  it("keeps all snapshot tables private with FORCE RLS", () => {
    const migration = readFileSync(migrationPath, "utf8");
    for (const table of [
      "business_stock_needs_scopes",
      "business_stock_needs_snapshot_rows",
      "business_stock_needs_snapshot_sources"
    ]) {
      expect(migration).toContain(`alter table public.${table} force row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from public, anon, authenticated, service_role`);
    }
    expect(migration).not.toContain("grant select on table public.business_stock_needs");
  });

  it("uses bounded chunks, leases, fencing and atomic publish", () => {
    const migration = readFileSync(migrationPath, "utf8");
    for (const contract of [
      "claim_stock_needs_snapshot_rebuild_v1",
      "heartbeat_stock_needs_snapshot_rebuild_v1",
      "stage_stock_needs_snapshot_chunk_v1",
      "publish_stock_needs_snapshot_rebuild_v1",
      "fail_stock_needs_snapshot_rebuild_v1",
      "build_cursor_mpn",
      "build_fence_token",
      "build_lease_expires_at",
      "active_generation",
      "retained_generations",
      "cleanup_stock_needs_snapshot_generations_v1"
    ]) expect(migration).toContain(contract);
    expect(migration).toContain("limit chunk_limit");
    expect(migration).toContain("source_rank <= 5");
  });

  it("drives a complete snapshot through bounded RPC calls", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: "lease", error: null })
      .mockResolvedValueOnce({
        data: { done: false, chunkSequence: 0, chunkRows: 2, chunkSources: 3, chunkBytes: 800 },
        error: null
      })
      .mockResolvedValueOnce({ data: "lease", error: null })
      .mockResolvedValueOnce({ data: { done: true, chunkSequence: 1 }, error: null })
      .mockResolvedValueOnce({ data: "lease", error: null })
      .mockResolvedValueOnce({ data: { status: "ready", generation: 4, rows: 2, sources: 3 }, error: null });

    const result = await rebuildStockNeedsSnapshot(
      { rpc } as never,
      {
        scope_id: "scope",
        rebuild_id: "rebuild",
        build_generation: 4,
        fence_token: 9,
        lease_expires_at: new Date().toISOString(),
        evaluation_at: new Date().toISOString(),
        next_chunk_sequence: 0
      },
      "worker",
      { chunkSize: 1000, leaseSeconds: 120 }
    );

    expect(result).toMatchObject({ rebuilt: true, chunksThisRun: 1, rowsThisRun: 2, sourcesThisRun: 3 });
    expect(rpc).toHaveBeenCalledWith("stage_stock_needs_snapshot_chunk_v1", expect.objectContaining({
      input_chunk_sequence: 0,
      input_limit: 1000
    }));
    expect(rpc).toHaveBeenLastCalledWith("publish_stock_needs_snapshot_rebuild_v1", expect.any(Object));
  });

  it("cleans only a bounded stale-generation batch through the existing worker", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { rowsDeleted: 1000, done: false, batchLimit: 1000 },
      error: null
    });
    await expect(cleanupStockNeedsSnapshotGenerations({ rpc } as never, 1000)).resolves.toEqual({
      rowsDeleted: 1000,
      done: false,
      batchLimit: 1000
    });
    expect(rpc).toHaveBeenCalledWith("cleanup_stock_needs_snapshot_generations_v1", {
      input_batch_limit: 1000
    });
    const worker = readFileSync(path.join(process.cwd(), "scripts/business-summary-worker.ts"), "utf8");
    expect(worker).toContain("cleanupStockNeedsSnapshotGenerations(supabase, 1000)");
  });
});
