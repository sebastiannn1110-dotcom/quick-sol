import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { databaseErrorResponse } from "@/lib/commerce/http";
import { createCommerceQuoteFromRfq, quotePayload, rfqSummaryPayload } from "@/lib/commerce/service";

const migrationPath = path.resolve(
  process.cwd(),
  "supabase/migrations/20260830150000_commerce_rfq_workflow.sql"
);
const sql = fs.readFileSync(migrationPath, "utf8");
const baseCommerceSql = fs.readFileSync(path.resolve(
  process.cwd(),
  "supabase/migrations/20260829090000_commerce_backend_real.sql"
), "utf8");

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function section(start: string, end: string) {
  const startIndex = sql.indexOf(start);
  const endIndex = sql.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return sql.slice(startIndex, endIndex);
}

describe("Commerce RFQ workflow database contract", () => {
  it("uses exact admin, organization-subtree manager, and seller-self RFQ scope", () => {
    const sellerScope = section(
      "create or replace function public.commerce_can_access_seller",
      "create or replace function public.commerce_can_access_rfq_v2"
    );
    const rfqScope = section(
      "create or replace function public.commerce_can_access_rfq_v2",
      "-- Client write authority remains tied"
    );
    const policies = section(
      "drop policy if exists commerce_rfqs_read_scoped",
      "create or replace function public.mark_commerce_rfq_in_review_v2"
    );

    expect(sellerScope).toContain("actor.id = seller.id");
    expect(sellerScope).toContain("profile_role_has_capability(actor.role, 'ADMIN')");
    expect(sellerScope).toContain("organization_is_descendant_v1(actor.id, seller.id, true)");
    expect(rfqScope).toContain("rfq.assigned_salesperson_id is not null");
    expect(rfqScope).toContain("commerce_can_access_seller(rfq.assigned_salesperson_id)");
    expect(policies).toContain("using (public.commerce_can_access_rfq_v2(id))");
    expect(policies).toContain("using (public.commerce_can_access_rfq_v2(rfq_id))");
    expect(policies).not.toContain("can_manage_clients");
  });

  it("deliberately leaves unassigned RFQs in the technical-admin triage scope", () => {
    const rfqScope = section(
      "create or replace function public.commerce_can_access_rfq_v2",
      "-- Client write authority remains tied"
    );
    expect(rfqScope).toContain("profile_role_has_capability(actor.role, 'ADMIN')");
    expect(rfqScope).toContain("rfq.assigned_salesperson_id is not null");
    expect(rfqScope).not.toMatch(/actor\.role\s*=\s*'manager'[\s\S]*assigned_salesperson_id\s+is\s+null/i);
  });

  it("permits assignment only for global admins or managers inside the exact subtree", () => {
    const assignment = section(
      "create or replace function public.assign_commerce_rfq_seller_v2",
      "create or replace function public.list_commerce_assignable_sellers_v2"
    );
    expect(assignment).toContain("actor_profile.role <> 'manager'");
    expect(assignment).toContain("COMMERCE_RFQ_ASSIGN_FORBIDDEN");
    expect(assignment).toContain("organization_is_descendant_v1(actor_profile.id, target_seller.id, true)");
    expect(assignment).toContain("COMMERCE_SELLER_OUTSIDE_SCOPE");
    expect(assignment).toContain("'owner', 'executive', 'director', 'manager', 'salesperson'");
    expect(assignment).toContain("status = case when status = 'unassigned' then 'assigned' else status end");
  });

  it("separates RFQ-local client reads from account-wide client management", () => {
    const manageScope = section(
      "create or replace function public.commerce_can_manage_client_v2",
      "-- Reassignment is intentionally RFQ-local",
    );
    const readScope = section(
      "create or replace function public.commerce_can_read_client_v2",
      "-- Historical write RPCs call this function"
    );
    const compatibilityScope = section(
      "create or replace function public.commerce_can_access_client",
      "create or replace function public.list_commerce_manageable_client_ids_v2"
    );
    const clientPolicy = section(
      "drop policy if exists commerce_client_details_read_scoped",
      "drop policy if exists commerce_rfqs_read_scoped"
    );

    expect(manageScope).not.toContain("client.assigned_salesperson_id is null");
    expect(manageScope).toContain("profile_role_has_capability(actor.role, 'ADMIN')");
    expect(manageScope).toContain("commerce_can_access_seller(client.assigned_salesperson_id)");
    expect(manageScope).not.toContain("linked_rfq");
    expect(readScope).toContain("linked_rfq.client_id = client.id");
    expect(readScope).toContain("commerce_can_access_rfq_v2(linked_rfq.id)");
    expect(compatibilityScope).toContain("commerce_can_manage_client_v2(target_client_id)");
    expect(compatibilityScope).not.toContain("linked_rfq");
    expect(clientPolicy).toContain("using (public.commerce_can_manage_client_v2(client_id))");
    expect(clientPolicy).not.toContain("commerce_can_read_client_v2(client_id)");
  });

  it("keeps clients without an assigned owner admin-only", () => {
    const manageScope = section(
      "create or replace function public.commerce_can_manage_client_v2",
      "-- Reassignment is intentionally RFQ-local"
    );
    expect(manageScope).toContain("profile_role_has_capability(actor.role, 'ADMIN')");
    expect(manageScope).not.toContain("client.assigned_salesperson_id is null");
    expect(manageScope).not.toMatch(/actor\.role\s*=\s*'manager'/);
  });

  it("prevents direct-table client ownership takeover by managers", () => {
    const policies = section(
      "drop policy if exists clients_insert_manager",
      "drop policy if exists commerce_client_details_read_scoped"
    );
    const adminClientsRoute = source("app/api/admin/clients/route.ts");
    expect(policies).toContain("create policy clients_insert_manager");
    expect(policies).toContain("created_by = auth.uid()");
    expect(policies).toContain("create policy clients_update_manager");
    expect(policies).toContain("using (");
    expect(policies).toContain("with check (");
    expect(policies.match(/public\.is_admin\(\)/g)).toHaveLength(3);
    expect(policies.match(/assigned_salesperson_id is not null/g)).toHaveLength(3);
    expect(policies.match(/commerce_can_access_seller\(assigned_salesperson_id\)/g)).toHaveLength(3);
    expect(adminClientsRoute).toContain(
      'assigned_salesperson_id: context.profile.role === "manager" ? context.profile.id : null'
    );
  });

  it("keeps inherited customer RPCs on the hardened ownership boundary", () => {
    const createStart = baseCommerceSql.indexOf("create or replace function public.create_commerce_customer_v1");
    const updateStart = baseCommerceSql.indexOf("create or replace function public.update_commerce_customer_v1");
    const quoteStart = baseCommerceSql.indexOf("create or replace function public.create_commerce_quote_v1");
    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(updateStart).toBeGreaterThan(createStart);
    expect(quoteStart).toBeGreaterThan(updateStart);
    expect(baseCommerceSql.slice(createStart, updateStart)).toContain(
      "'active', actor_profile.id, actor_profile.id, actor_profile.id"
    );
    expect(baseCommerceSql.slice(updateStart, quoteStart)).toContain(
      "commerce_can_access_client(locked_client.id)"
    );
    const compatibilityScope = section(
      "create or replace function public.commerce_can_access_client",
      "create or replace function public.list_commerce_manageable_client_ids_v2"
    );
    expect(compatibilityScope).toContain("commerce_can_manage_client_v2(target_client_id)");
  });

  it("creates a prospect client once under an RFQ row lock and links it atomically", () => {
    const conversion = section(
      "create or replace function public.create_commerce_client_from_rfq_v2",
      "-- Generic quote creation is intentionally limited"
    );
    expect(conversion).toContain("for update");
    expect(conversion).toContain("if locked_rfq.client_id is not null then");
    expect(conversion).toContain("'idempotent', true");
    expect(conversion).toContain("locked_rfq.status not in ('unassigned', 'assigned', 'in_review')");
    expect(conversion).toContain("snapshot := locked_rfq.contact_snapshot");
    expect(conversion).toContain("insert into public.clients");
    expect(conversion).toContain("insert into public.commerce_client_details");
    expect(conversion).toContain("set client_id = created_client.id");
    expect(conversion).toContain("'idempotent', false");
    expect(source("lib/commerce/service.ts")).toContain(
      '["unassigned", "assigned", "in_review"].includes(summary.status)'
    );
  });

  it("rejects every RFQ id from generic quote creation", () => {
    const genericQuote = section(
      "create or replace function public.create_commerce_quote_v2",
      "create or replace function public.update_commerce_quote_v2"
    );
    expect(genericQuote).toContain("if input_rfq_id is not null then");
    expect(genericQuote).toContain("COMMERCE_RFQ_WORKFLOW_REQUIRED");
    expect(genericQuote).toContain("commerce_can_manage_client_v2(input_client_id)");
    expect(genericQuote).not.toContain("commerce_can_access_rfq_v2(input_rfq_id)");
    expect(genericQuote).not.toContain("update public.commerce_rfqs");
  });

  it("prefills quote lines from RFQ quantities and never invents unresolved pricing", () => {
    const createFromRfq = section(
      "create or replace function public.create_commerce_quote_from_rfq_v2",
      "revoke all on function public.mark_commerce_rfq_in_review_v2"
    );
    expect(createFromRfq).toContain("upper(trim(candidate.mpn)) = upper(trim(rfq_item.mpn))");
    expect(createFromRfq).toContain("upper(trim(candidate.manufacturer)) = upper(trim(rfq_item.manufacturer))");
    expect(createFromRfq).toContain("'reason', 'catalog_not_found'");
    expect(createFromRfq).toContain("'reason', 'catalog_match_ambiguous'");
    expect(createFromRfq).toContain("'reason', 'authorized_price_unavailable'");
    expect(createFromRfq).toContain("'reason', 'minimum_order_quantity'");
    expect(createFromRfq).toContain("'quantity', rfq_item.quantity");
    expect(createFromRfq).toContain("'authorizedUnitPrice', product.authorized_unit_price");
    expect(createFromRfq).toContain("'productId', null");
    expect(createFromRfq).toContain("'authorizedUnitPrice', 0");
    expect(createFromRfq).toContain("resolved_items := resolved_items || jsonb_build_array(resolved_item)");
    expect(createFromRfq).toContain("(resolved_item->>'productId')::uuid");
    expect(createFromRfq).toContain("'pricingRequired', pricing_required");
    expect(createFromRfq).not.toContain("if jsonb_array_length(pricing_required) > 0 then");
    expect(createFromRfq).not.toContain("'quoteId', null");
  });

  it("inherits the RFQ seller and marks quoted only after the full quote is persisted", () => {
    const createFromRfq = section(
      "create or replace function public.create_commerce_quote_from_rfq_v2",
      "revoke all on function public.mark_commerce_rfq_in_review_v2"
    );
    expect(createFromRfq).toContain("coalesce(locked_rfq.assigned_salesperson_id, actor_profile.id)");
    const quoteInsert = createFromRfq.indexOf("insert into public.commerce_quotes");
    const itemInsert = createFromRfq.indexOf("insert into public.commerce_quote_items");
    const eventInsert = createFromRfq.indexOf("insert into public.commerce_quote_events");
    const statusUpdate = createFromRfq.lastIndexOf("update public.commerce_rfqs");
    expect(quoteInsert).toBeGreaterThanOrEqual(0);
    expect(itemInsert).toBeGreaterThan(quoteInsert);
    expect(eventInsert).toBeGreaterThan(itemInsert);
    expect(statusUpdate).toBeGreaterThan(eventInsert);
    expect(createFromRfq.slice(statusUpdate)).toContain("set status = 'quoted'");
  });

  it("validates an existing RFQ quote before returning an idempotent retry", () => {
    const createFromRfq = section(
      "create or replace function public.create_commerce_quote_from_rfq_v2",
      "revoke all on function public.mark_commerce_rfq_in_review_v2"
    );
    expect(createFromRfq).toContain("select count(*) into existing_quote_count");
    expect(createFromRfq).toContain("if existing_quote_count > 1 then");
    expect(createFromRfq).toContain("existing_quote_client_id is distinct from locked_rfq.client_id");
    expect(createFromRfq).toContain("existing_quote_seller_id is distinct from locked_rfq.assigned_salesperson_id");
    expect(createFromRfq).toContain("COMMERCE_RFQ_QUOTE_INTEGRITY");
    expect(createFromRfq).toContain("where quote.rfq_id = locked_rfq.id");
    expect(createFromRfq).toContain("'quoteId', existing_quote_id");
    expect(createFromRfq).toContain("'idempotent', true");
    expect(createFromRfq).toContain("existing_quote_item_count <> rfq_item_count");
    expect(createFromRfq).toContain("existing_quote_item.product_id is null");
    expect(createFromRfq).toContain("'reason', 'pricing_required'");
    const integrityCheck = createFromRfq.indexOf("existing_quote_client_id is distinct");
    const retryStatusUpdate = createFromRfq.indexOf("assigned_salesperson_id = coalesce", integrityCheck);
    expect(integrityCheck).toBeGreaterThanOrEqual(0);
    expect(retryStatusUpdate).toBeGreaterThan(integrityCheck);
  });

  it("allows new RFQ quotes only from assigned or in-review requests", () => {
    const createFromRfq = section(
      "create or replace function public.create_commerce_quote_from_rfq_v2",
      "revoke all on function public.mark_commerce_rfq_in_review_v2"
    );
    const service = source("lib/commerce/service.ts");
    expect(createFromRfq).toContain("locked_rfq.status not in ('assigned', 'in_review')");
    expect(createFromRfq).toContain("if locked_rfq.status = 'cancelled' then");
    expect(service).toContain('["assigned", "in_review"].includes(summary.status)');
    const createQuoteAction = service.slice(
      service.indexOf("createQuote: summary.clientId"),
      service.indexOf("}\n  };", service.indexOf("createQuote: summary.clientId"))
    );
    expect(createQuoteAction).not.toContain("pricingReady");
  });

  it("keeps an RFQ quote origin immutable during draft edits", () => {
    const updateQuote = section(
      "create or replace function public.update_commerce_quote_v2",
      "create or replace function public.transition_commerce_quote_v2"
    );
    expect(updateQuote).toContain("input_rfq_id is distinct from locked_quote.rfq_id");
    expect(updateQuote).toContain("COMMERCE_QUOTE_RFQ_IMMUTABLE");
    expect(updateQuote).toContain("input_client_id is distinct from locked_quote.client_id");
    expect(updateQuote).toContain("COMMERCE_QUOTE_CLIENT_IMMUTABLE");
    expect(updateQuote).toContain("commerce_can_access_rfq_v2(locked_quote.rfq_id)");
    expect(updateQuote).toContain("rfq.client_id = locked_quote.client_id");
    expect(updateQuote).toContain("commerce_can_read_client_v2(input_client_id)");
    expect(updateQuote).toContain("commerce_can_manage_client_v2(input_client_id)");
    expect(source("lib/commerce/service.ts")).toContain('supabase.rpc("update_commerce_quote_v2"');
  });

  it("rejects adding or removing RFQ quote lines before deleting persisted items", () => {
    const updateQuote = section(
      "create or replace function public.update_commerce_quote_v2",
      "create or replace function public.transition_commerce_quote_v2"
    );
    const validationIndex = updateQuote.indexOf("select count(*) into persisted_item_count");
    const deleteIndex = updateQuote.indexOf("delete from public.commerce_quote_items");
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(updateQuote).toContain("persisted_item_count <> jsonb_array_length(input_items)");
    expect(updateQuote).toContain("rfq_item_count <> persisted_item_count");
    expect(updateQuote).toContain("COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE");
    expect(deleteIndex).toBeGreaterThan(validationIndex);
  });

  it("rejects product substitution or reordering in an RFQ quote", () => {
    const updateQuote = section(
      "create or replace function public.update_commerce_quote_v2",
      "create or replace function public.transition_commerce_quote_v2"
    );
    expect(updateQuote).toContain("order by item.line_number");
    expect(updateQuote).toContain("requested_item := input_items -> (item_index - 1)");
    expect(updateQuote).toContain("requested_product_id is distinct from persisted_item.product_id");
    expect(updateQuote).toContain("persisted_item.line_number <> item_index");
    expect(updateQuote).toContain("candidate.id = persisted_item.product_id");
    expect(updateQuote).toContain("upper(trim(persisted_item.mpn)) is distinct from upper(trim(linked_rfq_item.mpn))");
  });

  it("preserves null RFQ lines and only re-resolves them from the RFQ snapshot", () => {
    const updateQuote = section(
      "create or replace function public.update_commerce_quote_v2",
      "create or replace function public.transition_commerce_quote_v2"
    );
    expect(updateQuote).toContain("if requested_product_id is null then");
    expect(updateQuote).toContain("if locked_quote.rfq_id is null then");
    expect(updateQuote).toContain("upper(trim(candidate.mpn)) = upper(trim(linked_rfq_item.mpn))");
    expect(updateQuote).toContain("upper(trim(candidate.manufacturer)) = upper(trim(linked_rfq_item.manufacturer))");
    expect(updateQuote).toContain("locked_quote.id, item_index, null, linked_rfq_item.mpn");
    expect(updateQuote).toContain("0, 0, 0, 'USD', 0, 1");
    expect(updateQuote.indexOf("COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE"))
      .toBeLessThan(updateQuote.indexOf("delete from public.commerce_quote_items"));
  });

  it("keeps quantity and discount editable when RFQ line structure matches", () => {
    const updateQuote = section(
      "create or replace function public.update_commerce_quote_v2",
      "create or replace function public.transition_commerce_quote_v2"
    );
    const immutableStart = updateQuote.indexOf("-- An RFQ-origin quote may change quantities");
    const immutableEnd = updateQuote.indexOf("maximum_discount := case", immutableStart);
    const immutableCheck = updateQuote.slice(immutableStart, immutableEnd);
    expect(immutableStart).toBeGreaterThanOrEqual(0);
    expect(immutableEnd).toBeGreaterThan(immutableStart);
    expect(immutableCheck).not.toContain("requested_quantity");
    expect(immutableCheck).not.toContain("requested_discount");
    expect(updateQuote.slice(immutableEnd)).toContain("requested_quantity :=");
    expect(updateQuote.slice(immutableEnd)).toContain("requested_discount :=");
  });

  it("does not let a null expected version bypass optimistic locking", () => {
    const quoteWrites = section(
      "create or replace function public.update_commerce_quote_v2",
      "create or replace function public.create_commerce_quote_from_rfq_v2"
    );
    expect(quoteWrites.match(/version is distinct from input_expected_version/g)).toHaveLength(2);
    expect(quoteWrites).not.toContain("version <> input_expected_version");
  });

  it("blocks sending a draft that has no authorized pricing", () => {
    const transition = section(
      "create or replace function public.transition_commerce_quote_v2",
      "create or replace function public.create_commerce_quote_from_rfq_v2"
    );
    expect(transition).toContain("input_new_status = 'sent'");
    expect(transition).toContain("locked_quote.valid_until < current_date");
    expect(transition).toContain("COMMERCE_QUOTE_VALIDITY_EXPIRED");
    expect(transition).toContain("for share of product");
    expect(transition).toContain("item.product_id is null");
    expect(transition).toContain("item.authorized_unit_price <= 0");
    expect(transition).toContain("product.is_active = true");
    expect(transition).toContain("product.revision is not distinct from item.availability_revision");
    expect(transition).toContain("product.authorized_unit_price is not distinct from item.authorized_unit_price");
    expect(transition).toContain("item.quantity >= product.minimum_order_quantity");
    expect(transition).toContain("COMMERCE_QUOTE_PRICING_REQUIRED");
    expect(source("lib/commerce/service.ts")).toContain('supabase.rpc("transition_commerce_quote_v2"');
  });

  it("grants workflow RPCs only to authenticated sessions", () => {
    const grants = section(
      "revoke all on function public.mark_commerce_rfq_in_review_v2",
      "comment on function public.commerce_can_access_rfq_v2"
    );
    expect(grants).toContain("from public, anon");
    expect(grants).toContain("to authenticated");
    expect(grants).not.toMatch(/grant execute[^;]+to service_role/i);
  });

  it("keeps legacy quote RPCs rollout-compatible without preserving a v1 bypass", () => {
    const wrappers = section(
      "-- Compatibility wrappers keep migration-before-deploy safe",
      "revoke all on function public.mark_commerce_rfq_in_review_v2"
    );
    expect(wrappers).toContain("create or replace function public.create_commerce_quote_v1");
    expect(wrappers).toContain("select public.create_commerce_quote_v2");
    expect(wrappers).toContain("create or replace function public.update_commerce_quote_v1");
    expect(wrappers).toContain("select public.update_commerce_quote_v2");
    expect(wrappers).toContain("create or replace function public.transition_commerce_quote_v1");
    expect(wrappers).toContain("select public.transition_commerce_quote_v2");
    expect(wrappers.match(/security invoker/g)).toHaveLength(3);
  });
});

describe("Commerce RFQ API allowlists", () => {
  it("returns the inbox fields without leaking the contact snapshot or internal fingerprint", () => {
    const summary = rfqSummaryPayload({
      id: "11111111-1111-4111-8111-111111111111",
      external_rfq_id: "WEB-RFQ-001",
      request_fingerprint: "secret-fingerprint",
      client_id: "22222222-2222-4222-8222-222222222222",
      assigned_salesperson_id: "33333333-3333-4333-8333-333333333333",
      status: "assigned",
      source: "quiksol-web",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      contact_snapshot: {
        companyOrName: "Amazon-demo",
        contact: "Demo Contact",
        email: "private@example.invalid",
        phone: "+57 000",
        country: "Colombia",
        notes: "private note"
      },
      client: { id: "22222222-2222-4222-8222-222222222222", name: "Amazon-demo" },
      seller: {
        id: "33333333-3333-4333-8333-333333333333",
        full_name: "Maya Torres",
        email: "maya@example.invalid"
      },
      items: [
        { id: "44444444-4444-4444-8444-444444444444", line_number: 1, mpn: "TL082CDT", quantity: 12 }
      ]
    });

    expect(summary).toMatchObject({
      externalRfqId: "WEB-RFQ-001",
      companyOrName: "Amazon-demo",
      contactName: "Demo Contact",
      country: "Colombia",
      itemCount: 1,
      primaryItem: { mpn: "TL082CDT", quantity: 12 },
      assignedSeller: { fullName: "Maya Torres" }
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("private@example.invalid");
    expect(serialized).not.toContain("private note");
    expect(serialized).not.toContain("secret-fingerprint");
    expect(serialized).not.toContain("maya@example.invalid");
  });

  it("keeps client activity on cookie auth and the exact database permission helper", () => {
    const route = source("app/api/clients/[clientId]/commerce/route.ts");
    const service = source("lib/commerce/service.ts");
    expect(route).toContain("getAuthContext(request)");
    expect(route).not.toContain("requireCommerceAuth");
    expect(service).toContain('supabase.rpc("commerce_can_read_client_v2"');
    expect(service).toContain('new URLSearchParams({ clientId, limit: "5" })');
    expect(service).toContain("listCommerceQuotes(supabase, 5, clientId)");
  });

  it("uses a manage-only client id RPC instead of legacy department or region filters", () => {
    const service = source("lib/commerce/service.ts");
    const manageableIds = section(
      "create or replace function public.list_commerce_manageable_client_ids_v2",
      "revoke all on function public.commerce_can_access_rfq_v2"
    );
    expect(service).toContain('.rpc("list_commerce_manageable_client_ids_v2")');
    expect(service).not.toContain("teamSellerIds");
    expect(service).not.toContain("canAccessSeller");
    expect(manageableIds).toContain("commerce_can_manage_client_v2(client.id)");
    expect(manageableIds).not.toContain("commerce_can_read_client_v2(client.id)");
  });

  it("does not expose supplier-offer identifiers in quote queries or payloads", () => {
    const payload = quotePayload({
      id: "11111111-1111-4111-8111-111111111111",
      quote_number: "QKS-000001",
      rfq_id: null,
      client_id: "22222222-2222-4222-8222-222222222222",
      seller_id: "33333333-3333-4333-8333-333333333333",
      status: "draft",
      currency: "USD",
      subtotal: 12,
      tax_rate: 0,
      tax: 0,
      total: 12,
      valid_until: "2030-01-01",
      notes: "",
      commercial_terms: "",
      version: 1,
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
      customer: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Amazon-demo",
        created_at: "2026-08-30T00:00:00.000Z",
        created_by: "33333333-3333-4333-8333-333333333333"
      },
      seller: { full_name: "Maya Torres" },
      items: [{
        product_id: "44444444-4444-4444-8444-444444444444",
        mpn: "TL082CDT",
        manufacturer: "STMicroelectronics",
        description: "Op amp",
        quantity: 1,
        authorized_unit_price: 12,
        seller_unit_price: 12,
        discount_percent: 0,
        line_total: 12,
        availability_revision: 1,
        sourcing_offer_id: "55555555-5555-4555-8555-555555555555"
      }]
    });
    const service = source("lib/commerce/service.ts");
    const serialized = JSON.stringify(payload);
    expect(payload.items[0]).not.toHaveProperty("sourcingOfferId");
    expect(service).not.toContain("sourcing_offer_id");
    expect(serialized).not.toMatch(/sourcing|supplier|unitCost|margin/i);
  });

  it("removes direct authenticated SELECT access to supplier quote-line linkage", () => {
    const permissions = section(
      "revoke select on table public.commerce_quote_items from authenticated",
      "drop policy if exists commerce_rfqs_read_scoped"
    );
    expect(permissions).toContain("quote_id");
    expect(permissions).toContain("availability_revision");
    expect(permissions).not.toContain("sourcing_offer_id");
  });

  it("rejects RFQ ids from the generic quote endpoint", () => {
    const route = source("app/api/commerce/quotes/route.ts");
    expect(route).toContain("parsed.data.rfqId != null");
    expect(route).toContain("Create quotes linked to an RFQ through the RFQ workflow.");
  });

  it("loads the persisted RFQ draft even when pricing is still required", async () => {
    const quoteId = "66666666-6666-4666-8666-666666666666";
    const rpc = vi.fn(async () => ({
      data: {
        quoteId,
        idempotent: false,
        pricingRequired: [{ lineNumber: 1, mpn: "UNKNOWN-DEMO", reason: "catalog_not_found" }]
      },
      error: null
    }));
    const maybeSingle = vi.fn(async () => ({
      data: {
        id: quoteId,
        quote_number: "QKS-000777",
        rfq_id: "11111111-1111-4111-8111-111111111111",
        client_id: "22222222-2222-4222-8222-222222222222",
        seller_id: "33333333-3333-4333-8333-333333333333",
        status: "draft",
        currency: "USD",
        subtotal: 0,
        tax_rate: 7,
        tax: 0,
        total: 0,
        valid_until: "2030-01-01",
        notes: "",
        commercial_terms: "",
        version: 1,
        created_at: "2026-08-30T00:00:00.000Z",
        updated_at: "2026-08-30T00:00:00.000Z",
        customer: {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Amazon-demo",
          created_at: "2026-08-30T00:00:00.000Z",
          created_by: "33333333-3333-4333-8333-333333333333"
        },
        seller: { full_name: "Maya Torres" },
        items: [{
          line_number: 1,
          product_id: null,
          mpn: "UNKNOWN-DEMO",
          manufacturer: "",
          description: "Unresolved line",
          quantity: 10,
          authorized_unit_price: 0,
          seller_unit_price: 0,
          discount_percent: 0,
          line_total: 0,
          availability_revision: 1
        }]
      },
      error: null
    }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const supabase = { rpc, from } as unknown as SupabaseClient;

    const result = await createCommerceQuoteFromRfq(
      supabase,
      "11111111-1111-4111-8111-111111111111",
      { validUntil: "2030-01-01", notes: "", commercialTerms: "", taxRate: 7 }
    );
    expect(result).toMatchObject({
      quote: {
        id: quoteId,
        rfqId: "11111111-1111-4111-8111-111111111111",
        items: [{
          productId: null,
          authorizedUnitPrice: 0,
          sellerUnitPrice: 0,
          lineSubtotal: 0,
          availabilityRevision: null
        }]
      },
      idempotent: false,
      pricingRequired: [{ lineNumber: 1, mpn: "UNKNOWN-DEMO", reason: "catalog_not_found" }]
    });
    expect(rpc).toHaveBeenCalledWith("create_commerce_quote_from_rfq_v2", {
      input_rfq_id: "11111111-1111-4111-8111-111111111111",
      input_valid_until: "2030-01-01",
      input_notes: "",
      input_commercial_terms: "",
      input_tax_rate: 7
    });
    expect(from).toHaveBeenCalledWith("commerce_quotes");
    expect(maybeSingle).toHaveBeenCalledOnce();
  });

  it("maps an RFQ/client mismatch to a stable non-500 response", async () => {
    const response = databaseErrorResponse({ message: "COMMERCE_RFQ_CLIENT_MISMATCH" });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", status: 422 }
    });
  });

  it.each([
    "COMMERCE_RFQ_WORKFLOW_REQUIRED",
    "COMMERCE_RFQ_QUOTE_INTEGRITY",
    "COMMERCE_QUOTE_CLIENT_IMMUTABLE",
    "COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE"
  ])("maps %s to a stable validation response", async (message) => {
    const response = databaseErrorResponse({ message });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", status: 422 }
    });
  });

  it("maps an expired validity date to a stable transition response", async () => {
    const response = databaseErrorResponse({ message: "COMMERCE_QUOTE_VALIDITY_EXPIRED" });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_TRANSITION", status: 422 }
    });
  });

  it("maps missing authorized pricing to a stable Send-blocking response", async () => {
    const response = databaseErrorResponse({ message: "COMMERCE_QUOTE_PRICING_REQUIRED" });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PRICING_REQUIRED", status: 422 }
    });
  });
});
