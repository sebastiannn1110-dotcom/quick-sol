import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile } from "@/lib/types";
import type {
  CommerceCustomerInput,
  CommerceQuoteStatus,
  CommerceQuoteWriteInput
} from "@/lib/commerce/contracts";
import { canAccessSeller } from "@/lib/commerce/contracts";

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
  "items:commerce_quote_items(id,line_number,product_id,mpn,manufacturer,description,quantity,authorized_unit_price,seller_unit_price,discount_percent,currency,line_total,availability_revision,sourcing_offer_id)"
].join(",");

function relationOne(value: unknown) {
  if (Array.isArray(value)) return value[0] as Record<string, unknown> | undefined;
  return value as Record<string, unknown> | null | undefined;
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
      productId: String(item.product_id),
      mpn: String(item.mpn ?? ""),
      description: String(item.description ?? ""),
      manufacturer: String(item.manufacturer ?? ""),
      quantity: asNumber(item.quantity),
      authorizedUnitPrice: asNumber(item.authorized_unit_price),
      sellerUnitPrice: asNumber(item.seller_unit_price),
      discountPercent: asNumber(item.discount_percent),
      lineSubtotal: asNumber(item.line_total),
      availabilityRevision: asNumber(item.availability_revision),
      sourcingOfferId: typeof item.sourcing_offer_id === "string" ? item.sourcing_offer_id : null
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

async function teamSellerIds(supabase: SupabaseClient, profile: Profile) {
  if (profile.role === "admin" || profile.role === "super_admin_dev") return null;
  if (profile.role === "employee") return [profile.id];
  const { data, error } = await supabase
    .from("profiles")
    .select("id,department,region")
    .eq("is_active", true)
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; department: string | null; region: string | null }>)
    .filter((seller) => canAccessSeller(profile, seller))
    .map((seller) => seller.id);
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

async function customerRows(supabase: SupabaseClient) {
  const query = supabase
    .from("clients")
    .select(CUSTOMER_SELECT)
    .eq("status", "active")
    .is("archived_at", null)
    .order("name", { ascending: true })
    .limit(500);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as Record<string, unknown>[];
}

export async function listCommerceCustomers(supabase: SupabaseClient, profile: Profile, search?: string) {
  const [rows, sellerIds] = await Promise.all([customerRows(supabase), teamSellerIds(supabase, profile)]);
  const normalizedSearch = safeSearch(search).toLowerCase();
  return rows
    .filter((row) => sellerIds === null || sellerIds.includes(String(row.assigned_salesperson_id ?? "")))
    .map(customerPayload)
    .filter((customer) => !normalizedSearch || [customer.companyOrName, customer.contact, customer.email]
      .some((value) => value.toLowerCase().includes(normalizedSearch)));
}

export async function getCommerceCustomer(supabase: SupabaseClient, profile: Profile, customerId: string) {
  const [rows, sellerIds] = await Promise.all([customerRows(supabase), teamSellerIds(supabase, profile)]);
  const row = rows.find((candidate) => String(candidate.id) === customerId);
  if (!row) return null;
  if (sellerIds !== null && !sellerIds.includes(String(row.assigned_salesperson_id ?? ""))) return null;
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

export async function listCommerceQuotes(supabase: SupabaseClient, limit = 100) {
  const { data, error } = await supabase
    .from("commerce_quotes")
    .select(QUOTE_SELECT)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
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
  const { data, error } = await supabase.rpc("create_commerce_quote_v1", {
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
  input: CommerceQuoteWriteInput
) {
  const { data, error } = await supabase.rpc("update_commerce_quote_v1", {
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
  const { data, error } = await supabase.rpc("transition_commerce_quote_v1", {
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

export { PRODUCT_SELECT };
