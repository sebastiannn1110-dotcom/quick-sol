import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  process.cwd(),
  "supabase/migrations/20260829090000_commerce_backend_real.sql"
);
const sql = fs.readFileSync(migrationPath, "utf8");

describe("D3 commerce database contract", () => {
  it.each([
    "commerce_rfqs",
    "commerce_rfq_items",
    "commerce_client_details",
    "commerce_quotes",
    "commerce_quote_items",
    "commerce_quote_events",
    "commerce_quote_shares"
  ])("creates %s additively", (table) => {
    expect(sql).toContain(`create table if not exists public.${table}`);
  });

  it("adds client assignment without replacing clients", () => {
    expect(sql).toContain("alter table public.clients");
    expect(sql).toContain("assigned_salesperson_id uuid");
    expect(sql).not.toMatch(/drop\s+table\s+(if\s+exists\s+)?public\.clients/i);
  });

  it("keeps contact and delivery data behind a stricter commerce RLS boundary", () => {
    expect(sql).toContain("create table if not exists public.commerce_client_details");
    expect(sql).toContain("commerce_client_details_read_scoped");
    expect(sql).toContain("public.commerce_can_access_client(client_id)");
    const clientsAlter = sql.match(/alter table public\.clients([\s\S]*?);/)?.[1] ?? "";
    expect(clientsAlter).not.toContain("contact_email");
    expect(clientsAlter).not.toContain("commercial_notes");
  });

  it("creates and updates customer base/details atomically through RPCs", () => {
    expect(sql).toContain("create or replace function public.create_commerce_customer_v1");
    expect(sql).toContain("create or replace function public.update_commerce_customer_v1");
    expect(sql).toContain("grant execute on function public.create_commerce_customer_v1(jsonb) to authenticated");
  });

  it("makes base RFQ ingestion atomic and fingerprint-idempotent", () => {
    expect(sql).toContain("create or replace function public.ingest_commerce_rfq_v1");
    expect(sql).toContain("COMMERCE_RFQ_IDEMPOTENCY_CONFLICT");
    expect(sql).toContain("request_fingerprint");
    expect(sql).toContain("grant execute on function public.ingest_commerce_rfq_v1");
    expect(sql).toContain("to service_role");
  });

  it("recalculates snapshots and totals inside quote RPCs", () => {
    expect(sql).toContain("create or replace function public.create_commerce_quote_v1");
    expect(sql).toContain("product.authorized_unit_price");
    expect(sql).toContain("calculated_subtotal");
    expect(sql).toContain("calculated_tax");
    expect(sql).toContain("calculated_total");
    expect(sql).toContain("availability_revision");
  });

  it("uses optimistic concurrency and an immutable event ledger", () => {
    expect(sql).toContain("input_expected_version");
    expect(sql).toContain("COMMERCE_VERSION_CONFLICT");
    expect(sql).toContain("commerce_quote_events_immutable");
    expect(sql).toContain("COMMERCE_QUOTE_EVENT_IMMUTABLE");
  });

  it("stores only share token hashes and permits sharing only non-draft quotes", () => {
    expect(sql).toContain("create table if not exists public.commerce_quote_shares");
    expect(sql).toContain("token_hash text not null unique");
    expect(sql).not.toContain("share_token text");
    expect(sql).toContain("target_quote.status not in ('sent', 'accepted', 'rejected', 'expired')");
  });

  it("enables RLS and scopes quotes by seller/team/admin", () => {
    expect(sql).toContain("create or replace function public.commerce_can_access_seller");
    expect(sql).toContain("actor.department = seller.department");
    expect(sql).toContain("actor.region = seller.region");
    expect(sql).toContain("alter table public.commerce_quotes enable row level security");
    expect(sql).toContain("public.commerce_can_access_seller(seller_id)");
  });

  it("keeps the seller catalog free of cost, GP, margin, and supplier fields", () => {
    const catalogTable = sql.match(/create table if not exists public\.commerce_catalog_products \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(catalogTable).not.toMatch(/\bcost\b/i);
    expect(catalogTable).not.toMatch(/\bgp\b/i);
    expect(catalogTable).not.toMatch(/\bmargin\b/i);
    expect(catalogTable).not.toMatch(/\bsupplier\b/i);
    expect(catalogTable).toContain("authorized_unit_price");
  });

  it("does not create a sale, invoice, revenue, reservation, or order table", () => {
    expect(sql).not.toMatch(/create table[^;]+commerce_(sales|invoices|reservations|orders)\b/i);
  });

  it("does not alter protected R8 or Opportunity Finder objects", () => {
    expect(sql).not.toMatch(/alter\s+table\s+public\.opportunity_finder/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.update_profile_admin_v1/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.provision/i);
  });
});
