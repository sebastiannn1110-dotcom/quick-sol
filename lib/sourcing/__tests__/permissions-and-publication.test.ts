import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourcingOfferSchema } from "@/lib/sourcing/contracts";
import { canManageSourcing, sellerSafeApproval } from "@/lib/sourcing/permissions";
import { PUBLIC_CATALOG_APPROVAL_FIELDS, normalizePublicCatalogMpns, publicCatalogApproval } from "@/lib/sourcing/public-catalog";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260829100000_sourcing_workflow_and_of_adapter.sql"
);

describe("sourcing authorization and privacy boundary", () => {
  it("combines the stable technical role with a separate business rank", () => {
    expect(canManageSourcing({ role: "employee", business_rank: "sourcing_manager", is_active: true })).toBe(true);
    expect(canManageSourcing({ role: "admin", business_rank: "owner", is_active: true })).toBe(true);
    expect(canManageSourcing({ role: "manager", business_rank: "owner", is_active: true })).toBe(false);
    expect(canManageSourcing({ role: "super_admin_dev", business_rank: null, is_active: true })).toBe(true);
    expect(canManageSourcing({ role: "admin", business_rank: null, is_active: true })).toBe(false);
    expect(canManageSourcing({ role: "employee", business_rank: "salesperson", is_active: true })).toBe(false);
    expect(canManageSourcing({ role: "super_admin_dev", business_rank: null, is_active: false })).toBe(false);
  });

  it("seller projection excludes raw supplier, cost, documents and exact quantity", () => {
    const payload = sellerSafeApproval({
      id: "approval-1",
      sourcing_request_id: "request-1",
      sourcing_offer_id: "offer-1",
      mpn: "SN74LVC2G74",
      manufacturer: "Texas Instruments",
      authorized_unit_price: "1.25",
      currency: "USD",
      coarse_availability: "available",
      lead_time_days: 14,
      minimum_order_quantity: 100,
      valid_until: "2099-12-31T00:00:00.000Z",
      version: 2,
      updated_at: "2026-08-29T00:00:00.000Z",
      supplier_name: "PRIVATE SUPPLIER",
      raw_unit_cost: 0.4,
      available_quantity: 98765,
      storage_path: "private/document.pdf"
    });
    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).not.toContain("supplier");
    expect(serialized).not.toContain("cost");
    expect(serialized).not.toContain("availablequantity");
    expect(serialized).not.toContain("exactquantity");
    expect(serialized).not.toContain("storage");
    expect(payload.authorizedUnitPrice).toBe(1.25);
    expect(payload.coarseAvailability).toBe("available");
  });

  it("public projection has exactly the documented allow-list", () => {
    const payload = publicCatalogApproval({
      mpn: "SN74LVC2G74",
      authorized_unit_price: 1.25,
      currency: "USD",
      coarse_availability: "limited",
      lead_time_days: 21,
      minimum_order_quantity: 50,
      version: 3,
      updated_at: "2026-08-29T00:00:00.000Z",
      available_quantity: 1234,
      raw_unit_cost: 0.2,
      supplier_name: "SECRET"
    });
    expect(Object.keys(payload)).toEqual(PUBLIC_CATALOG_APPROVAL_FIELDS);
    expect(JSON.stringify(payload).toLowerCase()).not.toMatch(/supplier|cost|availablequantity|stock/);
    expect(normalizePublicCatalogMpns(new URLSearchParams("mpn=A-1&mpns=B-2,C-3"))).toEqual(["A-1", "B-2", "C-3"]);
  });
});

describe("sourcing schema and workflow contract", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  it("creates the four master tables and permits several offers for one MPN", () => {
    expect(sql).toContain("create table if not exists public.sourcing_requests");
    expect(sql).toContain("create table if not exists public.sourcing_offers");
    expect(sql).toContain("create table if not exists public.sourcing_offer_attachments");
    expect(sql).toContain("create table if not exists public.commercial_price_approvals");
    expect(sql).not.toContain("unique (sourcing_request_id, normalized_mpn)");
    expect(sql).toContain("sourcing_offers_request_mpn_idx");
    expect(sql).toContain("commerce_quote_item_id uuid references public.commerce_quote_items(id)");
    expect(sql).toContain("warehouse text");
    expect(sql).toContain("incoterm text");
    expect(sql).toContain("published_at timestamptz");
  });

  it("keeps raw tables private and private Storage behind sourcing authorization", () => {
    expect(sql).toContain("actor.business_rank = 'sourcing_manager'");
    expect(sql).toContain("actor.business_rank = 'owner'");
    expect(sql).toContain("profile_role_has_capability(actor.role, 'ADMIN')");
    expect(sql).toContain("actor.role = 'super_admin_dev'");
    expect(sql).toContain("alter table public.sourcing_offers force row level security");
    expect(sql).toContain("revoke all on table public.commercial_price_approvals from public, anon, authenticated");
    expect(sql).toContain("'sourcing-private', 'sourcing-private', false");
    expect(sql).toContain("create policy sourcing_private_select on storage.objects");
  });

  it("separates approval from explicit catalog publication", () => {
    const approvalBody = sql.split("create or replace function public.approve_sourcing_offer_v1")[1]
      .split("create or replace function public.reject_sourcing_offer_v1")[0];
    expect(approvalBody).toContain("false, locked_offer.expires_at");
    expect(approvalBody).toContain("publish_to_catalog = false");
    expect(sql).toContain("create or replace function public.set_commercial_price_publication_v1");
    expect(sql).toContain("set publish_to_catalog = input_publish_to_catalog");
    expect(sql).toContain("when input_publish_to_catalog then coalesce(published_at, now())");
    expect(sql).toContain("commercial_price_approval_id");
  });

  it("accepts independent offers with the same request and MPN", () => {
    const base = {
      supplierReference: "",
      mpn: "SN74LVC2G74",
      manufacturer: "TI",
      availableQuantity: 100,
      unitOfMeasure: "EA",
      rawUnitCost: 0.75,
      currency: "USD",
      leadTimeDays: 14,
      minimumOrderQuantity: 10,
      standardPackQuantity: null,
      dateCode: "",
      condition: "New",
      warehouse: "Hong Kong",
      incoterm: "FOB",
      countryOfOrigin: "",
      expiresAt: "2099-12-31T00:00:00.000Z",
      notes: "",
      provenance: {}
    };
    expect(sourcingOfferSchema.safeParse({ ...base, supplierName: "Supplier A" }).success).toBe(true);
    expect(sourcingOfferSchema.safeParse({ ...base, supplierName: "Supplier B", rawUnitCost: 0.8 }).success).toBe(true);
  });

  it("reuses active sourcing before automation creates another RFQ request", () => {
    const service = fs.readFileSync(path.join(process.cwd(), "lib/sourcing/service.ts"), "utf8");
    expect(service).toContain('.eq("commerce_rfq_item_id", commerceRfqItemId)');
    expect(service).toContain('.in("status", ["open", "collecting_offers", "review"])');
    expect(service).toContain('from("commercial_price_approvals")');
    expect(service.indexOf('from("commercial_price_approvals")')).toBeLessThan(service.lastIndexOf('from("sourcing_requests").upsert'));
  });

  it("keeps the video Sourcing scene localized and exposes the OF adapter action", () => {
    const workspace = fs.readFileSync(path.join(process.cwd(), "components/sourcing/SourcingWorkspace.tsx"), "utf8");
    const adapterRoute = fs.readFileSync(path.join(
      process.cwd(), "app/api/sourcing/offers/[offerId]/of-adapter/route.ts"
    ), "utf8");
    expect(workspace).toContain("useLanguage");
    expect(workspace).toContain("es:");
    expect(workspace).toContain("en:");
    expect(workspace).toContain("zh:");
    expect(workspace).toContain("Send to Opportunity Finder");
    expect(workspace).toContain("发送到机会查找器");
    expect(workspace).toContain("/of-adapter");
    expect(workspace).toContain('action: "prepare"');
    expect(adapterRoute).toContain('z.literal("prepare")');
    expect(adapterRoute).toContain("approvedSourcingOfferToSupplierOffer");
    expect(adapterRoute).toContain("approved_by,version,created_at");
    expect(adapterRoute).not.toContain("matchOpportunityRows");
  });
});
