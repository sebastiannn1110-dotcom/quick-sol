import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath =
  "supabase/migrations/20260827200000_user_provisioning_idempotency_reconciliation_r84.sql";
const apiPath = "app/api/admin/users/route.ts";
const uiPath = "app/admin/users/page.tsx";
const cliPath = "scripts/provision-admin-users.ts";
const reconciliationCliPath = "scripts/reconcile-user-provisioning.ts";
const runtimePath = "supabase/tests/user_provisioning_r84_runtime.sql";
const concurrencyPath = "supabase/tests/user_provisioning_r84_concurrency_runtime.sql";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function withoutComments(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .replace(/\/\/.*$/gm, "");
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routine(sql: string, qualifiedName: string) {
  const match = sql.match(
    new RegExp(
      `create\\s+or\\s+replace\\s+function\\s+${escaped(qualifiedName)}\\s*\\([\\s\\S]*?\\bas\\s+\\$\\$[\\s\\S]*?\\$\\$\\s*;`,
      "i"
    )
  );
  expect(match, `missing SQL routine ${qualifiedName}`).not.toBeNull();
  return match![0];
}

function productionTypeScriptFiles(root: string): string[] {
  const absoluteRoot = path.join(process.cwd(), root);
  const files: string[] = [];
  for (const entry of readdirSync(absoluteRoot)) {
    if (entry === "__tests__") continue;
    const absolute = path.join(absoluteRoot, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...productionTypeScriptFiles(path.relative(process.cwd(), absolute)));
    } else if (/\.(?:ts|tsx)$/.test(entry)) {
      files.push(absolute);
    }
  }
  return files;
}

const migration = source(migrationPath);
const api = source(apiPath);
const ui = source(uiPath);
const cli = source(cliPath);
const reconciliationCli = source(reconciliationCliPath);

describe("R8.4 idempotent provisioning and reconciliation contract", () => {
  it("adds nullable legacy-compatible idempotency evidence without a new table", () => {
    expect(migration).toMatch(
      /alter\s+table\s+public\.user_provisioning_intents[\s\S]*?add\s+column\s+idempotency_key\s+uuid/i
    );
    expect(migration).toMatch(/add\s+column\s+request_fingerprint\s+bytea/i);
    expect(migration).toMatch(/add\s+column\s+fingerprint_version\s+smallint/i);
    expect(migration).toMatch(
      /idempotency_key\s+is\s+null[\s\S]*?request_fingerprint\s+is\s+null[\s\S]*?fingerprint_version\s+is\s+null/i
    );
    expect(migration).toMatch(
      /idempotency_key\s+is\s+not\s+null[\s\S]*?request_fingerprint\s+is\s+not\s+null[\s\S]*?fingerprint_version\s+is\s+not\s+null/i
    );
    expect(migration).toMatch(
      /create\s+unique\s+index\s+user_provisioning_intents_idempotency_uidx[\s\S]*?where\s+idempotency_key\s+is\s+not\s+null/i
    );
    expect(migration).toMatch(/profiles_provisioning_email_hash_idx/i);
    expect(migration).not.toMatch(/auth_users_provisioning_email_hash_idx/i);
    expect(migration).not.toMatch(/auth_users_provisioning_user_intent_locator_idx/i);
    expect(migration).not.toMatch(/auth_users_provisioning_app_intent_locator_idx/i);
    expect(withoutComments(migration)).not.toMatch(/create\s+table/i);
  });

  it("fingerprints only normalized canonical non-secret fields", () => {
    const fingerprint = withoutComments(
      routine(migration, "public.user_provisioning_request_fingerprint_v1")
    );
    for (const field of [
      "email",
      "fullName",
      "role",
      "department",
      "region",
      "isActive",
      "bio",
      "jobTitle"
    ]) {
      expect(fingerprint).toContain(`'${field}'`);
    }
    expect(fingerprint).toMatch(/quiksol:user-provisioning:v1/i);
    expect(fingerprint).toMatch(/extensions\.digest[\s\S]*?'sha256'/i);
    expect(fingerprint).not.toMatch(/\b(?:password|token|secret|credential)\b/i);
  });

  it("serializes key and email decisions inside one DB begin operation", () => {
    const begin = withoutComments(
      routine(migration, "public.begin_user_provisioning_internal_v2")
    );
    const keyLock = begin.indexOf("quiksol:user-provisioning:key:");
    const keyLookup = begin.search(/where\s+intent\.idempotency_key\s*=\s*input_idempotency_key/i);
    const emailLock = begin.indexOf("quiksol:user-provisioning:email:");
    const insert = begin.search(/insert\s+into\s+public\.user_provisioning_intents/i);

    expect(keyLock).toBeGreaterThan(-1);
    expect(keyLookup).toBeGreaterThan(keyLock);
    expect(emailLock).toBeGreaterThan(keyLookup);
    expect(insert).toBeGreaterThan(emailLock);
    expect(begin).toContain("'QS841'");
    expect(begin).toContain("'QS842'");
    expect(begin).toContain("'QS843'");
    expect(begin).toMatch(/EXISTING_PENDING/);
    expect(begin).toMatch(/EXISTING_COMPLETED/);
  });

  it("keeps source wrappers isolated and all helpers closed", () => {
    expect(migration).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.begin_user_provisioning_v2\([^;]+\)\s+to\s+authenticated/i
    );
    expect(migration).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.begin_cli_user_provisioning_v2\([^;]+\)\s+to\s+service_role/i
    );
    expect(migration).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.begin_(?:cli_)?user_provisioning_v2\([^;]+\)\s+to\s+[^;]*\banon\b/i
    );
    expect(routine(migration, "public.begin_user_provisioning_internal_v2")).toMatch(
      /auth\.role\s*\(\s*\)\s+is\s+distinct\s+from\s+'service_role'/i
    );
    expect(migration).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.classify_user_provisioning_intent_v1\(uuid\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/i
    );
  });

  it("writes one DB-side lifecycle audit and never reads app metadata for creation", () => {
    const trigger = withoutComments(routine(migration, "public.handle_new_user"));
    const completion = trigger.search(
      /update\s+public\.user_provisioning_intents[\s\S]*?status\s*=\s*'completed'/i
    );
    const audit = trigger.search(/insert\s+into\s+public\.audit_logs/i);

    expect(trigger).toMatch(/new\.raw_user_meta_data\s*->>\s*'quiksol_provisioning_intent_id'/i);
    expect(trigger).not.toMatch(/new\.raw_app_meta_data\s*->>\s*'quiksol_provisioning_intent_id'/i);
    expect(audit).toBeGreaterThan(completion);
    expect(trigger).toContain("'user_provisioning_completed'");
    expect(migration).toMatch(/audit_logs_user_provisioning_completed_uidx/i);
  });

  it("classifies both historical locator channels and only reconciles exact matches", () => {
    const classifier = withoutComments(
      routine(migration, "public.classify_user_provisioning_intent_v1")
    );
    const reconcile = withoutComments(
      routine(migration, "public.reconcile_user_provisioning_intent_v1")
    );
    for (const required of [
      "COMPLETED_CONSISTENT",
      "PENDING_NO_AUTH",
      "PENDING_AUTH_PROFILE_MATCH",
      "PENDING_AUTH_NO_PROFILE",
      "PENDING_AUTH_PROFILE_MISMATCH",
      "COMPLETED_AUTH_MISSING",
      "COMPLETED_PROFILE_MISSING",
      "AMBIGUOUS"
    ]) {
      expect(classifier).toContain(`'${required}'`);
    }
    expect(classifier).toMatch(/raw_user_meta_data/i);
    expect(classifier).toMatch(/raw_app_meta_data/i);
    expect(classifier).toMatch(/user_locator[\s\S]*?not\s+app_locator/i);
    expect(classifier).toMatch(/app_locator[\s\S]*?not\s+user_locator/i);
    expect(reconcile).toMatch(/for\s+update/i);
    expect(reconcile).toMatch(/from\s+auth\.users[\s\S]*?for\s+share/i);
    expect(reconcile).toMatch(/classification\s*<>\s*'PENDING_AUTH_PROFILE_MATCH'/i);
    expect(reconcile).toContain("'QS846'");
    expect(reconcile).toContain("'user_provisioning_reconciled'");
  });

  it("exposes technical preview and orphan diagnosis without a repair RPC", () => {
    const reconciliationPreview = withoutComments(
      routine(migration, "public.preview_user_provisioning_reconciliation_v1")
    );
    const orphanPreview = withoutComments(
      routine(migration, "public.preview_auth_profile_orphans_v1")
    );
    expect(orphanPreview).toContain("'HISTORICAL_AUTH_NO_PROFILE_NO_INTENT'");
    expect(orphanPreview).not.toMatch(/select[\s\S]*?auth_user\.email/i);
    expect(reconciliationPreview).toMatch(/if\s+target_intent_id\s+is\s+not\s+null/i);
    expect(reconciliationPreview).not.toMatch(/target_intent_id\s+is\s+null\s+or/i);
    expect(migration).not.toMatch(/repair_(?:historical_)?auth/i);
    expect(reconciliationCli).toMatch(/mode:\s*"preview"/i);
    expect(reconciliationCli).toMatch(/mode:\s*"orphans"/i);
    expect(reconciliationCli).toMatch(/reconcile_user_provisioning_intent_v1/i);
  });

  it("makes web and CLI retries reuse DB begin with no Profile bypass", () => {
    const post = withoutComments(
      api.slice(api.indexOf("export async function POST"), api.indexOf("export async function PATCH"))
    );
    expect(post).toMatch(/headers\.get\(\s*"Idempotency-Key"\s*\)/i);
    expect(post.match(/begin_user_provisioning_v2/g)?.length).toBe(1);
    expect(post).toMatch(/const\s+recovery\s*=\s*await\s+beginProvisioning/i);
    expect(post).toMatch(/provisioningRetryableResponse/i);
    expect(post).not.toMatch(/logAuditEvent/i);
    expect(post).not.toMatch(/\.from\(\s*["']profiles["']\s*\)[\s\S]*?\.(?:insert|upsert)/i);

    expect(ui).toMatch(/crypto\.randomUUID\s*\(\s*\)/i);
    expect(ui).toMatch(/createOperationKeyRef/i);
    expect(ui).toMatch(/submitLockRef\.current/i);
    expect(ui).toMatch(/["']Idempotency-Key["']/i);
    expect(ui).not.toMatch(/(?:localStorage|sessionStorage)/i);

    expect(cli).toMatch(/begin_cli_user_provisioning_v2/i);
    expect(cli).not.toMatch(/create_cli_user_provisioning_intent_v1/i);
    expect(cli).not.toMatch(/\.from\(\s*["']profiles["']\s*\)\.upsert/i);
  });

  it("keeps exactly the two authorized production createUser callers", () => {
    const files = [
      ...productionTypeScriptFiles("app"),
      ...productionTypeScriptFiles("scripts")
    ];
    const callers = files.filter((file) =>
      /(?:auth\.admin|service\.auth\.admin)\.createUser\s*\(/.test(readFileSync(file, "utf8"))
    );
    expect(callers.map((file) => path.relative(process.cwd(), file).replaceAll("\\", "/")).sort()).toEqual([
      "app/api/admin/users/route.ts",
      "scripts/provision-admin-users.ts"
    ]);
  });

  it("ships executable classification and five-scenario real-PG proofs", () => {
    const runtime = source(runtimePath);
    const concurrency = source(concurrencyPath);
    expect(runtime).toMatch(/USER_PROVISIONING_R84_RUNTIME_PASS/i);
    expect(runtime).toMatch(/session_replication_role/i);
    expect(runtime).toMatch(/unclassified/i);
    expect(runtime).toMatch(/R84_NULL_FINGERPRINT_OR_VERSION_ACCEPTED/i);
    expect(runtime).toMatch(/pending_cross_locator/i);
    expect(runtime).toMatch(/explain\s*\(analyze,\s*buffers/i);
    for (const classification of [
      "COMPLETED_CONSISTENT",
      "PENDING_NO_AUTH",
      "PENDING_AUTH_PROFILE_MATCH",
      "PENDING_AUTH_NO_PROFILE",
      "PENDING_AUTH_PROFILE_MISMATCH",
      "COMPLETED_AUTH_MISSING",
      "COMPLETED_PROFILE_MISSING",
      "AMBIGUOUS"
    ]) {
      expect(runtime).toContain(classification);
    }
    expect(concurrency).toMatch(/dblink_connect/i);
    expect(concurrency).toMatch(/1\.\.20/i);
    for (const scenario of [
      "same_key_same_payload",
      "same_key_different_payload",
      "different_keys_same_email",
      "pending_retry",
      "completed_replay"
    ]) {
      expect(concurrency).toContain(scenario);
    }
    expect(concurrency).toMatch(/deadlock/i);
    expect(concurrency).toMatch(/timeout/i);
    expect(concurrency).toMatch(
      /different_keys_same_email[\s\S]*?insert\s+into\s+auth\.users/i
    );
  });
});
