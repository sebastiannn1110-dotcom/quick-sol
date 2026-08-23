import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATABASE_DESTRUCTION_PHRASE,
  DATABASE_SAFETY_DELETE_TABLES,
  DATABASE_SAFETY_PROTECTED_TABLES,
  DATABASE_SAFETY_TABLE_POLICY
} from "@/lib/superadmin/database-safety-policy";

const baseMigrationPath = "supabase/migrations/20260816120000_super_admin_database_safety_center.sql";
const migrationPath = "supabase/migrations/20260822140000_harden_database_safety_backend_evidence.sql";
const roundFourMigrationPath = "supabase/migrations/20260823120000_harden_import_job_pipeline.sql";
const baseMigration = readFileSync(path.join(process.cwd(), baseMigrationPath), "utf8");
const migration = readFileSync(path.join(process.cwd(), migrationPath), "utf8");
const roundFourMigration = readFileSync(path.join(process.cwd(), roundFourMigrationPath), "utf8");
const normalized = migration.toLowerCase();

const historicalPublicTables = [
  "admin_email_attachments", "admin_email_messages", "ai_conversations", "ai_messages", "api_rate_limits",
  "audit_logs", "business_mpn_summaries", "business_opportunity_entities", "business_records", "business_scope_counters",
  "business_upload_versions", "chat_attachments", "chat_conversation_members", "chat_conversations", "chat_messages",
  "client_logs", "client_private_details", "client_upload_assignments", "clients", "email_alert_rules",
  "email_notification_events", "file_schema_profiles", "import_errors", "import_job_error_summary", "import_job_errors",
  "import_job_staging_rows", "import_jobs", "observability_log_outbox", "opportunity_finder_allocations", "opportunity_finder_audit_events",
  "opportunity_finder_dataset_snapshot_rows", "opportunity_finder_dataset_snapshots", "opportunity_finder_demand_events",
  "opportunity_finder_demand_part_options", "opportunity_finder_files", "opportunity_finder_historical_signals",
  "opportunity_finder_jobs", "opportunity_finder_manufacturer_aliases", "opportunity_finder_manufacturer_registry_versions",
  "opportunity_finder_manufacturers", "opportunity_finder_output_items", "opportunity_finder_output_runs",
  "opportunity_finder_part_equivalence_versions", "opportunity_finder_part_equivalences", "opportunity_finder_possible_matches",
  "opportunity_finder_rejected_rows", "opportunity_finder_result_commercials", "opportunity_finder_result_financials",
  "opportunity_finder_results", "opportunity_finder_review_decisions", "opportunity_finder_rows",
  "opportunity_finder_supply_lots", "opportunity_finder_tenant_memberships", "opportunity_finder_tenants",
  "password_reset_codes", "performance_logs", "profiles", "security_events", "system_logs", "upload_batches", "upload_sheets",
  "worker_runtime_heartbeats"
].sort();

const newSafetyTables = [
  "database_backup_manifests", "database_destruction_operations", "database_safety_audit_events", "database_safety_state"
].sort();

describe("Database Safety Center policy", () => {
  it("covers the exact 62 existing public tables and four protected safety tables", () => {
    const publicTables = DATABASE_SAFETY_TABLE_POLICY.filter((entry) => entry.schema === "public").map((entry) => entry.table);
    expect([...new Set(publicTables)].sort()).toEqual([...historicalPublicTables, ...newSafetyTables].sort());
    expect(publicTables).toHaveLength(66);
  });

  it("derives the 62-table baseline from the actual local migration corpus", () => {
    const migrationsDirectory = path.join(process.cwd(), "supabase/migrations");
    const corpus = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql") && ![path.basename(migrationPath), path.basename(baseMigrationPath)].includes(name))
      .map((name) => readFileSync(path.join(migrationsDirectory, name), "utf8"))
      .join("\n");
    const discovered = [...corpus.matchAll(/create table(?: if not exists)? public\.([a-z0-9_]+)/gi)]
      .map((match) => match[1]);
    expect([...new Set(discovered)].sort()).toEqual(historicalPublicTables);
  });

  it("keeps the TypeScript and SQL catalogs synchronized", () => {
    const sqlTables = [...baseMigration.matchAll(/\('([^']+)','([^']+)','[^']+','(?:DELETE|PRESERVE)'/g)]
      .map((match) => `${match[1]}.${match[2]}`);
    const roundFourTables = [...roundFourMigration.matchAll(/select '([^']+)','([^']+)','[^']+','(?:DELETE|PRESERVE)'/g)]
      .map((match) => `${match[1]}.${match[2]}`);
    const policyTables = DATABASE_SAFETY_TABLE_POLICY.map((entry) => `${entry.schema}.${entry.table}`);
    expect([...new Set([...sqlTables, ...roundFourTables])].sort()).toEqual([...policyTables].sort());
  });

  it("uses an explicit 45-table DELETE allowlist and preserves identity, security and observability", () => {
    expect(DATABASE_SAFETY_DELETE_TABLES).toHaveLength(45);
    expect(DATABASE_SAFETY_DELETE_TABLES.map((entry) => `${entry.schema}.${entry.table}`)).toContain(
      "public.import_job_staging_rows"
    );
    expect(DATABASE_SAFETY_PROTECTED_TABLES.map((entry) => `${entry.schema}.${entry.table}`)).toEqual(expect.arrayContaining([
      "public.profiles", "auth.users", "supabase_migrations.schema_migrations", "storage.objects", "storage.buckets",
      "public.database_safety_audit_events", "public.audit_logs", "public.security_events",
      "public.system_logs", "public.client_logs", "public.performance_logs", "public.api_rate_limits",
      "public.worker_runtime_heartbeats"
    ]));
  });

  it("orders representative FK children before their parents", () => {
    const order = new Map(DATABASE_SAFETY_DELETE_TABLES.map((entry, index) => [entry.table, index]));
    const edges = [
      ["admin_email_attachments", "admin_email_messages"], ["ai_messages", "ai_conversations"],
      ["chat_attachments", "chat_messages"], ["chat_messages", "chat_conversations"],
      ["business_records", "upload_sheets"], ["upload_sheets", "upload_batches"],
      ["import_job_errors", "import_jobs"], ["opportunity_finder_output_items", "opportunity_finder_output_runs"],
      ["opportunity_finder_result_financials", "opportunity_finder_results"],
      ["opportunity_finder_dataset_snapshot_rows", "opportunity_finder_dataset_snapshots"],
      ["opportunity_finder_rows", "opportunity_finder_files"], ["opportunity_finder_files", "opportunity_finder_jobs"]
    ];
    for (const [child, parent] of edges) expect(order.get(child)!).toBeLessThan(order.get(parent)!);
  });

  it("implements purge as one transactional, idempotent, single-use operation", () => {
    const execute = normalized.slice(normalized.indexOf("create or replace function public.execute_database_business_purge_v2"));
    expect(normalized.startsWith("begin;")).toBe(true);
    expect(normalized.trimEnd().endsWith("commit;")).toBe(true);
    expect(execute).toContain("if operation.status in ('database_completed','completed') then");
    expect(execute).toContain("operation.challenge_hash<>input_challenge_hash");
    expect(execute).toContain("operation.session_binding_hash<>input_session_binding_hash");
    expect(execute).toContain("challenge_used_at is not null");
    expect(execute).toContain("for update");
    expect(execute).toContain("lock table %i.%i in share row exclusive mode");
    expect(execute).toContain("order by schema_name, table_name");
    expect(execute).toContain("delete from %i.%i");
    expect(execute).not.toContain("drop database");
    expect(execute).not.toContain("drop schema");
    expect(execute).not.toContain("truncate table");
  });

  it("keeps the real two-session concurrency regression executable only on its named disposable database", () => {
    const concurrency = readFileSync(path.join(process.cwd(), "supabase/tests/database_safety_round3_concurrency_runtime.sql"), "utf8");
    expect(concurrency).toContain("current_database() <> 'quiksol_round3_concurrency_test'");
    expect(concurrency.match(/dblink_send_query/g)).toHaveLength(2);
    expect(concurrency.indexOf("dblink_send_query('round3_concurrent_b'")).toBeLessThan(concurrency.indexOf("dblink_get_result('round3_concurrent_a'"));
    expect(concurrency).toContain("count(distinct payload)");
    expect(concurrency).toContain("CONCURRENT_AUDIT_NOT_SINGLE");
  });

  it("blocks missing, corrupt, stale, expired and reused backup/challenge states in SQL", () => {
    for (const marker of ["BACKUP_NOT_VERIFIED", "BACKUP_STALE", "BACKEND_EVIDENCE_INVALID", "CHALLENGE_EXPIRED", "CHALLENGE_ALREADY_USED", "COUNTDOWN_ACTIVE", "SESSION_CHANGED", "REAUTH_EXPIRED", "CATALOG_UNCLASSIFIED", "DELETE_KILL_SWITCH_DISABLED"]) {
      expect(migration).toContain(marker);
    }
    expect(migration).toContain("restore_list_verified");
    expect(migration).toContain("downloaded_at is null");
    expect(migration).toContain("manifest.expires_at <= clock_timestamp()");
  });

  it("stales every DELETE table while preserving rate-limit and observability writes", () => {
    expect(migration).toContain("if item.planned_action = 'DELETE'");
    expect(migration).toContain("'api_rate_limits','observability_log_outbox'");
    expect(migration).toContain("then 'PRESERVE'");
  });

  it("enforces RLS without granting direct writes", () => {
    for (const table of newSafetyTables) expect(baseMigration.toLowerCase()).toContain(`alter table public.${table} force row level security`);
    expect(normalized).toContain("revoke all on public.database_backup_manifests from authenticated");
    expect(normalized).toContain("grant select, insert, update on public.database_backup_manifests to service_role");
    expect(normalized).toContain("revoke all on function public.execute_database_business_purge_v2(uuid,uuid,text,text) from public,anon,authenticated");
    expect(normalized).toContain("grant execute on function public.execute_database_business_purge_v2(uuid,uuid,text,text) to service_role");
    expect(normalized).not.toContain("grant insert on public.database_");
    expect(normalized).not.toContain("grant update on public.database_");
    expect(normalized).not.toContain("grant delete on public.database_");
  });

  it("keeps tenant authorization tables protected and uses the exact phrase", () => {
    expect(DATABASE_SAFETY_PROTECTED_TABLES.map((entry) => entry.table)).toEqual(expect.arrayContaining([
      "opportunity_finder_tenants", "opportunity_finder_tenant_memberships"
    ]));
    expect(DATABASE_DESTRUCTION_PHRASE).toBe("ELIMINAR INFORMACION QUIKSOL");
  });

  it("keeps provisioning dry by default and accepts secrets only through private env variables", () => {
    const provisioning = readFileSync(path.join(process.cwd(), "scripts/provision-admin-users.ts"), "utf8");
    expect(provisioning).toContain("QUIKSOL_ADMIN_PROVISIONING_PASSWORD");
    expect(provisioning).toContain("QUIKSOL_ADMIN_ROTATION_PASSWORD");
    expect(provisioning).toContain("--apply");
    expect(provisioning).toContain("--target-email=");
    expect(provisioning).toContain("--project-ref=");
    expect(provisioning).toContain("--rotate-password");
    expect(provisioning).toContain('role: "super_admin_dev"');
    expect(provisioning).not.toContain("NEXT_PUBLIC_QUIKSOL_ADMIN_PROVISIONING_PASSWORD");
  });
});
