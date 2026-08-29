import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const r74MigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260826160000_stock_needs_snapshot_r74.sql"
);
const r741MigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260827020000_stock_needs_snapshot_chunk_index_r741.sql"
);

const r74Migration = readFileSync(r74MigrationPath, "utf8");
const r741Migration = readFileSync(r741MigrationPath, "utf8");
// Git stores migrations with LF. Windows may materialize an otherwise clean
// checkout with CRLF when core.autocrlf predates the repository attributes.
// Hash the Git-canonical text so the immutability gate remains cross-platform.
const canonicalR74Migration = r74Migration.replace(/\r\n/g, "\n");
const normalizedR741 = r741Migration.replace(/\s+/g, " ").trim().toLowerCase();

describe("R7.4.1 Stock Needs snapshot chunk index contract", () => {
  it("keeps the applied R7.4 migration Git-canonical bytes unchanged", () => {
    expect(createHash("sha256").update(canonicalR74Migration).digest("hex")).toBe(
      "2411dc162c2f6b60ac68c4b6e67276d7a5ab77b23fe5f95edb88063c10b77ef6"
    );
  });

  it("adds exactly the definitive ordered stage index in a transactional migration", () => {
    expect(normalizedR741).toBe(
      "begin; create index if not exists business_stock_needs_snapshot_chunk_idx " +
        "on public.business_stock_needs_snapshot_rows " +
        "(data_scope_id, generation, chunk_sequence, normalized_mpn); commit;"
    );
    expect(normalizedR741).not.toContain("concurrently");
    expect(normalizedR741).not.toContain("_diag_");
    expect(normalizedR741).not.toMatch(/\b(drop|alter|delete|update|truncate)\b/);
  });

  it("does not remove or redefine any prior snapshot index", () => {
    for (const indexName of [
      "business_stock_needs_scopes_claim_idx",
      "business_stock_needs_snapshot_default_page_idx",
      "business_stock_needs_snapshot_mpn_trgm_idx",
      "business_stock_needs_snapshot_customer_trgm_idx",
      "business_stock_needs_snapshot_supplier_trgm_idx",
      "business_stock_needs_snapshot_manufacturer_trgm_idx",
      "business_stock_needs_snapshot_statuses_idx",
      "business_stock_needs_snapshot_sources_page_idx"
    ]) {
      expect(r74Migration).toContain(`create index ${indexName}`);
      expect(r741Migration).not.toContain(indexName);
    }
  });

  it("keeps the stage predicate, deterministic ordering and bounded chunk contract", () => {
    expect(r74Migration).toContain("where row_data.data_scope_id = input_scope_id");
    expect(r74Migration).toContain("and row_data.generation = input_generation");
    expect(r74Migration).toContain("and row_data.chunk_sequence = input_chunk_sequence");
    expect(r74Migration).toContain("order by summary.normalized_mpn");
    expect(r74Migration).toContain("limit chunk_limit");
    expect(r74Migration).toContain("input_chunk_sequence <> locked_scope.build_last_chunk_sequence + 1");
  });

  it("keeps service-role fencing, resume/retry and atomic publish contracts intact", () => {
    for (const contract of [
      "claim_stock_needs_snapshot_rebuild_v1",
      "heartbeat_stock_needs_snapshot_rebuild_v1",
      "stage_stock_needs_snapshot_chunk_v1",
      "publish_stock_needs_snapshot_rebuild_v1",
      "fail_stock_needs_snapshot_rebuild_v1",
      "STOCK_SNAPSHOT_SERVICE_ROLE_REQUIRED",
      "STOCK_SNAPSHOT_WORKER_FENCED",
      "build_last_chunk_sequence + 1",
      "build_fence_token = scope.build_fence_token + 1",
      "last_published_build_id = input_rebuild_id",
      "active_generation = input_generation"
    ]) {
      expect(r74Migration).toContain(contract);
    }
  });

  it("keeps privacy, RLS, retention and Database Safety classifications intact", () => {
    for (const table of [
      "business_stock_needs_scopes",
      "business_stock_needs_snapshot_rows",
      "business_stock_needs_snapshot_sources"
    ]) {
      expect(r74Migration).toContain(`alter table public.${table} force row level security`);
      expect(r74Migration).toContain(
        `revoke all on table public.${table} from public, anon, authenticated, service_role`
      );
    }
    expect(r74Migration).toContain("cleanup_stock_needs_snapshot_generations_v1");
    expect(r74Migration).toContain("retained_generations");
    expect(r74Migration).toContain(
      "'business_stock_needs_snapshot_rows','BUSINESS_DATA','DELETE'"
    );
    expect(r74Migration).toContain(
      "'business_stock_needs_snapshot_sources','BUSINESS_DATA','DELETE'"
    );
    expect(r741Migration).not.toMatch(/\b(grant|revoke|policy|security definer)\b/i);
  });
});
