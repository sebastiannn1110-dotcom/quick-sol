import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const diagnosticPath = path.join(
  process.cwd(),
  "supabase/diagnostics/round8_user_integrity_counts.sql"
);
const diagnosticSql = readFileSync(diagnosticPath, "utf8");
const executableSql = diagnosticSql.replace(/--.*$/gm, "").trim();

describe("R8.1 user integrity diagnostic contract", () => {
  it("is one read-only SELECT over Auth users and profiles", () => {
    const statements = executableSql.split(";").map((statement) => statement.trim()).filter(Boolean);
    const mutationKeywords =
      /\b(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|copy|call|do|execute)\b/i;
    const relations = executableSql.split(/\r?\n/).flatMap((line) => {
      const relation = line.trim().match(
        /^(?:from|(?:(?:full|left|right|inner|cross)(?:\s+outer)?\s+)?join)\s+([a-z_][a-z0-9_.]*)/i
      );
      return relation ? [relation[1].toLowerCase()] : [];
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^select\b/i);
    expect(statements[0]).not.toMatch(mutationKeywords);
    expect(new Set(relations)).toEqual(new Set(["auth.users", "public.profiles"]));
  });

  it("projects exactly the four approved counts and no identity fields", () => {
    const selectListEnd = executableSql.search(/\bfrom\s+auth\.users\b/i);
    const selectList = executableSql.slice(0, selectListEnd);
    const outputAliases = Array.from(
      selectList.matchAll(/\bas\s+([a-z_][a-z0-9_]*)/gi),
      (match) => match[1]
    );

    expect(selectList.match(/\bcount\s*\(\s*\*\s*\)\s*filter/gi)).toHaveLength(4);
    expect(outputAliases).toEqual([
      "auth_without_profile",
      "profile_without_auth",
      "email_mismatches",
      "effective_admins"
    ]);
  });

  it("uses the complete effective-admin definition", () => {
    expect(executableSql).toMatch(/profile\.is_active\s+is\s+true/i);
    expect(executableSql).toMatch(/profile\.role\s+in\s*\(\s*'admin'\s*,\s*'super_admin_dev'\s*\)/i);
    expect(executableSql).toMatch(/auth_user\.email_confirmed_at\s+is\s+not\s+null/i);
    expect(executableSql).toMatch(/auth_user\.banned_until\s+is\s+null/i);
    expect(executableSql).toMatch(/auth_user\.banned_until\s*<=\s*now\s*\(\s*\)/i);
  });
});
