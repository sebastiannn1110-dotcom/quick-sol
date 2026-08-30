import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const migration = source("supabase/migrations/20260829160000_organization_employee_analytics.sql");
const tree = source("components/organization/TeamStructure.tsx");
const compensationRoute = source("app/api/organization/compensation/[employeeId]/route.ts");
const analyticsUi = source("components/employee-analytics/EmployeeAnalyticsDashboard.tsx");
const contracts = source("lib/organization/contracts.ts");
const sharedTypes = source("lib/types.ts");

describe("organization and analytics contract", () => {
  it("creates one-manager hierarchy with cycle and optimistic-version guards", () => {
    expect(migration).toMatch(/create table if not exists public\.organization_members/i);
    expect(migration).toMatch(/manager_id uuid references public\.organization_members\(profile_id\)/i);
    expect(migration).toContain("ORGANIZATION_CYCLE");
    expect(migration).toContain("ORGANIZATION_VERSION_CONFLICT");
    expect(migration).toContain("organization_is_descendant_v1(auth.uid(), input_profile_id, false)");
    expect(migration).toContain("ORGANIZATION_MOVE_OUTSIDE_SUBTREE");
  });

  it("keeps owner as a business rank without changing the technical Auth enum", () => {
    expect(migration).toContain("business_rank = 'owner'");
    expect(migration).toContain("profile_role_has_capability(profile.role, 'ADMIN')");
    expect(migration).not.toMatch(/alter table public\.profiles[\s\S]*role[\s\S]*owner/i);
  });

  it("adds narrow manager-subtree reads across profile and quote analytics tables", () => {
    for (const policy of [
      "profiles_read_organization_manager_subtree",
      "commerce_quotes_read_organization_manager_subtree",
      "commerce_quote_items_read_organization_manager_subtree",
      "commerce_quote_events_read_organization_manager_subtree"
    ]) {
      expect(migration).toContain(`create policy ${policy}`);
      const policySql = migration.match(
        new RegExp(`create policy ${policy}[\\s\\S]*?\\n\\);`, "i")
      )?.[0];
      expect(policySql).toContain("for select to authenticated");
      expect(policySql).toContain("public.current_profile_role() = 'manager'");
      expect(policySql).not.toContain("service_role");
      expect(policySql).not.toContain("employee_compensation");
    }
    expect(migration).toContain("public.current_profile_role() = 'manager'");
    expect(migration).toContain("organization_is_descendant_v1(auth.uid(), id, true)");
    expect(migration).toContain("organization_is_descendant_v1(auth.uid(), seller_id, true)");
    expect(migration).toContain("organization_is_descendant_v1(auth.uid(), quote.seller_id, true)");
    expect(migration).toContain("create policy employee_compensation_read_privileged");
    expect(migration).toContain("using (public.organization_can_read_compensation_v1())");
  });

  it("keeps one canonical business-rank vocabulary and synchronizes the authorization claim", () => {
    for (const rank of [
      "owner", "executive", "director", "manager", "salesperson",
      "sourcing_manager", "sourcing_specialist", "individual_contributor"
    ]) {
      expect(migration).toContain(`'${rank}'`);
      expect(contracts).toContain(`"${rank}"`);
      expect(sharedTypes).toContain(`| "${rank}"`);
    }
    expect(migration).toContain("coalesce(profile.business_rank");
    expect(migration).toContain("create trigger organization_members_sync_business_rank_claim");
    expect(migration).toContain("set business_rank = new.business_rank");
    expect(migration).toContain("revoke all on function public.sync_organization_business_rank_claim_v1()");
    expect(sharedTypes).toContain('export type UserRole = "admin" | "manager" | "employee" | "super_admin_dev"');
    expect(sharedTypes).not.toMatch(/export type UserRole[^\n]*owner/);
    expect(sharedTypes).not.toMatch(/export type UserRole[^\n]*sourcing_manager/);
  });

  it("isolates read-only USD compensation behind its dedicated authorized endpoint", () => {
    expect(migration).toMatch(/currency text not null default 'USD' check \(currency = 'USD'\)/i);
    expect(migration).toContain("organization_can_read_compensation_v1");
    expect(tree).toContain("directory?.actor.canReadCompensation === true");
    expect(tree).toContain("/api/organization/compensation/");
    expect(tree).not.toContain("employee_compensation");
    expect(analyticsUi.toLowerCase()).not.toContain("salary");
    expect(analyticsUi.toLowerCase()).not.toContain("compensation");
    expect(compensationRoute).toContain("export async function GET");
    expect(compensationRoute).not.toContain("export async function PATCH");
    expect(compensationRoute).not.toContain("export async function POST");
  });

  it("uses the exact commercial labels and never labels quote value as revenue", () => {
    for (const label of [
      "Quotes Created",
      "Quotes Sent",
      "Quotes Accepted",
      "Quotes Rejected",
      "Quote Conversion Rate",
      "Quoted Value",
      "Accepted Quote Value",
      "Customers Served",
      "New Customers"
    ]) expect(analyticsUi).toContain(label);
    expect(analyticsUi.toLowerCase()).not.toContain("revenue");
  });
});
