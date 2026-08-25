import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260824130000_optimize_business_record_read_views.sql"),
  "utf8"
);

function between(start: string, end: string) {
  return migration.slice(migration.indexOf(start), migration.indexOf(end));
}

describe("R5 business-record performance hotfix", () => {
  it("preserves the raw-table boundary and public view grants", () => {
    expect(migration).toContain(
      "revoke select on table public.business_records from public, anon, authenticated"
    );
    expect(migration).toContain(
      "grant select on table public.business_records_safe_v1 to authenticated, service_role"
    );
    expect(migration).toContain(
      "grant select on table public.business_records_commercial_v1 to authenticated, service_role"
    );
    expect(migration.match(/with \(security_barrier = true\)/g)).toHaveLength(2);
  });

  it("removes the materialized actor join that forced the full sort", () => {
    expect(migration).not.toContain("with actor as materialized");
    expect(migration).not.toContain("cross join actor");
    expect(migration.match(/public\.can_read_upload\(record\.uploaded_by\)/g)).toHaveLength(2);
    expect(migration.match(/order by record\.created_at desc, record\.id desc/g)).toHaveLength(2);
  });

  it("keeps safe and commercial field masks intact", () => {
    const safeView = between(
      "create or replace view public.business_records_safe_v1",
      "create or replace view public.business_records_commercial_v1"
    );
    const commercialView = between(
      "create or replace view public.business_records_commercial_v1",
      "revoke all on table public.business_records_safe_v1"
    );

    expect(safeView).not.toMatch(
      /record\.(?:raw_data|normalized_data|searchable_text|errors|cost|price|gp|gp_rate|commission|po|supplier|customer|client|comments)\b/
    );
    expect(commercialView).not.toMatch(/record\.(?:raw_data|normalized_data|searchable_text|errors)\b/);
    expect(commercialView).toContain("public.current_profile_role() in ('manager', 'admin', 'super_admin_dev')");
    for (const field of ["po", "cost", "price", "total_price", "gp_rate", "gp", "commission", "comments"]) {
      expect(commercialView).toContain(`case when public.is_admin() then record.${field} else null end as ${field}`);
    }
  });
});
