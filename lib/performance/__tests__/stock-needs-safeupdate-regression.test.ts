import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const historicalMigration = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260826160000_stock_needs_snapshot_r74.sql"
  ),
  "utf8"
);
const fixMigration = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260830120000_fix_stock_needs_safeupdate.sql"
  ),
  "utf8"
);
const runtimeRegression = readFileSync(
  path.join(process.cwd(), "supabase/tests/stock_needs_safeupdate_runtime.sql"),
  "utf8"
);

function updateStatement(source: string, startAt = 0) {
  const start = source.indexOf(
    "update public.business_stock_needs_scopes scope",
    startAt
  );
  if (start < 0) throw new Error("Stock Needs scope UPDATE not found");
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error("Stock Needs scope UPDATE terminator not found");
  return source.slice(start, end + 1);
}

function hasRootWhere(statement: string) {
  let depth = 0;
  let inSingleQuote = false;
  let token = "";
  const rootTokens: string[] = [];

  const flushToken = () => {
    if (depth === 0 && token) rootTokens.push(token.toLowerCase());
    token = "";
  };

  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index];
    if (character === "'") {
      if (inSingleQuote && statement[index + 1] === "'") {
        index += 1;
        continue;
      }
      flushToken();
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (inSingleQuote) continue;
    if (character === "(") {
      flushToken();
      depth += 1;
      continue;
    }
    if (character === ")") {
      flushToken();
      depth -= 1;
      continue;
    }
    if (/[a-z_]/i.test(character)) {
      token += character;
    } else {
      flushToken();
    }
  }
  flushToken();
  return rootTokens.includes("where");
}

describe("Stock Needs pg-safeupdate regression", () => {
  it("reproduces why the effective R7.4 refresh is unsafe", () => {
    const functionStart = historicalMigration.indexOf(
      "create or replace function public.ensure_stock_needs_scopes_v1()"
    );
    const originalRefresh = updateStatement(historicalMigration, functionStart);

    expect(originalRefresh).toContain("when 'owner' then exists");
    expect(originalRefresh).toContain("where profile.id = scope.owner_id");
    expect(hasRootWhere(originalRefresh)).toBe(false);
  });

  it("replaces only the helper and qualifies the refresh by its primary key", () => {
    const cteStart = fixMigration.indexOf("with desired_scope_state as materialized");
    const safeRefresh = updateStatement(fixMigration, cteStart);

    expect(fixMigration).toContain(
      "create or replace function public.ensure_stock_needs_scopes_v1()"
    );
    expect(safeRefresh).toContain("from desired_scope_state desired");
    expect(safeRefresh).toContain("where scope.id = desired.id");
    expect(hasRootWhere(safeRefresh)).toBe(true);
  });

  it("keeps safeupdate enabled and ships a transactional runtime proof", () => {
    expect(`${fixMigration}\n${runtimeRegression}`).not.toMatch(
      /safeupdate\.enabled\s*=\s*(?:0|false|'?off'?)/i
    );
    expect(runtimeRegression).toContain("set local safeupdate.enabled = 'on'");
    expect(runtimeRegression).toContain("when sqlstate '21000'");
    expect(runtimeRegression).toContain("perform public.ensure_stock_needs_scopes_v1()");
    expect(runtimeRegression).toContain("business_stock_needs_profile_queue_v1");
    expect(runtimeRegression.trimEnd()).toMatch(/rollback;$/i);
  });
});
