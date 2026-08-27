import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath =
  "supabase/migrations/20260827120000_last_effective_admin_invariant.sql";
const apiPath = "app/api/admin/users/route.ts";
const runtimePath = "supabase/tests/last_effective_admin_r82_runtime.sql";
const concurrencyPath =
  "supabase/tests/last_effective_admin_r82_concurrency_runtime.sql";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function withoutSqlComments(sql: string) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routine(sql: string, qualifiedName: string) {
  const match = sql.match(
    new RegExp(
      `create\\s+or\\s+replace\\s+(?:function|procedure)\\s+${escaped(qualifiedName)}\\s*\\([\\s\\S]*?\\bas\\s+\\$\\$[\\s\\S]*?\\$\\$\\s*;`,
      "i"
    )
  );

  expect(match, `missing SQL routine ${qualifiedName}`).not.toBeNull();
  return match![0];
}

function trigger(sql: string, triggerName: string) {
  const match = sql.match(
    new RegExp(
      `create\\s+(?:constraint\\s+)?trigger\\s+${escaped(triggerName)}\\b[\\s\\S]*?;`,
      "i"
    )
  );

  expect(match, `missing trigger ${triggerName}`).not.toBeNull();
  return match![0];
}

const migration = source(migrationPath);
const api = source(apiPath);
const runtimeSql = source(runtimePath);
const concurrencySql = source(concurrencyPath);

describe("R8.2 last effective administrator invariant contract", () => {
  it("keeps v2 as the authoritative RPC and v1 as a thin compatibility wrapper", () => {
    const v2 = routine(migration, "public.update_profile_admin_v2");
    const v1 = routine(migration, "public.update_profile_admin_v1");

    expect(v2).toMatch(/returns\s+jsonb/i);
    expect(v2).toMatch(/language\s+plpgsql/i);
    expect(v1).toMatch(/language\s+sql/i);
    expect(v1).toMatch(
      /select\s+public\.update_profile_admin_v2\s*\(\s*target_profile_id\s*,\s*profile_patch\s*,\s*confirm_self_deactivate\s*\)/i
    );
    expect(withoutSqlComments(v1)).not.toMatch(/\b(?:insert|update|delete)\s+(?:into|from\s+)?public\.profiles\b/i);
    expect(withoutSqlComments(v1)).not.toMatch(/\bcount\s*\(/i);
  });

  it("takes one fixed transaction mutex before actor, target and census reads", () => {
    const lock = routine(migration, "public.lock_effective_admin_invariant_v1");
    const v2 = withoutSqlComments(routine(migration, "public.update_profile_admin_v2"));
    const mutex = lock.match(
      /pg_advisory_xact_lock\s*\(\s*(\d+)\s*::\s*bigint\s*\)/i
    );

    expect(mutex).not.toBeNull();
    expect(mutex?.[1]).toBe("8202202608271200");

    const lockIndex = v2.search(/perform\s+public\.lock_effective_admin_invariant_v1\s*\(\s*\)/i);
    const actorIndex = v2.search(
      /from\s+public\.profiles\s+profile\s+join\s+auth\.users\s+auth_user[\s\S]*?profile\.id\s*=\s*auth\.uid\s*\(\s*\)/i
    );
    const targetIndex = v2.search(
      /where\s+profile\.id\s*=\s*target_profile_id\s+for\s+update/i
    );
    const reductionIndex = v2.search(
      /may_reduce_admin_capacity\s*:=\s*target_profile\.is_active/i
    );
    const censusIndex = v2.search(/public\.effective_admin_count_v1\s*\(\s*\)/i);

    expect(v2).toMatch(
      /touches_admin_capacity\s*:=\s*profile_patch\s*\?\s*'role'\s+or\s+profile_patch\s*\?\s*'is_active'/i
    );
    expect(v2).toMatch(
      /if\s+touches_admin_capacity\s+then\s+perform\s+public\.lock_effective_admin_invariant_v1\s*\(\s*\)/i
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(actorIndex).toBeGreaterThan(lockIndex);
    expect(targetIndex).toBeGreaterThan(actorIndex);
    expect(reductionIndex).toBeGreaterThan(targetIndex);
    expect(censusIndex).toBeGreaterThan(targetIndex);
  });

  it("fails closed before locking when the transaction cannot refresh its snapshot", () => {
    const lock = withoutSqlComments(
      routine(migration, "public.lock_effective_admin_invariant_v1")
    );
    const isolationGuardIndex = lock.search(
      /current_setting\s*\(\s*'transaction_isolation'\s*\)\s*<>\s*'read committed'/i
    );
    const errorIndex = lock.search(/errcode\s*=\s*'QS822'/i);
    const mutexIndex = lock.search(/pg_advisory_xact_lock\s*\(/i);

    expect(lock).toMatch(/message\s*=\s*'ADMIN_INVARIANT_REQUIRES_READ_COMMITTED'/i);
    expect(isolationGuardIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(isolationGuardIndex);
    expect(mutexIndex).toBeGreaterThan(errorIndex);
  });

  it("defines effective administrators from both profile and usable Auth state", () => {
    const census = withoutSqlComments(
      routine(migration, "public.effective_admin_count_v1")
    );

    expect(census).toMatch(/select\s+count\s*\(\s*\*\s*\)/i);
    expect(census).toMatch(/from\s+public\.profiles\s+profile/i);
    expect(census).toMatch(
      /join\s+auth\.users\s+auth_user\s+on\s+auth_user\.id\s*=\s*profile\.id/i
    );
    expect(census).toMatch(/profile\.is_active\s+is\s+true/i);
    expect(census).toMatch(
      /profile\.role\s+in\s*\(\s*'admin'\s*,\s*'super_admin_dev'\s*\)/i
    );
    expect(census).toMatch(/auth_user\.email_confirmed_at\s+is\s+not\s+null/i);
    expect(census).toMatch(
      /\(\s*auth_user\.banned_until\s+is\s+null\s+or\s+auth_user\.banned_until\s*<=\s*(?:pg_catalog\.)?now\s*\(\s*\)\s*\)/i
    );
  });

  it("hardens every invariant routine and exposes only the two RPC entrypoints", () => {
    const coreRoutineNames = [
      "public.lock_effective_admin_invariant_v1",
      "public.effective_admin_count_v1",
      "public.assert_effective_admin_invariant_v1",
      "public.update_profile_admin_v2",
      "public.update_profile_admin_v1"
    ];

    for (const name of coreRoutineNames) {
      const declaration = routine(migration, name);
      expect(declaration, `${name} must be VOLATILE`).toMatch(/\bvolatile\b/i);
      expect(declaration, `${name} must be SECURITY DEFINER`).toMatch(
        /\bsecurity\s+definer\b/i
      );
      expect(declaration, `${name} must pin pg_catalog first`).toMatch(
        /set\s+search_path\s*=\s*pg_catalog(?:\s*,\s*public)?/i
      );
    }

    expect(migration).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.update_profile_admin_v2\s*\(\s*uuid\s*,\s*jsonb\s*,\s*boolean\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role\s*;/i
    );
    expect(migration).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.update_profile_admin_v1\s*\(\s*uuid\s*,\s*jsonb\s*,\s*boolean\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role\s*;/i
    );
    expect(migration).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.update_profile_admin_v2\s*\([^;]+\)\s+to\s+authenticated\s*,\s*service_role\s*;/i
    );
    expect(migration).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.update_profile_admin_v1\s*\([^;]+\)\s+to\s+authenticated\s*,\s*service_role\s*;/i
    );
    expect(migration).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.[a-z0-9_]+\s*\([^;]*\)\s+to\s+[^;]*\banon\b/i
    );
  });

  it("uses the stable business SQLSTATE in the database and API", () => {
    const invariantRaise = routine(
      migration,
      "public.assert_effective_admin_invariant_v1"
    );
    const v2 = routine(migration, "public.update_profile_admin_v2");

    expect(invariantRaise).toMatch(/errcode\s*=\s*'QS821'/i);
    expect(invariantRaise).toMatch(/message\s*=\s*'LAST_EFFECTIVE_ADMIN_REQUIRED'/i);
    expect(v2).toMatch(/errcode\s*=\s*'QS821'/i);
    expect(runtimeSql.match(/exception\s+when\s+sqlstate\s+'QS821'/gi)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(api).toMatch(/lastEffectiveAdminSqlState\s*=\s*["']QS821["']/);
    expect(api).toMatch(
      /lastEffectiveAdminPublicCode\s*=\s*["']LAST_EFFECTIVE_ADMIN_REQUIRED["']/
    );
  });

  it("locks profile security statements first and defers update/delete backstops", () => {
    const lockUpdate = trigger(
      migration,
      "profiles_effective_admin_lock_update_v1"
    );
    const lockDelete = trigger(
      migration,
      "profiles_effective_admin_lock_delete_v1"
    );
    const validateUpdate = trigger(
      migration,
      "profiles_effective_admin_validate_update_v1"
    );
    const validateDelete = trigger(
      migration,
      "profiles_effective_admin_validate_delete_v1"
    );

    expect(lockUpdate).toMatch(/before\s+update\s+of\s+role\s*,\s*is_active\s+on\s+public\.profiles/i);
    expect(lockUpdate).toMatch(/for\s+each\s+statement/i);
    expect(lockDelete).toMatch(/before\s+delete\s+on\s+public\.profiles/i);
    expect(lockDelete).toMatch(/for\s+each\s+statement/i);

    for (const [operation, definition] of [
      ["update", validateUpdate],
      ["delete", validateDelete]
    ] as const) {
      expect(definition).toMatch(/^create\s+constraint\s+trigger/i);
      expect(definition).toMatch(new RegExp(`after\\s+${operation}\\b`, "i"));
      expect(definition).toMatch(/deferrable\s+initially\s+deferred/i);
      expect(definition).toMatch(/for\s+each\s+row/i);

      const triggerFunction = definition.match(
        /execute\s+function\s+(public\.[a-z0-9_]+)\s*\(\s*\)/i
      )?.[1];
      expect(triggerFunction).toBeTruthy();
      const declaration = routine(migration, triggerFunction!);
      expect(declaration).toMatch(/\bvolatile\b/i);
      expect(declaration).toMatch(/\bsecurity\s+definer\b/i);
      expect(declaration).toMatch(/set\s+search_path\s*=\s*pg_catalog\s*,\s*public/i);
      expect(declaration).toMatch(/public\.assert_effective_admin_invariant_v1\s*\(\s*\)/i);
    }
  });

  it("keeps PATCH and DELETE on v2, without a TypeScript census, and maps QS821 to 409", () => {
    expect(api.match(/\.rpc\s*\(\s*["']update_profile_admin_v2["']/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(api).not.toMatch(/\.rpc\s*\(\s*["']update_profile_admin_v1["']/);
    expect(api).not.toMatch(/\bcount\s*:\s*["']exact["']/i);
    expect(api).not.toMatch(/\.select\s*\([^)]*\{\s*count\s*:/i);
    expect(api).toMatch(/error\?\.code\s*===\s*lastEffectiveAdminSqlState/);
    expect(api).toMatch(/\{\s*status\s*:\s*409\s*\}/);
    expect(api.match(/adminMutationErrorResponse\s*\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("keeps executable sequential proofs for exact Auth semantics and direct-write rejection", () => {
    const executableRuntime = withoutSqlComments(runtimeSql);

    expect(executableRuntime).toMatch(/current_database\s*\(\s*\)\s*<>\s*'quiksol_r82_admin_invariant_test'/i);
    expect(executableRuntime).toMatch(/email_confirmed_at[\s\S]*?banned_until/i);
    expect(executableRuntime).toMatch(/banned_until\s*=\s*(?:pg_catalog\.)?now\s*\(\s*\)\s*\+\s*interval\s+'1 day'/i);
    expect(executableRuntime).toMatch(/email_confirmed_at[\s\S]*?null/i);
    expect(executableRuntime).toMatch(/update\s+public\.profiles\s+set\s+role\s*=\s*'employee'/i);
    expect(executableRuntime).toMatch(/update\s+public\.profiles\s+set\s+role\s*=\s*'manager'/i);
    expect(executableRuntime).toMatch(/update\s+public\.profiles\s+set\s+is_active\s*=\s*false/i);
    expect(executableRuntime).toMatch(/delete\s+from\s+public\.profiles/i);
    expect(executableRuntime).toMatch(/public\.update_profile_admin_v2\s*\(/i);
    expect(executableRuntime).toMatch(/public\.update_profile_admin_v1\s*\(/i);
    expect(executableRuntime.trim()).toMatch(/rollback\s*;$/i);
  });

  it("runs every critical race at least 20 times through two genuinely concurrent backends", () => {
    const executableConcurrency = withoutSqlComments(concurrencySql);
    const runner = withoutSqlComments(
      routine(concurrencySql, "r82_test.run_all_scenarios")
    );
    const attempt = withoutSqlComments(routine(concurrencySql, "r82_test.attempt"));
    const iterationBounds = Array.from(
      runner.matchAll(/for\s+[a-z0-9_]+\s+in\s+1\.\.(\d+)\s+loop/gi),
      (match) => Number(match[1])
    );

    expect(Math.max(...iterationBounds)).toBeGreaterThanOrEqual(20);
    for (const scenario of [
      "two_admin_demote_demote",
      "two_admin_disable_disable",
      "two_admin_demote_disable",
      "soft_delete_demote",
      "direct_service_role_bypass",
      "admin_superadmin_rule_boundary",
      "three_admin_two_demotions"
    ]) {
      expect(executableConcurrency).toContain(`'${scenario}'`);
    }

    expect(runner).toMatch(/dblink_connect\s*\(\s*'r82_admin_a'/i);
    expect(runner).toMatch(/dblink_connect\s*\(\s*'r82_admin_b'/i);

    const coordinatorGate = runner.match(
      /pg_advisory_lock\s*\(\s*(\d+)\s*::\s*bigint\s*\)/i
    );
    const workerGate = attempt.match(
      /pg_advisory_xact_lock_shared\s*\(\s*(\d+)\s*::\s*bigint\s*\)/i
    );
    expect(coordinatorGate).not.toBeNull();
    expect(workerGate).not.toBeNull();
    expect(workerGate?.[1]).toBe(coordinatorGate?.[1]);
    expect(workerGate?.[1]).not.toBe("8202202608271200");

    const sendIndexes = Array.from(
      runner.matchAll(/dblink_send_query\s*\(/gi),
      (match) => match.index
    );
    const firstResultIndex = runner.search(/dblink_get_result\s*\(/i);
    const unlockIndex = runner.search(/pg_advisory_unlock\s*\(/i);

    expect(sendIndexes).toHaveLength(2);
    expect(firstResultIndex).toBeGreaterThan(sendIndexes[1]);
    expect(unlockIndex).toBeGreaterThan(sendIndexes[1]);
    expect(firstResultIndex).toBeGreaterThan(unlockIndex);
    expect(runner).toMatch(
      /from\s+pg_catalog\.pg_stat_activity[\s\S]*?activity\.wait_event_type\s*=\s*'Lock'[\s\S]*?lower\s*\(\s*activity\.wait_event\s*\)\s*=\s*'advisory'/i
    );
    expect(runner).toMatch(/exit\s+when\s+waiting_backends\s*=\s*2/i);
    expect(runner).toMatch(/if\s+waiting_backends\s*<>\s*2\s+then/i);
    expect(runner).toMatch(/backendPid[\s\S]*?transactionId/i);
    expect(runner).toMatch(/R82_NOT_TWO_DISTINCT_TRANSACTIONS/i);

    for (const column of [
      "scenario",
      "iterations",
      "a_success",
      "b_success",
      "rejections",
      "final_min_admins",
      "deadlocks",
      "timeouts"
    ]) {
      expect(executableConcurrency).toMatch(new RegExp(`\\b${column}\\b`, "i"));
    }
    expect(executableConcurrency).toMatch(/minimum_admins\s*<\s*1/i);
    expect(executableConcurrency).toMatch(/deadlock_count\s*<>\s*0/i);
    expect(executableConcurrency).toMatch(/timeout_count\s*<>\s*0/i);
  });
});
