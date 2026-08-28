import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath =
  "supabase/migrations/20260827200000_user_provisioning_idempotency_reconciliation_r84.sql";

type ForbiddenRule = {
  label: string;
  pattern: RegExp;
};

const forbiddenRules: ForbiddenRule[] = [
  {
    label: "CREATE object in the managed auth schema",
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?(?:unlogged\s+table|foreign\s+table|table|materialized\s+view|view|sequence|type|domain|collation|function|procedure|aggregate)\s+(?:if\s+not\s+exists\s+)?auth\s*\./gi
  },
  {
    label: "write an auth-managed relation",
    pattern:
      /\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+(?:only\s+)?auth\s*\./gi
  },
  {
    label: "take a row lock that needs write privilege on an auth-managed relation",
    pattern:
      /\bfrom\s+(?:only\s+)?auth\s*\.[^;]*?\bfor\s+(?:update|no\s+key\s+update|share|key\s+share)\b/gi
  },
  {
    label: "CREATE INDEX on an auth-managed relation",
    pattern:
      /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?[a-z_][\w$]*(?:\s*\.\s*[a-z_][\w$]*)?\s+on\s+(?:only\s+)?auth\s*\./gi
  },
  {
    label: "CREATE TRIGGER/POLICY/RULE on an auth-managed relation",
    pattern:
      /\bcreate\s+(?:(?:constraint\s+)?trigger|policy|rule)\s+[a-z_][\w$]*(?:(?!;)[\s\S])*?\bon\s+(?:only\s+)?auth\s*\./gi
  },
  {
    label: "ALTER an auth-managed object",
    pattern:
      /\balter\s+(?:table|foreign\s+table|materialized\s+view|view|sequence|index|function|procedure|type|domain|collation)\s+(?:if\s+exists\s+)?(?:only\s+)?auth\s*\./gi
  },
  {
    label: "ALTER the managed auth schema",
    pattern: /\balter\s+schema\s+auth\b/gi
  },
  {
    label: "ALTER DEFAULT PRIVILEGES in the managed auth schema",
    pattern: /\balter\s+default\s+privileges\b[^;]*\bin\s+schema\s+auth\b/gi
  },
  {
    label: "ALTER the managed Supabase Auth owner role",
    pattern: /\balter\s+role\s+supabase_auth_admin\b/gi
  },
  {
    label: "change membership in the managed Supabase Auth owner role",
    pattern:
      /\b(?:grant\s+supabase_auth_admin\s+to|revoke\s+supabase_auth_admin\s+from)\b/gi
  },
  {
    label: "unqualified ALTER auth relation",
    pattern: /\balter\s+auth\s*\./gi
  },
  {
    label: "DROP an auth-managed object or schema",
    pattern:
      /\bdrop\s+(?:table|foreign\s+table|materialized\s+view|view|sequence|index|function|procedure|type|domain|collation|schema)\s+(?:if\s+exists\s+)?(?:only\s+)?auth(?:\s*\.|\b)/gi
  },
  {
    label: "DROP TRIGGER/POLICY/RULE on an auth-managed relation",
    pattern:
      /\bdrop\s+(?:trigger|policy|rule)\s+(?:if\s+exists\s+)?[a-z_][\w$]*\s+on\s+(?:only\s+)?auth\s*\./gi
  },
  {
    label: "TRUNCATE an auth-managed relation",
    pattern:
      /\btruncate\s+(?:table\s+)?(?:only\s+)?auth\s*\./gi
  },
  {
    label: "GRANT/REVOKE privileges on the managed auth schema or its objects",
    pattern:
      /\b(?:grant|revoke)\b[^;]*\bon\s+(?:(?:table|sequence|function|procedure|schema)\s+)?auth(?:\s*\.|\b)/gi
  },
  {
    label: "GRANT/REVOKE privileges on all objects in the managed auth schema",
    pattern:
      /\b(?:grant|revoke)\b[^;]*\bon\s+all\s+(?:tables|sequences|functions)\s+in\s+schema\s+auth\b/gi
  },
  {
    label: "COMMENT/SECURITY LABEL on an auth-managed object",
    pattern:
      /\b(?:comment\s+on|security\s+label\s+(?:for\s+[a-z_][\w$]*\s+)?on)\s+(?:table|column|index|view|materialized\s+view|sequence|schema|function|procedure)\s+auth(?:\s*\.|\b)/gi
  },
  {
    label: "CLUSTER/REINDEX an auth-managed object or schema",
    pattern:
      /\b(?:cluster\s+(?:verbose\s+)?auth\s*\.|reindex\s+(?:table|index|schema)\s+(?:concurrently\s+)?auth(?:\s*\.|\b))/gi
  },
  {
    label: "REASSIGN/DROP ownership belonging to the managed Auth owner",
    pattern:
      /\b(?:reassign\s+owned\s+by|drop\s+owned\s+by)\s+supabase_auth_admin\b/gi
  }
];

function executableSql(sql: string) {
  let output = "";
  let index = 0;
  let blockCommentDepth = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (blockCommentDepth > 0) {
      if (character === "/" && next === "*") {
        blockCommentDepth += 1;
        output += "  ";
        index += 2;
      } else if (character === "*" && next === "/") {
        blockCommentDepth -= 1;
        output += "  ";
        index += 2;
      } else {
        output += character === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }

    if (character === "/" && next === "*") {
      blockCommentDepth = 1;
      output += "  ";
      index += 2;
      continue;
    }

    // Text literals are not executable SQL. Dollar-quoted function bodies are
    // deliberately left visible so direct DDL hidden in a routine is rejected.
    if (character === "'") {
      output += " ";
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          output += "  ";
          index += 2;
        } else if (sql[index] === "'") {
          output += " ";
          index += 1;
          break;
        } else {
          output += sql[index] === "\n" ? "\n" : " ";
          index += 1;
        }
      }
      continue;
    }

    // Normalize quoted identifiers, so "auth"."users" cannot bypass the
    // portability contract while ordinary SQL string contents stay ignored.
    if (character === '"') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          output += '"';
          index += 2;
        } else if (sql[index] === '"') {
          index += 1;
          break;
        } else {
          output += sql[index];
          index += 1;
        }
      }
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

function managedAuthDdlViolations(sql: string) {
  const executable = executableSql(sql);
  return forbiddenRules.flatMap(({ label, pattern }) => {
    pattern.lastIndex = 0;
    return Array.from(executable.matchAll(pattern), (match) => ({
      label,
      sql: match[0].replace(/\s+/g, " ").trim()
    }));
  });
}

const forbiddenExamples = [
  "create index auth_email_idx on auth.users (email);",
  'create unique index "auth"."identity_idx" on "auth"."identities" (id);',
  "alter table auth.users add constraint forbidden unique (email);",
  "alter auth.users owner to postgres;",
  "alter schema auth owner to postgres;",
  "alter role supabase_auth_admin superuser;",
  "grant supabase_auth_admin to postgres;",
  "grant select on table auth.users to authenticated;",
  "revoke all on schema auth from public;",
  "grant select on all tables in schema auth to authenticated;",
  "drop table if exists auth.identities cascade;",
  "truncate table only auth.users;",
  "create trigger forbidden after insert on auth.users execute function public.noop();",
  "drop policy if exists forbidden on auth.users;",
  "comment on table auth.users is 'forbidden';",
  "security label on table auth.users is 'forbidden';",
  "reindex schema auth;",
  "reassign owned by supabase_auth_admin to postgres;",
  "create table auth.user_shadow (id uuid);",
  "update auth.users set email = lower(email);",
  "select id from auth.users where id = input_user_id for share;"
];

const allowedExamples = [
  "select id from auth.users where id = input_user_id;",
  "select profile.id from public.profiles profile join auth.users auth_user on auth_user.id = profile.id;",
  "candidate_auth auth.users%rowtype;",
  "alter table public.user_provisioning_intents add constraint r84_check check (attempt_count >= 0);",
  "create index public_profile_email_idx on public.profiles (email);",
  "create table public.example (auth_user_id uuid references auth.users(id));",
  `
    create or replace function public.read_managed_auth(input_id uuid)
    returns uuid
    language plpgsql
    security definer
    as $function$
    declare
      candidate auth.users%rowtype;
    begin
      select auth_user.*
      into candidate
      from auth.users auth_user
      join public.profiles profile on profile.id = auth_user.id
      where auth_user.id = input_id;
      return candidate.id;
    end;
    $function$;
  `
];

describe("R8.4 Supabase-managed Auth portability contract", () => {
  it.each(forbiddenExamples)("detects forbidden managed-Auth DDL: %s", (sql) => {
    expect(managedAuthDdlViolations(sql)).not.toEqual([]);
  });

  it.each(allowedExamples)("allows read-only Auth references: %s", (sql) => {
    expect(managedAuthDdlViolations(sql)).toEqual([]);
  });

  it("requires R8.4 to work without ownership of auth.users or the auth schema", () => {
    const migration = readFileSync(path.join(process.cwd(), migrationPath), "utf8");
    const violations = managedAuthDdlViolations(migration);

    expect(
      violations,
      `R8.4 must not issue DDL against Supabase-managed Auth objects:\n${violations
        .map(({ label, sql }) => `- ${label}: ${sql}`)
        .join("\n")}`
    ).toEqual([]);
  });
});
