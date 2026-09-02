import type { SupabaseClient } from "@supabase/supabase-js";
import { mpnIdentity, safeContextText } from "@/lib/opportunity-finder/normalization";
import type { SourcingOfferInput, SourcingRequestInput } from "@/lib/sourcing/contracts";

type DatabaseRow = Record<string, unknown>;

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sourcingOfferPayload(row: DatabaseRow) {
  return {
    id: String(row.id),
    requestId: String(row.sourcing_request_id),
    mpn: String(row.mpn ?? ""),
    normalizedMpn: String(row.normalized_mpn ?? ""),
    manufacturer: typeof row.manufacturer === "string" ? row.manufacturer : null,
    supplierName: String(row.supplier_name ?? ""),
    supplierReference: typeof row.supplier_reference === "string" ? row.supplier_reference : null,
    availableQuantity: numeric(row.available_quantity),
    unitOfMeasure: typeof row.unit_of_measure === "string" ? row.unit_of_measure : null,
    rawUnitCost: numeric(row.raw_unit_cost),
    currency: String(row.currency ?? "USD"),
    leadTimeDays: row.lead_time_days == null ? null : numeric(row.lead_time_days),
    minimumOrderQuantity: numeric(row.minimum_order_quantity) || 1,
    standardPackQuantity: row.standard_pack_quantity == null ? null : numeric(row.standard_pack_quantity),
    dateCode: typeof row.date_code === "string" ? row.date_code : null,
    condition: typeof row.condition === "string" ? row.condition : null,
    warehouse: typeof row.warehouse === "string" ? row.warehouse : null,
    incoterm: typeof row.incoterm === "string" ? row.incoterm : null,
    countryOfOrigin: typeof row.country_of_origin === "string" ? row.country_of_origin : null,
    expiresAt: String(row.expires_at),
    status: String(row.status),
    notes: String(row.notes ?? ""),
    provenance: row.provenance && typeof row.provenance === "object"
      ? row.provenance as Record<string, unknown>
      : {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function commercialApprovalPayload(row: DatabaseRow) {
  return {
    id: String(row.id),
    requestId: String(row.sourcing_request_id),
    sourcingOfferId: String(row.sourcing_offer_id),
    mpn: String(row.mpn ?? ""),
    normalizedMpn: String(row.normalized_mpn ?? ""),
    manufacturer: typeof row.manufacturer === "string" ? row.manufacturer : null,
    authorizedUnitPrice: numeric(row.authorized_unit_price),
    currency: String(row.currency ?? "USD"),
    coarseAvailability: String(row.coarse_availability ?? "contact_us"),
    leadTimeDays: row.lead_time_days == null ? null : numeric(row.lead_time_days),
    minimumOrderQuantity: numeric(row.minimum_order_quantity) || 1,
    status: String(row.status),
    publishToCatalog: row.publish_to_catalog === true,
    publishedAt: typeof row.published_at === "string" ? row.published_at : null,
    validUntil: String(row.valid_until),
    version: numeric(row.version) || 1,
    updatedAt: String(row.updated_at)
  };
}

export async function listSourcingWorkspace(service: SupabaseClient) {
  const [requestsResult, offersResult, attachmentsResult, approvalsResult] = await Promise.all([
    service.from("sourcing_requests").select("*").order("created_at", { ascending: false }).limit(250),
    service.from("sourcing_offers").select("*").order("created_at", { ascending: false }).limit(1000),
    service.from("sourcing_offer_attachments").select("id,sourcing_request_id,sourcing_offer_id,original_file_name,mime_type,size_bytes,created_at").order("created_at", { ascending: false }).limit(1000),
    service.from("commercial_price_approvals").select("*").order("created_at", { ascending: false }).limit(1000)
  ]);
  const error = requestsResult.error ?? offersResult.error ?? attachmentsResult.error ?? approvalsResult.error;
  if (error) throw error;

  const offersByRequest = new Map<string, ReturnType<typeof sourcingOfferPayload>[]>();
  for (const raw of (offersResult.data ?? []) as unknown as DatabaseRow[]) {
    const offer = sourcingOfferPayload(raw);
    const values = offersByRequest.get(offer.requestId) ?? [];
    values.push(offer);
    offersByRequest.set(offer.requestId, values);
  }
  const approvalsByRequest = new Map<string, ReturnType<typeof commercialApprovalPayload>[]>();
  for (const raw of (approvalsResult.data ?? []) as unknown as DatabaseRow[]) {
    const approval = commercialApprovalPayload(raw);
    const values = approvalsByRequest.get(approval.requestId) ?? [];
    values.push(approval);
    approvalsByRequest.set(approval.requestId, values);
  }
  const attachmentsByRequest = new Map<string, Array<Record<string, unknown>>>();
  for (const raw of (attachmentsResult.data ?? []) as unknown as DatabaseRow[]) {
    const requestId = String(raw.sourcing_request_id);
    const values = attachmentsByRequest.get(requestId) ?? [];
    values.push({
      id: String(raw.id),
      requestId,
      sourcingOfferId: typeof raw.sourcing_offer_id === "string" ? raw.sourcing_offer_id : null,
      fileName: String(raw.original_file_name),
      mimeType: typeof raw.mime_type === "string" ? raw.mime_type : null,
      sizeBytes: numeric(raw.size_bytes),
      createdAt: String(raw.created_at)
    });
    attachmentsByRequest.set(requestId, values);
  }

  return ((requestsResult.data ?? []) as unknown as DatabaseRow[]).map((row) => {
    const id = String(row.id);
    return {
      id,
      commerceRfqId: typeof row.commerce_rfq_id === "string" ? row.commerce_rfq_id : null,
      commerceRfqItemId: typeof row.commerce_rfq_item_id === "string" ? row.commerce_rfq_item_id : null,
      commerceQuoteItemId: typeof row.commerce_quote_item_id === "string" ? row.commerce_quote_item_id : null,
      source: String(row.source),
      mpn: String(row.mpn),
      normalizedMpn: String(row.normalized_mpn),
      manufacturer: typeof row.manufacturer === "string" ? row.manufacturer : null,
      requestedQuantity: numeric(row.requested_quantity),
      unitOfMeasure: typeof row.unit_of_measure === "string" ? row.unit_of_measure : null,
      customerContext: typeof row.customer_context === "string" ? row.customer_context : null,
      priority: String(row.priority),
      status: String(row.status),
      notes: String(row.notes ?? ""),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      offers: offersByRequest.get(id) ?? [],
      approvals: approvalsByRequest.get(id) ?? [],
      attachments: attachmentsByRequest.get(id) ?? []
    };
  });
}

export async function createSourcingRequest(
  supabase: SupabaseClient,
  actorId: string,
  input: SourcingRequestInput
) {
  const mpn = mpnIdentity(input.mpn);
  if (!mpn.normalizedMpn) throw new Error("SOURCING_INVALID_MPN");
  const { data, error } = await supabase.from("sourcing_requests").insert({
    source: "manual",
    mpn: mpn.displayMpn,
    normalized_mpn: mpn.normalizedMpn,
    manufacturer: safeContextText(input.manufacturer, 160),
    requested_quantity: input.requestedQuantity,
    unit_of_measure: safeContextText(input.unitOfMeasure, 40),
    customer_context: safeContextText(input.customerContext, 240),
    priority: input.priority,
    notes: input.notes,
    requested_by: actorId
  }).select("*").single();
  if (error) throw error;
  return data as unknown as DatabaseRow;
}

export async function createSourcingOffer(
  supabase: SupabaseClient,
  actorId: string,
  requestId: string,
  input: SourcingOfferInput
) {
  const mpn = mpnIdentity(input.mpn);
  if (!mpn.normalizedMpn) throw new Error("SOURCING_INVALID_MPN");
  const { data, error } = await supabase.from("sourcing_offers").insert({
    sourcing_request_id: requestId,
    mpn: mpn.displayMpn,
    normalized_mpn: mpn.normalizedMpn,
    manufacturer: safeContextText(input.manufacturer, 160),
    supplier_name: input.supplierName,
    supplier_reference: safeContextText(input.supplierReference, 160),
    available_quantity: input.availableQuantity,
    unit_of_measure: safeContextText(input.unitOfMeasure, 40),
    raw_unit_cost: input.rawUnitCost,
    currency: input.currency,
    lead_time_days: input.leadTimeDays ?? null,
    minimum_order_quantity: input.minimumOrderQuantity,
    standard_pack_quantity: input.standardPackQuantity ?? null,
    date_code: safeContextText(input.dateCode, 80),
    condition: safeContextText(input.condition, 80),
    warehouse: safeContextText(input.warehouse, 160),
    incoterm: safeContextText(input.incoterm, 40),
    country_of_origin: safeContextText(input.countryOfOrigin, 120),
    expires_at: input.expiresAt,
    notes: input.notes,
    provenance: input.provenance,
    created_by: actorId
  }).select("*").single();
  if (error) throw error;
  await supabase.from("sourcing_requests")
    .update({ status: "review" })
    .eq("id", requestId)
    .in("status", ["open", "collecting_offers"]);
  return sourcingOfferPayload(data as unknown as DatabaseRow);
}

export async function createSourcingRequestFromCommerceRfq(
  service: SupabaseClient,
  actorId: string,
  commerceRfqItemId: string
) {
  const { data: item, error: itemError } = await service
    .from("commerce_rfq_items")
    .select("id,rfq_id,mpn,manufacturer,quantity,rfq:commerce_rfqs!commerce_rfq_items_rfq_id_fkey(contact_snapshot)")
    .eq("id", commerceRfqItemId)
    .maybeSingle();
  if (itemError) throw itemError;
  if (!item) throw Object.assign(new Error("SOURCING_NOT_FOUND"), { code: "P0002" });
  const row = item as unknown as DatabaseRow;
  const identity = mpnIdentity(row.mpn);
  if (!identity.normalizedMpn) throw new Error("SOURCING_INVALID_MPN");
  const rfq = Array.isArray(row.rfq) ? row.rfq[0] : row.rfq;
  const contact = rfq && typeof rfq === "object"
    ? (rfq as DatabaseRow).contact_snapshot
    : null;
  const customerContext = contact && typeof contact === "object"
    ? safeContextText((contact as DatabaseRow).companyOrName ?? (contact as DatabaseRow).company, 240)
    : null;

  // Reuse, in order, the request already linked to this RFQ line, an active
  // sourcing effort for the same normalized MPN, or the request backing a
  // still-valid commercial approval. Automation must not fan out duplicates.
  const { data: exactRequest, error: exactError } = await service
    .from("sourcing_requests")
    .select("*")
    .eq("commerce_rfq_item_id", commerceRfqItemId)
    .maybeSingle();
  if (exactError) throw exactError;
  if (exactRequest) return exactRequest as unknown as DatabaseRow;

  const { data: activeRequest, error: activeRequestError } = await service
    .from("sourcing_requests")
    .select("*")
    .eq("normalized_mpn", identity.normalizedMpn)
    .in("status", ["open", "collecting_offers", "review"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeRequestError) throw activeRequestError;
  if (activeRequest) return activeRequest as unknown as DatabaseRow;

  const { data: activeApproval, error: approvalError } = await service
    .from("commercial_price_approvals")
    .select("sourcing_request_id")
    .eq("normalized_mpn", identity.normalizedMpn)
    .eq("status", "active")
    .gt("valid_until", new Date().toISOString())
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (approvalError) throw approvalError;
  if (activeApproval) {
    const { data: approvedRequest, error: approvedRequestError } = await service
      .from("sourcing_requests")
      .select("*")
      .eq("id", activeApproval.sourcing_request_id)
      .maybeSingle();
    if (approvedRequestError) throw approvedRequestError;
    if (approvedRequest) return approvedRequest as unknown as DatabaseRow;
  }

  const { data, error } = await service.from("sourcing_requests").upsert({
    commerce_rfq_id: row.rfq_id,
    commerce_rfq_item_id: commerceRfqItemId,
    source: "commerce_rfq",
    mpn: identity.displayMpn,
    normalized_mpn: identity.normalizedMpn,
    manufacturer: safeContextText(row.manufacturer, 160),
    requested_quantity: numeric(row.quantity),
    customer_context: customerContext,
    status: "open",
    requested_by: actorId
  }, { onConflict: "commerce_rfq_item_id" }).select("*").single();
  if (error) throw error;
  return data as unknown as DatabaseRow;
}
