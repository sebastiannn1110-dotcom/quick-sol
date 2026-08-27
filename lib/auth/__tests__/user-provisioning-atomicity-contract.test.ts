import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath =
  "supabase/migrations/20260827180000_user_provisioning_intents_r83a.sql";
const hotfixMigrationPath =
  "supabase/migrations/20260827183000_user_provisioning_intent_user_metadata_r831.sql";
const releaseGatePath =
  "supabase/release-gates/20260827190000_enforce_user_provisioning_intents_r83b.sql";
const apiPath = "app/api/admin/users/route.ts";
const cliPath = "scripts/provision-admin-users.ts";
const cutoverPath = "supabase/tests/user_provisioning_r83_cutover_runtime.sql";
const atomicityPath = "supabase/tests/user_provisioning_r83_atomicity_runtime.sql";
const concurrencyPath = "supabase/tests/user_provisioning_r83_concurrency_runtime.sql";

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

const migration = source(migrationPath);
const hotfixMigration = source(hotfixMigrationPath);
const releaseGate = source(releaseGatePath);
const api = source(apiPath);
const cli = source(cliPath);
const cutover = source(cutoverPath);
const atomicity = source(atomicityPath);
const concurrency = source(concurrencyPath);

describe("R8.3 atomic Auth/Profile provisioning contract", () => {
  it("stores a durable one-use intent without plaintext email or credentials", () => {
    const table = migration.match(
      /create\s+table\s+public\.user_provisioning_intents\s*\([\s\S]*?\n\);/i
    )?.[0];

    expect(table).toBeTruthy();
    for (const field of [
      "status",
      "source",
      "actor_profile_id",
      "requested_email_hash",
      "requested_role",
      "requested_full_name",
      "requested_department",
      "requested_region",
      "requested_is_active",
      "auth_user_id",
      "created_at",
      "completed_at"
    ]) {
      expect(table).toMatch(new RegExp(`\\b${field}\\b`, "i"));
    }
    expect(table).toMatch(/status\s+in\s*\(\s*'pending'\s*,\s*'completed'\s*\)/i);
    expect(table).toMatch(/auth_user_id\s+uuid\s+unique\s+references\s+auth\.users/i);
    expect(table).not.toMatch(/\b(?:password|token|secret|plaintext_email)\b/i);
    expect(migration).toMatch(/extensions\.digest\s*\(\s*normalized_email\s*,\s*'sha256'\s*\)/i);
  });

  it("locks and consumes one pending intent before writing the final Profile", () => {
    const triggerFunction = withoutComments(routine(hotfixMigration, "public.handle_new_user"));
    const lockIndex = triggerFunction.search(
      /from\s+public\.user_provisioning_intents\s+intent[\s\S]*?for\s+update/i
    );
    const finalProfileOffset = triggerFunction
      .slice(lockIndex)
      .search(/insert\s+into\s+public\.profiles/i);
    const profileInsertIndex = lockIndex + finalProfileOffset;
    const completionIndex = triggerFunction.search(
      /update\s+public\.user_provisioning_intents\s+intent[\s\S]*?status\s*=\s*'completed'/i
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(finalProfileOffset).toBeGreaterThanOrEqual(0);
    expect(profileInsertIndex).toBeGreaterThan(lockIndex);
    expect(completionIndex).toBeGreaterThan(profileInsertIndex);
    expect(triggerFunction).toMatch(/new\.raw_user_meta_data\s*->>\s*'quiksol_provisioning_intent_id'/i);
    expect(triggerFunction).not.toMatch(/new\.raw_app_meta_data\s*->>\s*'quiksol_provisioning_intent_id'/i);
    expect(triggerFunction).toMatch(/extensions\.digest\s*\(\s*normalized_auth_email\s*,\s*'sha256'/i);
    expect(triggerFunction).not.toMatch(/raw_user_meta_data\s*->>\s*'(?:role|department|region|is_active)'/i);
    for (const sqlstate of ["QS831", "QS832", "QS833", "QS834", "QS835", "QS836"]) {
      expect(triggerFunction).toContain(`'${sqlstate}'`);
    }
  });

  it("revalidates the web actor and isolates the service-only CLI source", () => {
    const internal = withoutComments(
      routine(migration, "public.create_user_provisioning_intent_internal_v1")
    );

    expect(internal).toMatch(/input_actor_profile_id\s+is\s+distinct\s+from\s+auth\.uid\s*\(\s*\)/i);
    expect(internal).toMatch(/profile\.is_active\s+is\s+true/i);
    expect(internal).toMatch(/auth_user\.email_confirmed_at\s+is\s+not\s+null/i);
    expect(internal).toMatch(/auth_user\.banned_until/i);
    expect(internal).toMatch(/profile_role_has_capability\s*\(\s*actor_profile\.role\s*,\s*'SUPERADMIN'/i);
    expect(migration).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.create_user_provisioning_intent_v1\([^;]+\)\s+to\s+authenticated\s*;/i
    );
    expect(migration).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.create_cli_user_provisioning_intent_v1\([^;]+\)\s+to\s+service_role\s*;/i
    );
    expect(migration).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.(?:create_user|create_cli_user)_provisioning_intent_v1\([^;]+\)\s+to\s+[^;]*\banon\b/i
    );
  });

  it("keeps the intent table closed and classified PRESERVE in Database Safety", () => {
    expect(migration).toMatch(/alter\s+table\s+public\.user_provisioning_intents\s+enable\s+row\s+level\s+security/i);
    expect(migration).toMatch(
      /revoke\s+all\s+on\s+table\s+public\.user_provisioning_intents\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/i
    );
    expect(migration).toMatch(
      /'public','user_provisioning_intents','AUTH_IDENTITY','PRESERVE',null/i
    );
    expect(migration).toContain("20260827180000-r83a-v1");
  });

  it("keeps A additive and B outside the automatic migration chain", () => {
    const automaticMigrations = readdirSync(path.join(process.cwd(), "supabase/migrations"));
    const aGate = routine(migration, "public.user_provisioning_intent_required_v1");
    const bGate = routine(releaseGate, "public.user_provisioning_intent_required_v1");

    expect(aGate).toMatch(/select\s+false/i);
    expect(bGate).toMatch(/select\s+true/i);
    expect(routine(migration, "public.handle_new_user")).toMatch(
      /new\.raw_app_meta_data\s*->>\s*'quiksol_provisioning_intent_id'/i
    );
    expect(automaticMigrations).toContain(path.basename(hotfixMigrationPath));
    expect(automaticMigrations.some((name) => /r83b|enforce_user_provisioning/i.test(name))).toBe(false);
    expect(releaseGate).toMatch(/DO NOT move this file into supabase\/migrations/i);
    for (const matrixCase of [
      "old application + DB A",
      "new application + DB A",
      "new application + DB B",
      "old application + DB B"
    ]) {
      expect(cutover.toLowerCase()).toContain(matrixCase.toLowerCase());
    }
    expect(cutover).toMatch(/exception\s+when\s+sqlstate\s+'QS831'/i);
  });

  it("makes the web POST intent-first with no second Profile write", () => {
    const post = withoutComments(
      api.slice(api.indexOf("export async function POST"), api.indexOf("export async function PATCH"))
    );
    const intentIndex = post.indexOf('"create_user_provisioning_intent_v1"');
    const authIndex = post.indexOf("service.auth.admin.createUser");

    expect(intentIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeGreaterThan(intentIndex);
    expect(post).toMatch(
      /user_metadata\s*:\s*\{\s*full_name\s*:\s*body\.data\.full_name\s*,\s*quiksol_provisioning_intent_id\s*:\s*intentId/i
    );
    expect(post).not.toMatch(/app_metadata\s*:[\s\S]*?quiksol_provisioning_intent_id/i);
    expect(post).not.toMatch(
      /user_metadata\s*:\s*\{[^}]*\b(?:role|department|region|is_active)\s*:/i
    );
    expect(post).not.toMatch(/\.from\s*\(\s*["']profiles["']\s*\)[\s\S]*?\.(?:insert|upsert)\s*\(/i);
    expect(post.indexOf("logAuditEvent")).toBeGreaterThan(authIndex);
  });

  it("makes only the CLI new-user branch intent-first and leaves its legacy existing-user branch explicit", () => {
    const executable = withoutComments(cli);
    const newBranch = executable.slice(
      executable.indexOf("const creationSecret"),
      executable.indexOf("function loadEnvFile")
    );
    const intentIndex = newBranch.indexOf("gateway.createProvisioningIntent");
    const authIndex = newBranch.indexOf("gateway.createUser");
    const createUserImplementation = executable.slice(
      executable.indexOf("async createUser(target, password, intentId)"),
      executable.indexOf("async upsertProfile(user, target)")
    );

    expect(intentIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeGreaterThan(intentIndex);
    expect(newBranch).not.toMatch(/gateway\.upsertProfile/i);
    expect(executable).toMatch(
      /if\s*\(\s*existingUser\s*\)[\s\S]*?gateway\.upsertProfile\s*\(\s*updatedUser\s*,\s*target\s*\)/i
    );
    expect(cli).toMatch(/R8\.4 legacy compatibility only/i);
    expect(createUserImplementation).toMatch(
      /user_metadata\s*:\s*\{\s*full_name\s*:\s*target\.fullName\s*,\s*quiksol_provisioning_intent_id\s*:\s*intentId/i
    );
    expect(createUserImplementation).not.toMatch(/app_metadata/i);
    expect(createUserImplementation).not.toMatch(
      /user_metadata\s*:\s*\{[^}]*\b(?:role|department|region|is_active)\s*:/i
    );
  });

  it("keeps executable atomicity and real two-backend same-intent proofs", () => {
    for (const sqlstate of ["QS831", "QS832", "QS833", "QS834", "QS835"]) {
      expect(atomicity).toContain(`'${sqlstate}'`);
    }
    expect(atomicity).toMatch(/add\s+constraint\s+r83_test_forced_profile_failure/i);
    expect(atomicity).toMatch(/raw_user_meta_data/i);
    expect(atomicity).toContain("R831_APP_METADATA_DEPENDENCY_REMAINS");
    for (const tamperedKey of ["role", "is_active", "department", "region", "permissions", "source", "actor"]) {
      expect(atomicity).toMatch(new RegExp(`['\"]${tamperedKey}['\"]`, "i"));
    }
    expect(atomicity).toMatch(/auth_without_profile/i);
    expect(atomicity).toMatch(/profile_without_auth/i);
    expect(atomicity).toMatch(/explain\s*\(\s*analyze\s*,\s*buffers\s*\)/i);

    expect(concurrency).toMatch(/for\s+iteration_number\s+in\s+1\.\.20\s+loop/i);
    expect(concurrency).toMatch(/dblink_connect\s*\(\s*'r83_intent_a'/i);
    expect(concurrency).toMatch(/dblink_connect\s*\(\s*'r83_intent_b'/i);
    expect(concurrency.match(/dblink_send_query\s*\(/gi)).toHaveLength(2);
    expect(concurrency).toMatch(/exit\s+when\s+waiting_backends\s*=\s*2/i);
    expect(concurrency).toMatch(/auth_rows\s*<>\s*1\s+or\s+profile_rows\s*<>\s*1\s+or\s+completed_intents\s*<>\s*1/i);
    expect(concurrency).toMatch(/sqlstate\s*=\s*'QS834'/i);
  });

  it("uses the installed Supabase SDK contract for INSERT-visible user metadata", () => {
    const packageJson = JSON.parse(source("package.json")) as {
      dependencies: Record<string, string>;
    };
    const authTypes = source("node_modules/@supabase/auth-js/src/lib/types.ts");
    const adminAttributes = authTypes.slice(
      authTypes.indexOf("export interface AdminUserAttributes"),
      authTypes.indexOf("export interface AdminUserAttributes") + 1600
    );

    expect(packageJson.dependencies["@supabase/supabase-js"]).toBe("^2.108.2");
    expect(adminAttributes).toMatch(/user_metadata\?\s*:\s*object/i);
    expect(adminAttributes).toMatch(/maps\s+to\s+the\s+`auth\.users\.raw_user_meta_data`\s+column/i);
  });
});
