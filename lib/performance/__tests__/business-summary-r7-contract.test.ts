import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const migrationPath = "supabase/migrations/20260825120000_high_volume_persistence_and_summary_pipeline.sql";

describe("Ronda 7 high-volume summary and snapshot contracts", () => {
  it("ships one atomic migration with exactly two new summary staging tables", () => {
    const migration = source(migrationPath);
    const summaryTables = [...migration.matchAll(/create table public\.(business_summary_[a-z_]+)/g)]
      .map((match) => match[1]);

    expect(summaryTables).toEqual([
      "business_summary_mpn_stage",
      "business_summary_entity_stage"
    ]);
    expect(migration.trimEnd().endsWith("commit;")).toBe(true);
    expect(migration).toContain("begin;");
    expect(migration).toContain("business_upload_versions_rebuild_status_check");
  });

  it("uses one fenced, keyset, byte-bounded and atomic summary authority", () => {
    const migration = source(migrationPath);
    for (const rpc of [
      "claim_business_summary_rebuild_v2",
      "heartbeat_business_summary_rebuild_v2",
      "read_business_summary_source_chunk_v2",
      "stage_business_summary_chunk_v2",
      "publish_business_summary_rebuild_v2",
      "fail_business_summary_rebuild_v2",
      "get_business_summary_state_v2",
      "request_business_summary_rebuild_v2"
    ]) expect(migration).toContain(`function public.${rpc}`);

    expect(migration).toContain("for update of version skip locked");
    expect(migration).toContain("(record.created_at, record.id) < (input_after_created_at, input_after_id)");
    expect(migration).toContain("SUMMARY_SOURCE_ROW_TOO_LARGE");
    expect(migration).toContain("page_bytes + candidate_bytes > 4194304");
    expect(migration).toContain("input_payload_bytes > 8388608");
    expect(migration).toContain("SUMMARY_WORKER_FENCED");
    expect(migration).toContain("quiksol.summary_fail_after_replace");
    expect(migration).toContain("sum(stage.demand_qty order by stage.chunk_sequence, stage.source_ordinal)");
    expect(migration).not.toContain("stage.demand_qty::double precision");
    expect(migration.match(/coalesce\(max\(version\)::text, 'unknown'\)/g)).toHaveLength(4);
    expect(migration).toContain("SUMMARY_STOCK_NEEDS_UNIVERSE_REWRITE_FAILED");
    expect(migration).toContain("visible.data_version is null or visible.dirty is distinct from false");
    expect(migration).toContain("left join public.business_upload_versions version on version.upload_batch_id = upload.id");
    expect(migration).toMatch(/summary_version = locked_version\.rebuild_target_version,[\s\S]+opportunity_entity_version = locked_version\.rebuild_target_version,[\s\S]+dirty = false/);
    expect(migration).toContain("revoke execute on function public.claim_business_summary_rebuilds_v1");
    expect(migration).toContain("grant execute on function public.request_business_summary_rebuild_v2(uuid,uuid)\n  to authenticated");
    expect(migration).toContain("limit 100");
  });

  it("keeps chunked snapshot staging private until the atomic job pointer advances", () => {
    const migration = source(migrationPath);
    for (const rpc of [
      "begin_opportunity_finder_dataset_snapshot_v2",
      "read_opportunity_finder_snapshot_chunk_v2",
      "append_opportunity_finder_dataset_snapshot_rows_v2",
      "finalize_opportunity_finder_dataset_snapshot_v2"
    ]) expect(migration).toContain(`function public.${rpc}`);

    const begin = migration.split("function public.begin_opportunity_finder_dataset_snapshot_v2")[1]
      .split("function public.append_opportunity_finder_dataset_snapshot_rows_v2")[0];
    expect(begin).not.toContain("input_manifest");
    expect(begin).toContain("locked_job.dataset_manifest");
    expect(begin).toContain("nextChunkSequence', 0");
    expect(migration).toContain("row_count not between 0 and 1000");
    expect(migration).toContain("limit page_limit");
    expect(migration).toContain("SNAPSHOT_READ_CURSOR_INVALID");
    expect(migration).toContain("SNAPSHOT_TOTAL_ROW_LIMIT_EXCEEDED");
    expect(migration).toContain("SNAPSHOT_APPEND_DUPLICATE_MISMATCH");
    expect(migration).toContain("snapshot.build_status = 'ready'");
    expect(migration).toContain("job.dataset_snapshot_id = snapshot.id");
    expect(migration).toContain("job.snapshot_status = 'ready'");
    expect(migration).toContain("revoke execute on function public.persist_opportunity_finder_dataset_snapshot");

    const createRoute = source("app/api/opportunity-finder/jobs/route.ts");
    const snapshotRoute = source("app/api/opportunity-finder/jobs/[id]/snapshot/route.ts");
    expect(createRoute).toContain('rpc("get_opportunity_finder_dataset_locator_v2"');
    expect(createRoute).not.toContain("loadAuthorizedDatasetManifest");
    expect(snapshotRoute).toContain('rpc("read_opportunity_finder_snapshot_chunk_v2"');
    expect(snapshotRoute).toContain("SNAPSHOT_REQUEST_MAX_CHUNKS = 4");
    expect(snapshotRoute).toContain("SNAPSHOT_REQUEST_TIME_BUDGET_MS = 1_500");
    expect(snapshotRoute).toContain('strategy: "bounded_sql_page_v2"');
    expect(snapshotRoute).toContain("chunkRowsMax: SNAPSHOT_READ_MAX_ROWS");
    expect(snapshotRoute).toContain("chunkBytesMax: SNAPSHOT_READ_MAX_BYTES");
    expect(snapshotRoute).toContain("}, 202)");
    expect(snapshotRoute).not.toContain("loadAuthorizedDatasetManifest");
    expect(snapshotRoute).not.toContain("streamAuthorizedPlatformCandidatePages");
  });

  it("removes full-load and direct live-table publication from the worker", () => {
    const library = source("lib/performance/business-summaries.ts");
    const worker = source("scripts/business-summary-worker.ts");

    expect(library).not.toContain("loadCompleteUploadRecords");
    expect(library).not.toContain('.from("business_records")');
    expect(library).not.toContain('.from("business_mpn_summaries")');
    expect(library).not.toContain('.from("business_opportunity_entities")');
    expect(library).toContain('rpc("read_business_summary_source_chunk_v2"');
    expect(library).toContain('rpc("stage_business_summary_chunk_v2"');
    expect(library).toContain('rpc("publish_business_summary_rebuild_v2"');
    expect(worker).toContain('rpc("claim_business_summary_rebuild_v2"');
    expect(worker).toContain('rpc("fail_business_summary_rebuild_v2"');
    expect(worker).not.toContain("claim_business_summary_rebuilds_v1");
    expect(worker).not.toContain("release_business_summary_rebuild_v1");
  });
});
