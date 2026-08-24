import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUSINESS_RECORDS_COMMERCIAL_VIEW,
  BUSINESS_RECORDS_SAFE_VIEW,
  BUSINESS_MPN_SUMMARIES_SAFE_VIEW,
  BUSINESS_OPPORTUNITY_ENTITIES_SAFE_VIEW,
  COMMERCIAL_RECORD_SELECT,
  IMPORT_ERRORS_SAFE_VIEW,
  SAFE_RECORD_SELECT,
  businessRecordReadContract,
  permittedRecordSearchColumns
} from "@/lib/security/business-records";

const migration = readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260824120000_privacy_authorization_boundary.sql"),
  "utf8"
);

function between(start: string, end: string) {
  return migration.slice(migration.indexOf(start), migration.indexOf(end));
}

describe("Ronda 5 business-record privacy boundary", () => {
  it("revokes raw-table reads and publishes only explicit security-barrier contracts", () => {
    expect(migration).toContain("revoke select on table public.business_records from public, anon, authenticated");
    expect(migration).toContain("revoke select on table public.import_errors from public, anon, authenticated");
    expect(migration).toContain("revoke select on table public.business_mpn_summaries from public, anon, authenticated");
    expect(migration).toContain("revoke select on table public.business_opportunity_entities from public, anon, authenticated");
    expect(migration).toContain("create or replace view public.business_records_safe_v1");
    expect(migration).toContain("create or replace view public.business_records_commercial_v1");
    expect(migration.match(/with \(security_barrier = true\)/g)).toHaveLength(5);

    const employeeView = between("create or replace view public.business_records_safe_v1", "create or replace view public.business_records_commercial_v1");
    expect(employeeView).not.toMatch(/record\.(?:raw_data|normalized_data|searchable_text|errors|cost|price|gp|gp_rate|commission|po|supplier|customer|client|comments)\b/);
    expect(employeeView).toContain("profile.id = auth.uid() and profile.is_active");
    expect(employeeView).toContain("record.uploaded_by = actor.id");

    const errorView = between("create or replace view public.import_errors_safe_v1", "revoke all on table public.business_records_safe_v1");
    expect(errorView).not.toMatch(/import_error\.(?:raw_value|business_record_id)\b/);
    expect(errorView).not.toContain("import_error.message");
    expect(errorView).toContain("An import validation issue occurred.");
    expect(errorView).toContain("upload.uploaded_by = actor.id");
  });

  it("keeps the public contracts allowlisted and does not use select star", () => {
    expect(SAFE_RECORD_SELECT).not.toContain("*");
    expect(COMMERCIAL_RECORD_SELECT).not.toContain("*");
    const safeFields = new Set(SAFE_RECORD_SELECT.split(","));
    const commercialFields = new Set(COMMERCIAL_RECORD_SELECT.split(","));
    for (const field of ["raw_data", "normalized_data", "searchable_text", "errors", "cost", "price", "gp", "commission", "po", "supplier", "customer", "client", "comments"]) {
      expect(safeFields.has(field), field).toBe(false);
    }
    for (const field of ["raw_data", "normalized_data", "searchable_text", "errors"]) {
      expect(commercialFields.has(field), field).toBe(false);
    }
    expect(BUSINESS_RECORDS_SAFE_VIEW).toBe("business_records_safe_v1");
    expect(BUSINESS_RECORDS_COMMERCIAL_VIEW).toBe("business_records_commercial_v1");
    expect(IMPORT_ERRORS_SAFE_VIEW).toBe("import_errors_safe_v1");
    expect(BUSINESS_MPN_SUMMARIES_SAFE_VIEW).toBe("business_mpn_summaries_safe_v1");
    expect(BUSINESS_OPPORTUNITY_ENTITIES_SAFE_VIEW).toBe("business_opportunity_entities_safe_v1");
  });

  it("derives the correct contract and searchable fields from the authenticated role", () => {
    expect(businessRecordReadContract("employee").table).toBe(BUSINESS_RECORDS_SAFE_VIEW);
    expect(businessRecordReadContract("manager").table).toBe(BUSINESS_RECORDS_COMMERCIAL_VIEW);
    expect(businessRecordReadContract("admin").table).toBe(BUSINESS_RECORDS_COMMERCIAL_VIEW);
    expect(businessRecordReadContract("super_admin_dev").table).toBe(BUSINESS_RECORDS_COMMERCIAL_VIEW);
    expect(businessRecordReadContract("super_admin_dev", { aiSafe: true }).table).toBe(BUSINESS_RECORDS_SAFE_VIEW);
    expect(permittedRecordSearchColumns("employee")).not.toEqual(expect.arrayContaining(["supplier", "customer", "po"]));
    expect(permittedRecordSearchColumns("manager")).toEqual(expect.arrayContaining(["supplier", "customer"]));
    expect(permittedRecordSearchColumns("manager")).not.toContain("po");
    expect(permittedRecordSearchColumns("admin")).toContain("po");
  });

  it("revokes the leaking legacy RPC and exposes only the role-derived v2 contract", () => {
    expect(migration).toContain("revoke all on function public.search_executive_mpn_v1(text, integer, integer)");
    expect(migration).toContain("create or replace function public.search_executive_mpn_safe_v2");
    expect(migration).toContain("public.current_profile_role() as role");
    expect(migration).not.toMatch(/search_executive_mpn_safe_v2\([\s\S]*?p_role\b/);
    expect(migration).toContain("grant execute on function public.search_executive_mpn_safe_v2(text, integer, integer)");
  });

  it("moves derived summary RPCs and Opportunity Finder reads behind role-masked contracts", () => {
    const summaryView = between("create or replace view public.business_mpn_summaries_safe_v1", "create or replace view public.business_opportunity_entities_safe_v1");
    const entityView = between("create or replace view public.business_opportunity_entities_safe_v1", "revoke all on table public.business_records_safe_v1");
    expect(summaryView).toContain("summary.owner_id = actor.id");
    expect(entityView).toContain("entity.owner_id = actor.id");
    expect(summaryView).toContain("with actor as materialized");
    expect(entityView).toContain("with actor as materialized");
    expect(summaryView).toContain("actor.role in ('manager', 'admin', 'super_admin_dev')");
    expect(entityView).toContain("actor.role in ('manager', 'admin', 'super_admin_dev')");
    expect(migration).toContain("public.get_stock_needs_page_v1(integer,integer,text,text,text,text,text,text,uuid)");
    expect(migration).toContain("public.get_sales_opportunities_page_v1(integer,integer,text,text,text,text,text,text,uuid,uuid)");
    expect(migration).toContain("public.get_client_business_metrics_v1(uuid[])");
  });
});
