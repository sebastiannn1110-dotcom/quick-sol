import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = "supabase/migrations/20260825120000_high_volume_persistence_and_summary_pipeline.sql";
const contractPath = "supabase/tests/database_safety_round7_watermark_contract.sql";
const runtimePath = "supabase/tests/database_safety_round7_watermark_runtime.sql";
const concurrencyPath = "supabase/tests/database_safety_round7_watermark_concurrency_runtime.sql";
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const migration = source(migrationPath).toLowerCase();

function functionBody(signature: string, nextSignature?: string) {
  const start = migration.indexOf(`create or replace function public.${signature}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = nextSignature
    ? migration.indexOf(`create or replace function public.${nextSignature}`, start + 1)
    : migration.length;
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("Ronda 7 non-blocking Database Safety watermark", () => {
  it("replaces the singleton hot row with two bounded monotonic sequences", () => {
    expect(migration).toContain("create sequence public.database_safety_data_version_seq");
    expect(migration).toContain("create sequence public.database_safety_storage_version_seq");
    expect(migration.match(/cache 1/g)?.length).toBeGreaterThanOrEqual(2);
    expect(migration.match(/no cycle/g)?.length).toBeGreaterThanOrEqual(2);
    expect(migration).toMatch(/setval\(\s*'public\.database_safety_data_version_seq'/);
    expect(migration).toMatch(/setval\(\s*'public\.database_safety_storage_version_seq'/);
  });

  it("uses one shared/exclusive transaction fence without serializing writers", () => {
    const businessTrigger = functionBody(
      "touch_database_safety_watermark()",
      "touch_database_safety_storage_watermark_v2()"
    );
    const storageTrigger = functionBody(
      "touch_database_safety_storage_watermark_v2()",
      "database_safety_current_snapshot_v2("
    );
    const begin = functionBody(
      "begin_database_backup_manifest_v2(",
      "verify_database_backup_manifest_v2("
    );
    const capture = functionBody(
      "database_safety_capture_watermarks_v3()",
      "touch_database_safety_watermark()"
    );

    expect(businessTrigger).toContain("pg_advisory_xact_lock_shared");
    expect(storageTrigger).toContain("pg_advisory_xact_lock_shared");
    expect(businessTrigger).toContain("nextval('public.database_safety_data_version_seq'");
    expect(storageTrigger).toContain("nextval('public.database_safety_storage_version_seq'");
    expect(businessTrigger).not.toContain("update public.database_safety_state");
    expect(storageTrigger).not.toContain("update public.database_safety_state");
    expect(begin).toContain("database_safety_capture_watermarks_v3()");
    expect(capture).toContain("pg_advisory_xact_lock");
    expect(capture).not.toContain("pg_advisory_xact_lock_shared");
  });

  it("preserves v2 RPC signatures while reading the authoritative sequence versions", () => {
    for (const signaturePrefix of [
      "database_safety_current_snapshot_v2(",
      "database_safety_dry_run_v2(",
      "begin_database_backup_manifest_v2(",
      "verify_database_backup_manifest_v2(",
      "arm_database_destruction_v2(",
      "execute_database_business_purge_v2("
    ]) expect(migration).toContain(`create or replace function public.${signaturePrefix}`);
    expect(migration).toContain("database_safety_current_watermarks_v3()");
    expect(migration).toContain("database_safety_capture_watermarks_v3()");
    expect(migration).toContain("delete_kill_switch_disabled");
    expect(migration).toContain("backup_stale");
  });

  it("keeps trigger and sequence primitives backend-internal", () => {
    for (const sequence of ["database_safety_data_version_seq", "database_safety_storage_version_seq"]) {
      expect(migration).toContain(`revoke all on sequence public.${sequence} from public,anon,authenticated,service_role`);
    }
    for (const signature of [
      "database_safety_watermark_lock_key_v3()",
      "database_safety_current_watermarks_v3()",
      "database_safety_capture_watermarks_v3()",
      "touch_database_safety_watermark()",
      "touch_database_safety_storage_watermark_v2()"
    ]) expect(migration).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role`);
  });

  it("ships guarded SQL coverage and a real two-session AFTER regression", () => {
    const contract = source(contractPath).toLowerCase();
    const runtime = source(runtimePath).toLowerCase();
    const concurrency = source(concurrencyPath).toLowerCase();
    expect(contract).toContain("refusing_non_round7_watermark_test_database");
    expect(contract).toContain("database_safety_catalog_preflight_v2");
    expect(runtime).toContain("business_write_did_not_stale_backup");
    expect(runtime).toContain("rolled_back_write_did_not_advance_watermark");
    expect(runtime).toContain("preserved_write_staled_backup");
    expect(runtime).toContain("storage_write_did_not_stale_backup");
    expect(concurrency.match(/dblink_send_query/g)).toHaveLength(2);
    expect(concurrency).toContain("round7_unrelated_write_blocked");
    expect(concurrency).toContain("pg_blocking_pids");
  });
});
