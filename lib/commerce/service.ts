import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile } from "@/lib/types";
import type {
  CommerceCustomerInput,
  CommerceQuotePatchInput,
  CommerceQuoteStatus,
  CommerceQuoteWriteInput,
  CommerceRfqQuoteInput,
  CommerceRfqStatus
} from "@/lib/commerce/contracts";
import { RFQ_STATUSES } from "@/lib/commerce/contracts";
import { scopeElectronicPartsDemoEmployees } from "@/lib/demo/employee-scope";

const PRODUCT_SELECT = [
  "id", "mpn", "manufacturer", "description", "category", "image_url",
  "authorized_unit_price", "currency", "available_quantity", "availability_status",
  "minimum_order_quantity", "lead_time_days", "revision", "updated_at"
].join(",");

const CUSTOMER_DETAIL_SELECT = [
  "legal_company_name", "contact_name", "contact_email", "contact_phone", "country", "city",
  "address_line_1", "address_line_2", "state_or_province", "postal_code", "delivery_recipient",
  "delivery_phone", "delivery_email", "tax_id", "purchase_order_reference",
  "preferred_language", "commercial_notes"
].join(",");
const CUSTOMER_SELECT = [
  "id", "name", "external_customer_id", "assigned_salesperson_id", "created_at", "created_by",
  `details:commerce_client_details(${CUSTOMER_DETAIL_SELECT})`
].join(",");

const QUOTE_SELECT = [
  "id", "quote_number", "rfq_id", "client_id", "seller_id", "status", "currency",
  "subtotal", "tax_rate", "tax", "total", "valid_until", "notes", "commercial_terms",
  "version", "created_at", "updated_at", "sent_at",
  `customer:clients!commerce_quotes_client_id_fkey(${CUSTOMER_SELECT})`,
  "seller:profiles!commerce_quotes_seller_id_fkey(id,full_name,email,role)",
  "items:commerce_quote_items(id,line_number,product_id,mpn,manufacturer,description,quantity,authorized_unit_price,seller_unit_price,discount_percent,currency,line_total,availability_revision)"
].join(",");

const RFQ_RELATION_SELECT = [
  "id", "external_rfq_id", "client_id", "assigned_salesperson_id", "status", "source",
  "contact_snapshot", "created_at", "updated_at",
  "client:clients!commerce_rfqs_client_id_fkey(id,name)",
  "seller:profiles!commerce_rfqs_assigned_salesperson_id_fkey(id,full_name,email,role)",
  "items:commerce_rfq_items(id,line_number,mpn,manufacturer,description,quantity,target_price)",
  "quotes:commerce_quotes(id,quote_number,status,created_at)"
].join(",");

function relationOne(value: unknown) {
  if (Array.isArray(value)) return value[0] as Record<string, unknown> | undefined;
  return value as Record<string, unknown> | null | undefined;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeSearch(value: string | null | undefined, max = 160) {
  return value?.replace(/[%,()]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) ?? "";
}

export function productPayload(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    mpn: String(row.mpn ?? ""),
    manufacturer: String(row.manufacturer ?? ""),
    description: String(row.description ?? ""),
    category: String(row.category ?? "Generic"),
    imageUrl: typeof row.image_url === "string" ? row.image_url : null,
    authorizedUnitPrice: asNumber(row.authorized_unit_price),
    currency: "USD" as const,
    minimumOrderQuantity: asNumber(row.minimum_order_quantity) || 1,
    leadTimeDays: row.lead_time_days == null ? null : asNumber(row.lead_time_days),
    availability: {
      availableQuantity: asNumber(row.available_quantity),
      status: String(row.availability_status ?? "unavailable"),
      updatedAt: String(row.updated_at),
      revision: asNumber(row.revision) || 1
    }
  };
}

export function customerPayload(row: Record<string, unknown>) {
  const details = relationOne(row.details) ?? {};
  return {
    id: String(row.id),
    companyOrName: String(row.name ?? ""),
    legalCompanyName: typeof details.legal_company_name === "string" ? details.legal_company_name : undefined,
    contact: String(details.contact_name ?? ""),
    email: String(details.contact_email ?? ""),
    phone: String(details.contact_phone ?? ""),
    country: String(details.country ?? ""),
    city: String(details.city ?? ""),
    address: String(details.address_line_1 ?? ""),
    addressLine2: typeof details.address_line_2 === "string" ? details.address_line_2 : undefined,
    stateOrProvince: String(details.state_or_province ?? ""),
    postalCode: String(details.postal_code ?? ""),
    deliveryRecipient: String(details.delivery_recipient ?? ""),
    deliveryPhone: String(details.delivery_phone ?? ""),
    deliveryEmail: String(details.delivery_email ?? ""),
    taxId: typeof details.tax_id === "string" ? details.tax_id : undefined,
    purchaseOrderReference: typeof details.purchase_order_reference === "string"
      ? details.purchase_order_reference
      : undefined,
    preferredLanguage: ["es", "en", "zh"].includes(String(details.preferred_language))
      ? String(details.preferred_language) as "es" | "en" | "zh"
      : "en" as const,
    commercialNotes: typeof details.commercial_notes === "string" ? details.commercial_notes : undefined,
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
    externalCustomerId: typeof row.external_customer_id === "string" ? row.external_customer_id : null,
    assignedSalespersonId: typeof row.assigned_salesperson_id === "string" ? row.assigned_salesperson_id : null
  };
}

export function quotePayload(row: Record<string, unknown>) {
  const seller = relationOne(row.seller) ?? {};
  const customer = relationOne(row.customer) ?? {};
  const items = Array.isArray(row.items)
    ? [...row.items as Record<string, unknown>[]].sort((a, b) => asNumber(a.line_number) - asNumber(b.line_number))
    : [];
  return {
    id: String(row.id),
    number: String(row.quote_number),
    rfqId: typeof row.rfq_id === "string" ? row.rfq_id : null,
    sellerId: String(row.seller_id),
    sellerName: String(seller.full_name ?? ""),
    sellerEmail: String(seller.email ?? ""),
    sellerRole: seller.role === "super_admin_dev" ? "admin" : String(seller.role ?? "employee"),
    customer: customerPayload(customer),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    currency: "USD" as const,
    items: items.map((item) => ({
      productId: typeof item.product_id === "string" ? item.product_id : null,
      mpn: String(item.mpn ?? ""),
      description: String(item.description ?? ""),
      manufacturer: String(item.manufacturer ?? ""),
      quantity: asNumber(item.quantity),
      authorizedUnitPrice: asNumber(item.authorized_unit_price),
      sellerUnitPrice: asNumber(item.seller_unit_price),
      discountPercent: asNumber(item.discount_percent),
      lineSubtotal: asNumber(item.line_total),
      availabilityRevision: typeof item.product_id === "string"
        ? asNumber(item.availability_revision)
        : null
    })),
    subtotal: asNumber(row.subtotal),
    taxRate: asNumber(row.tax_rate),
    tax: asNumber(row.tax),
    total: asNumber(row.total),
    validUntil: String(row.valid_until),
    notes: String(row.notes ?? ""),
    commercialTerms: String(row.commercial_terms ?? ""),
    status: String(row.status) as CommerceQuoteStatus,
    version: asNumber(row.version),
    mock: false
  };
}

export function publicQuotePayload(quote: ReturnType<typeof quotePayload>) {
  return {
    number: quote.number,
    sellerName: quote.sellerName,
    customer: {
      companyOrName: quote.customer.companyOrName,
      contact: quote.customer.contact,
      preferredLanguage: quote.customer.preferredLanguage
    },
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    currency: quote.currency,
    items: quote.items.map((item) => ({
      mpn: item.mpn,
      description: item.description,
      manufacturer: item.manufacturer,
      quantity: item.quantity,
      unitPrice: item.sellerUnitPrice,
      discountPercent: item.discountPercent,
      lineSubtotal: item.lineSubtotal
    })),
    subtotal: quote.subtotal,
    taxRate: quote.taxRate,
    tax: quote.tax,
    total: quote.total,
    validUntil: quote.validUntil,
    notes: quote.notes,
    commercialTerms: quote.commercialTerms,
    status: quote.status
  };
}

const MANAGEABLE_CLIENT_ID_PAGE_SIZE = 500;
const CUSTOMER_ID_CHUNK_SIZE = 100;

async function manageableClientIds(supabase: SupabaseClient) {
  const ids: string[] = [];
  for (let from = 0; ; from += MANAGEABLE_CLIENT_ID_PAGE_SIZE) {
    const { data, error } = await supabase
      .rpc("list_commerce_manageable_client_ids_v2")
      .range(from, from + MANAGEABLE_CLIENT_ID_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as Array<{ client_id: string }>;
    ids.push(...page.map((row) => row.client_id));
    if (page.length < MANAGEABLE_CLIENT_ID_PAGE_SIZE) break;
  }
  return [...new Set(ids)];
}

export async function listCommerceManageableClientIds(supabase: SupabaseClient) {
  return manageableClientIds(supabase);
}

export async function listCommerceCatalog(
  supabase: SupabaseClient,
  searchParams: URLSearchParams
) {
  const page = Math.max(Number(searchParams.get("page") ?? 1) || 1, 1);
  const pageSize = Math.min(Math.max(Number(searchParams.get("pageSize") ?? 24) || 24, 1), 100);
  const queryText = safeSearch(searchParams.get("query"));
  const manufacturer = safeSearch(searchParams.get("manufacturer"));
  const category = safeSearch(searchParams.get("category"));
  const status = safeSearch(searchParams.get("status"));
  let query = supabase
    .from("commerce_catalog_products")
    .select(PRODUCT_SELECT, { count: "exact" })
    .eq("is_active", true);
  if (queryText) query = query.or(`mpn.ilike.%${queryText}%,manufacturer.ilike.%${queryText}%,description.ilike.%${queryText}%`);
  if (manufacturer) query = query.ilike("manufacturer", `%${manufacturer}%`);
  if (category) query = query.eq("category", category);
  if (status) query = query.eq("availability_status", status);
  switch (searchParams.get("sort")) {
    case "price_asc": query = query.order("authorized_unit_price", { ascending: true }); break;
    case "price_desc": query = query.order("authorized_unit_price", { ascending: false }); break;
    case "mpn": query = query.order("mpn", { ascending: true }); break;
    default:
      query = query.order("available_quantity", { ascending: false }).order("mpn", { ascending: true });
  }
  const from = (page - 1) * pageSize;
  const { data, error, count } = await query.range(from, from + pageSize - 1);
  if (error) throw error;
  const total = count ?? 0;
  return {
    data: ((data ?? []) as unknown as Record<string, unknown>[]).map(productPayload),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}

export async function getCommerceProduct(supabase: SupabaseClient, productId: string) {
  const { data, error } = await supabase
    .from("commerce_catalog_products")
    .select(PRODUCT_SELECT)
    .eq("id", productId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data ? productPayload(data as unknown as Record<string, unknown>) : null;
}

async function customerRows(supabase: SupabaseClient, clientIds: string[]) {
  if (clientIds.length === 0) return [];
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < clientIds.length; offset += CUSTOMER_ID_CHUNK_SIZE) {
    const chunk = clientIds.slice(offset, offset + CUSTOMER_ID_CHUNK_SIZE);
    const { data, error } = await supabase
      .from("clients")
      .select(CUSTOMER_SELECT)
      .eq("status", "active")
      .is("archived_at", null)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .in("id", chunk);
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as Record<string, unknown>[]));
  }
  return rows.sort((left, right) => (
    String(left.name ?? "").localeCompare(String(right.name ?? ""))
    || String(left.id ?? "").localeCompare(String(right.id ?? ""))
  ));
}

export async function listCommerceCustomers(supabase: SupabaseClient, profile: Profile, search?: string) {
  void profile;
  const clientIds = await manageableClientIds(supabase);
  const rows = await customerRows(supabase, clientIds);
  const allowedIds = new Set(clientIds);
  const normalizedSearch = safeSearch(search).toLowerCase();
  return rows
    .filter((row) => allowedIds.has(String(row.id)))
    .map(customerPayload)
    .filter((customer) => !normalizedSearch || [customer.companyOrName, customer.contact, customer.email]
      .some((value) => value.toLowerCase().includes(normalizedSearch)));
}

export async function getCommerceCustomer(supabase: SupabaseClient, profile: Profile, customerId: string) {
  void profile;
  const clientIds = await manageableClientIds(supabase);
  if (!clientIds.includes(customerId)) return null;
  const [row] = await customerRows(supabase, [customerId]);
  if (!row) return null;
  return customerPayload(row);
}

export async function createCommerceCustomer(supabase: SupabaseClient, profile: Profile, input: CommerceCustomerInput) {
  void profile;
  const { data, error } = await supabase.rpc("create_commerce_customer_v1", { input_details: input });
  if (error) throw error;
  return getCommerceCustomer(supabase, profile, String(data));
}

export async function updateCommerceCustomer(
  supabase: SupabaseClient,
  profile: Profile,
  customerId: string,
  input: CommerceCustomerInput
) {
  const current = await getCommerceCustomer(supabase, profile, customerId);
  if (!current) return null;
  const { data, error } = await supabase.rpc("update_commerce_customer_v1", {
    input_client_id: customerId,
    input_details: input
  });
  if (error) throw error;
  return getCommerceCustomer(supabase, profile, String(data));
}

export async function listCommerceQuotes(supabase: SupabaseClient, limit = 100, clientId?: string) {
  let query = supabase
    .from("commerce_quotes")
    .select(QUOTE_SELECT)
    .order("created_at", { ascending: false });
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query.limit(Math.min(Math.max(limit, 1), 500));
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(quotePayload);
}

export async function getCommerceQuote(supabase: SupabaseClient, quoteId: string) {
  const { data, error } = await supabase
    .from("commerce_quotes")
    .select(QUOTE_SELECT)
    .eq("id", quoteId)
    .maybeSingle();
  if (error) throw error;
  return data ? quotePayload(data as unknown as Record<string, unknown>) : null;
}

export async function createCommerceQuote(supabase: SupabaseClient, input: CommerceQuoteWriteInput) {
  const { data, error } = await supabase.rpc("create_commerce_quote_v2", {
    input_client_id: input.customerId,
    input_rfq_id: input.rfqId ?? null,
    input_items: input.items,
    input_valid_until: input.validUntil,
    input_notes: input.notes,
    input_commercial_terms: input.commercialTerms,
    input_tax_rate: input.taxRate
  });
  if (error) throw error;
  return getCommerceQuote(supabase, String(data));
}

export async function updateCommerceQuote(
  supabase: SupabaseClient,
  quoteId: string,
  version: number,
  input: Omit<CommerceQuotePatchInput, "version">
) {
  const { data, error } = await supabase.rpc("update_commerce_quote_v2", {
    input_quote_id: quoteId,
    input_expected_version: version,
    input_client_id: input.customerId,
    input_rfq_id: input.rfqId ?? null,
    input_items: input.items,
    input_valid_until: input.validUntil,
    input_notes: input.notes,
    input_commercial_terms: input.commercialTerms,
    input_tax_rate: input.taxRate
  });
  if (error) throw error;
  return getCommerceQuote(supabase, String(data));
}

export async function transitionCommerceQuote(
  supabase: SupabaseClient,
  quoteId: string,
  version: number,
  status: Exclude<CommerceQuoteStatus, "draft">,
  reason?: string
) {
  const { data, error } = await supabase.rpc("transition_commerce_quote_v2", {
    input_quote_id: quoteId,
    input_expected_version: version,
    input_new_status: status,
    input_reason: reason ?? null
  });
  if (error) throw error;
  return getCommerceQuote(supabase, String(data));
}

export async function commerceDashboard(supabase: SupabaseClient) {
  const [quotes, lowStockResult] = await Promise.all([
    listCommerceQuotes(supabase, 200),
    supabase
      .from("commerce_catalog_products")
      .select(PRODUCT_SELECT)
      .eq("is_active", true)
      .eq("availability_status", "low_stock")
      .order("updated_at", { ascending: false })
      .limit(12)
  ]);
  if (lowStockResult.error) throw lowStockResult.error;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const thisMonth = quotes.filter((quote) => new Date(quote.createdAt) >= monthStart);
  const decided = thisMonth.filter((quote) => ["accepted", "rejected", "expired"].includes(quote.status));
  const accepted = decided.filter((quote) => quote.status === "accepted").length;
  return {
    recentQuotes: quotes.slice(0, 8),
    activeReservations: [],
    recentOrders: [],
    lowStockProducts: ((lowStockResult.data ?? []) as unknown as Record<string, unknown>[]).map(productPayload),
    inventoryAlerts: ((lowStockResult.data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
      id: `low-stock-${String(row.id)}`,
      productId: String(row.id),
      message: `${String(row.mpn)} has limited seller-safe availability.`,
      createdAt: String(row.updated_at)
    })),
    metrics: {
      quotesThisMonth: thisMonth.length,
      activeReservations: 0,
      confirmedOrders: 0,
      conversionRate: decided.length ? Math.round(accepted / decided.length * 10_000) / 100 : 0
    }
  };
}

function rfqItems(row: Record<string, unknown>) {
  const items = Array.isArray(row.items) ? row.items as Record<string, unknown>[] : [];
  return [...items].sort((left, right) => asNumber(left.line_number) - asNumber(right.line_number));
}

function rfqQuotes(row: Record<string, unknown>) {
  const quotes = Array.isArray(row.quotes) ? row.quotes as Record<string, unknown>[] : [];
  return [...quotes].sort((left, right) => {
    const dateOrder = String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
    return dateOrder || String(right.id ?? "").localeCompare(String(left.id ?? ""));
  });
}

function rfqContact(row: Record<string, unknown>) {
  const contact = objectValue(row.contact_snapshot);
  const language = String(contact.preferredLanguage ?? "en");
  return {
    companyOrName: String(contact.companyOrName ?? ""),
    contact: String(contact.contact ?? ""),
    email: String(contact.email ?? ""),
    phone: String(contact.phone ?? ""),
    country: String(contact.country ?? ""),
    city: String(contact.city ?? ""),
    preferredLanguage: language,
    notes: String(contact.notes ?? "")
  };
}

export function rfqSummaryPayload(row: Record<string, unknown>) {
  const contact = rfqContact(row);
  const client = relationOne(row.client) ?? {};
  const seller = relationOne(row.seller);
  const items = rfqItems(row);
  const primaryItem = items[0];
  const status = String(row.status) as CommerceRfqStatus;
  const createdAt = String(row.created_at);
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return {
    id: String(row.id),
    externalRfqId: String(row.external_rfq_id),
    status,
    source: String(row.source),
    createdAt,
    updatedAt: String(row.updated_at),
    clientId: typeof row.client_id === "string" ? row.client_id : null,
    companyOrName: String(client.name ?? contact.companyOrName),
    contactName: contact.contact,
    country: contact.country,
    itemCount: items.length,
    primaryItem: primaryItem
      ? { mpn: String(primaryItem.mpn ?? ""), quantity: asNumber(primaryItem.quantity) }
      : null,
    assignedSeller: seller
      ? { id: String(seller.id), fullName: String(seller.full_name ?? "") }
      : null,
    isNew: ["unassigned", "assigned"].includes(status) && ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000
  };
}

type RfqPricingPreview = {
  itemId?: unknown;
  status?: unknown;
  reason?: unknown;
  productId?: unknown;
  authorizedUnitPrice?: unknown;
  currency?: unknown;
  minimumOrderQuantity?: unknown;
};

function rfqDetailPayload(
  row: Record<string, unknown>,
  profile: Profile,
  pricingRows: RfqPricingPreview[],
  assignableRows: Record<string, unknown>[]
) {
  const summary = rfqSummaryPayload(row);
  const pricingByItem = new Map(pricingRows.map((pricing) => [String(pricing.itemId), pricing]));
  const items = rfqItems(row).map((item) => {
    const pricing = pricingByItem.get(String(item.id)) ?? { status: "required", reason: "catalog_not_found" };
    const ready = pricing.status === "ready";
    return {
      id: String(item.id),
      lineNumber: asNumber(item.line_number),
      mpn: String(item.mpn ?? ""),
      manufacturer: String(item.manufacturer ?? ""),
      description: String(item.description ?? ""),
      quantity: asNumber(item.quantity),
      targetPrice: item.target_price == null ? null : asNumber(item.target_price),
      pricing: {
        status: ready ? "ready" as const : "required" as const,
        reason: ready ? null : String(pricing.reason ?? "catalog_not_found"),
        productId: ready && typeof pricing.productId === "string" ? pricing.productId : null,
        authorizedUnitPrice: ready ? asNumber(pricing.authorizedUnitPrice) : null,
        currency: ready ? String(pricing.currency ?? "USD") : null,
        minimumOrderQuantity: pricing.minimumOrderQuantity == null
          ? null
          : asNumber(pricing.minimumOrderQuantity)
      }
    };
  });
  const quoteRow = rfqQuotes(row)[0];
  const pricingReady = items.length > 0 && items.every((item) => item.pricing.status === "ready");
  const terminal = ["quoted", "cancelled"].includes(summary.status);
  const canAssign = ["manager", "admin", "super_admin_dev"].includes(profile.role) && !terminal;
  const client = relationOne(row.client);

  return {
    ...summary,
    contact: rfqContact(row),
    client: client ? { id: String(client.id), companyOrName: String(client.name ?? "") } : null,
    items,
    pricingReady,
    quote: quoteRow
      ? {
          id: String(quoteRow.id),
          number: String(quoteRow.quote_number),
          status: String(quoteRow.status),
          createdAt: String(quoteRow.created_at)
        }
      : null,
    assignableSellers: canAssign
      ? assignableRows.map((seller) => ({
          id: String(seller.id),
          fullName: String(seller.full_name ?? ""),
          email: String(seller.email ?? ""),
          role: String(seller.role ?? "employee")
        }))
      : [],
    actions: {
      markInReview: summary.status === "assigned",
      assignSeller: canAssign,
      createClient: summary.clientId === null
        && ["unassigned", "assigned", "in_review"].includes(summary.status),
      createQuote: summary.clientId !== null
        && !quoteRow
        && ["assigned", "in_review"].includes(summary.status)
    }
  };
}

export async function listCommerceRfqs(
  supabase: SupabaseClient,
  searchParams: URLSearchParams
) {
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 50) || 50, 1), 100);
  const clientId = searchParams.get("clientId")?.trim() || undefined;
  const requestedStatus = searchParams.get("status")?.trim();
  const status = requestedStatus && (RFQ_STATUSES as readonly string[]).includes(requestedStatus)
    ? requestedStatus
    : undefined;

  let rowsQuery = supabase
    .from("commerce_rfqs")
    .select(RFQ_RELATION_SELECT)
    .order("created_at", { ascending: false });
  let pendingQuery = supabase
    .from("commerce_rfqs")
    .select("id", { count: "exact", head: true })
    .in("status", ["unassigned", "assigned", "in_review"]);

  if (clientId) {
    rowsQuery = rowsQuery.eq("client_id", clientId);
    pendingQuery = pendingQuery.eq("client_id", clientId);
  }
  if (status) rowsQuery = rowsQuery.eq("status", status);

  const [rowsResult, pendingResult] = await Promise.all([
    rowsQuery.limit(limit),
    pendingQuery
  ]);
  if (rowsResult.error) throw rowsResult.error;
  if (pendingResult.error) throw pendingResult.error;

  return {
    rfqs: ((rowsResult.data ?? []) as unknown as Record<string, unknown>[]).map(rfqSummaryPayload),
    pendingCount: pendingResult.count ?? 0
  };
}

export async function getCommerceRfq(
  supabase: SupabaseClient,
  profile: Profile,
  rfqId: string
) {
  const { data, error } = await supabase
    .from("commerce_rfqs")
    .select(RFQ_RELATION_SELECT)
    .eq("id", rfqId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;

  const canAssign = ["manager", "admin", "super_admin_dev"].includes(profile.role)
    && !["quoted", "cancelled"].includes(String(row.status));
  const [pricingResult, sellersResult] = await Promise.all([
    supabase.rpc("preview_commerce_rfq_pricing_v2", { input_rfq_id: rfqId }),
    canAssign
      ? supabase.rpc("list_commerce_assignable_sellers_v2", { input_rfq_id: rfqId })
      : Promise.resolve({ data: [], error: null })
  ]);
  if (pricingResult.error) throw pricingResult.error;
  if (sellersResult.error) throw sellersResult.error;
  const assignableRows = Array.isArray(sellersResult.data)
    ? sellersResult.data as unknown as Record<string, unknown>[]
    : [];
  let scopedAssignableRows: Record<string, unknown>[] = [];
  if (assignableRows.length) {
    const sellerIds = assignableRows.map((seller) => String(seller.id));
    const sellerProfilesResult = await supabase
      .from("profiles")
      .select("id,email,bio,is_active")
      .in("id", sellerIds);
    if (sellerProfilesResult.error) throw sellerProfilesResult.error;
    const visibleSellerIds = new Set(
      scopeElectronicPartsDemoEmployees(sellerProfilesResult.data ?? [])
        .map((seller) => String(seller.id))
    );
    scopedAssignableRows = assignableRows.filter((seller) => visibleSellerIds.has(String(seller.id)));
  }

  return rfqDetailPayload(
    row,
    profile,
    Array.isArray(pricingResult.data) ? pricingResult.data as RfqPricingPreview[] : [],
    scopedAssignableRows
  );
}

export async function markCommerceRfqInReview(
  supabase: SupabaseClient,
  profile: Profile,
  rfqId: string
) {
  const { error } = await supabase.rpc("mark_commerce_rfq_in_review_v2", { input_rfq_id: rfqId });
  if (error) throw error;
  return getCommerceRfq(supabase, profile, rfqId);
}

export async function assignCommerceRfqSeller(
  supabase: SupabaseClient,
  profile: Profile,
  rfqId: string,
  sellerId: string
) {
  const { error } = await supabase.rpc("assign_commerce_rfq_seller_v2", {
    input_rfq_id: rfqId,
    input_seller_id: sellerId
  });
  if (error) throw error;
  return getCommerceRfq(supabase, profile, rfqId);
}

export async function createCommerceClientFromRfq(
  supabase: SupabaseClient,
  profile: Profile,
  rfqId: string
) {
  const { error } = await supabase.rpc("create_commerce_client_from_rfq_v2", {
    input_rfq_id: rfqId
  });
  if (error) throw error;
  return getCommerceRfq(supabase, profile, rfqId);
}

export async function createCommerceQuoteFromRfq(
  supabase: SupabaseClient,
  rfqId: string,
  input: CommerceRfqQuoteInput
) {
  const { data, error } = await supabase.rpc("create_commerce_quote_from_rfq_v2", {
    input_rfq_id: rfqId,
    input_valid_until: input.validUntil,
    input_notes: input.notes,
    input_commercial_terms: input.commercialTerms,
    input_tax_rate: input.taxRate
  });
  if (error) throw error;
  const result = objectValue(data);
  const pricingRequired = Array.isArray(result.pricingRequired)
    ? result.pricingRequired as Record<string, unknown>[]
    : [];
  const quoteId = typeof result.quoteId === "string" ? result.quoteId : null;
  if (!quoteId) {
    return { quote: null, idempotent: false, pricingRequired };
  }
  return {
    quote: await getCommerceQuote(supabase, quoteId),
    idempotent: result.idempotent === true,
    pricingRequired
  };
}

export async function getCommerceClientActivity(
  supabase: SupabaseClient,
  _profile: Profile,
  clientId: string
) {
  const accessResult = await supabase.rpc("commerce_can_read_client_v2", {
    target_client_id: clientId
  });
  if (accessResult.error) throw accessResult.error;
  if (accessResult.data !== true) return null;

  const params = new URLSearchParams({ clientId, limit: "5" });
  const [rfqResult, quotes] = await Promise.all([
    listCommerceRfqs(supabase, params),
    listCommerceQuotes(supabase, 5, clientId)
  ]);

  return {
    recentRfqs: rfqResult.rfqs.map((rfq) => ({
      id: rfq.id,
      status: rfq.status,
      createdAt: rfq.createdAt,
      mpn: rfq.primaryItem?.mpn ?? "",
      quantity: rfq.primaryItem?.quantity ?? 0
    })),
    recentQuotes: quotes.map((quote) => ({
      id: quote.id,
      number: quote.number,
      status: quote.status,
      createdAt: quote.createdAt,
      total: quote.total,
      currency: quote.currency,
      seller: { id: quote.sellerId, fullName: quote.sellerName }
    }))
  };
}

export { PRODUCT_SELECT };
