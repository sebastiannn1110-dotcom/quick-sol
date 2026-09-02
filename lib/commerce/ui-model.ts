import type { CommerceQuoteStatus } from "@/lib/commerce/contracts";

export type CommerceRfqStatus = "unassigned" | "assigned" | "in_review" | "quoted" | "cancelled";

export type CommerceSellerSummary = {
  id: string;
  fullName: string;
  email: string;
  role: string;
};

export type CommerceRfqContact = {
  companyOrName: string;
  contact: string;
  email: string;
  phone: string;
  country: string;
  city: string;
  preferredLanguage: string;
  notes: string;
};

export type CommerceRfqPricing = {
  productId: string | null;
  authorizedUnitPrice: number | null;
  currency: "USD";
  available: boolean;
};

export type CommerceRfqItem = {
  id: string;
  lineNumber: number;
  mpn: string;
  manufacturer: string;
  description: string;
  quantity: number;
  targetPrice: number | null;
  pricing: CommerceRfqPricing | null;
};

export type CommerceRfqSummary = {
  id: string;
  externalRfqId: string;
  clientId: string | null;
  status: CommerceRfqStatus;
  source: string;
  createdAt: string;
  updatedAt: string;
  companyOrName: string;
  contactName: string;
  country: string;
  itemCount: number;
  primaryMpn: string;
  primaryQuantity: number;
  assignedSeller: CommerceSellerSummary | null;
  isNew?: boolean;
};

export type CommerceRfqActions = {
  markInReview: boolean;
  assignSeller: boolean;
  createClient: boolean;
  createQuote: boolean;
};

export type CommerceRfqLinkedQuote = {
  id: string;
  number: string;
  status: CommerceQuoteStatus;
};

export type CommerceRfqDetail = CommerceRfqSummary & {
  contact: CommerceRfqContact;
  items: CommerceRfqItem[];
  client: { id: string; name: string } | null;
  pricingReady: boolean;
  assignedSeller: CommerceSellerSummary | null;
  assignableSellers: CommerceSellerSummary[];
  quote: CommerceRfqLinkedQuote | null;
  actions: CommerceRfqActions;
};

export type CommerceQuoteItemUi = {
  productId: string | null;
  mpn: string;
  manufacturer: string;
  description: string;
  quantity: number;
  authorizedUnitPrice: number;
  sellerUnitPrice: number;
  discountPercent: number;
  lineSubtotal: number;
};

export type CommerceQuoteUi = {
  id: string;
  number: string;
  rfqId: string | null;
  sellerId: string;
  sellerName: string;
  customer: { id: string; companyOrName: string };
  createdAt: string;
  updatedAt: string;
  currency: "USD";
  items: CommerceQuoteItemUi[];
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
  validUntil: string;
  notes: string;
  commercialTerms: string;
  status: CommerceQuoteStatus;
  version: number;
};

export type ClientCommerceActivity = {
  recentRfqs: CommerceRfqSummary[];
  recentQuotes: CommerceQuoteUi[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rfqStatus(value: unknown): CommerceRfqStatus {
  return ["unassigned", "assigned", "in_review", "quoted", "cancelled"].includes(String(value))
    ? String(value) as CommerceRfqStatus
    : "unassigned";
}

function quoteStatus(value: unknown): CommerceQuoteStatus {
  return ["draft", "sent", "accepted", "rejected", "expired"].includes(String(value))
    ? String(value) as CommerceQuoteStatus
    : "draft";
}

export function normalizeCommerceSeller(value: unknown): CommerceSellerSummary | null {
  const row = record(value);
  const id = text(row.id);
  if (!id) return null;
  return {
    id,
    fullName: text(row.fullName ?? row.full_name),
    email: text(row.email),
    role: text(row.role, "employee")
  };
}

function normalizeContact(value: unknown): CommerceRfqContact {
  const row = record(value);
  return {
    companyOrName: text(row.companyOrName ?? row.company_or_name),
    contact: text(row.contact ?? row.contactName ?? row.contact_name),
    email: text(row.email),
    phone: text(row.phone),
    country: text(row.country),
    city: text(row.city),
    preferredLanguage: text(row.preferredLanguage ?? row.preferred_language, "en"),
    notes: text(row.notes)
  };
}

function normalizeRfqPricing(value: unknown): CommerceRfqPricing | null {
  if (value === null || value === undefined) return null;
  const row = record(value);
  const productId = text(row.productId ?? row.product_id) || null;
  const authorizedUnitPrice = nullableNumber(row.authorizedUnitPrice ?? row.authorized_unit_price);
  const available = row.available !== null && row.available !== undefined
    ? Boolean(row.available)
    : row.pricingReady !== null && row.pricingReady !== undefined
      ? Boolean(row.pricingReady)
      : typeof row.status === "string"
        ? row.status === "ready"
        : Boolean(productId && authorizedUnitPrice !== null);
  return {
    productId,
    authorizedUnitPrice,
    currency: "USD",
    available
  };
}

export function normalizeRfqItem(value: unknown, index = 0): CommerceRfqItem {
  const row = record(value);
  return {
    id: text(row.id, `line-${index + 1}`),
    lineNumber: number(row.lineNumber ?? row.line_number, index + 1),
    mpn: text(row.mpn),
    manufacturer: text(row.manufacturer),
    description: text(row.description),
    quantity: number(row.quantity),
    targetPrice: nullableNumber(row.targetPrice ?? row.target_price),
    pricing: normalizeRfqPricing(row.pricing)
  };
}

export function normalizeRfqSummary(value: unknown): CommerceRfqSummary {
  const row = record(value);
  const contact = normalizeContact(row.contact ?? row.contactSnapshot ?? row.contact_snapshot);
  const firstItem = record(row.primaryItem ?? row.primary_item);
  const items = Array.isArray(row.items) ? row.items.map(normalizeRfqItem) : [];
  const assignedSeller = normalizeCommerceSeller(row.assignedSeller ?? row.assigned_seller);
  return {
    id: text(row.id),
    externalRfqId: text(row.externalRfqId ?? row.external_rfq_id),
    clientId: text(row.clientId ?? row.client_id) || null,
    status: rfqStatus(row.status),
    source: text(row.source, "quiksol-web"),
    createdAt: text(row.createdAt ?? row.created_at),
    updatedAt: text(row.updatedAt ?? row.updated_at ?? row.createdAt ?? row.created_at),
    companyOrName: text(row.companyOrName ?? row.company_or_name, contact.companyOrName),
    contactName: text(row.contactName ?? row.contact_name, contact.contact),
    country: text(row.country, contact.country),
    itemCount: number(row.itemCount ?? row.item_count ?? row.lineCount ?? row.line_count, items.length),
    primaryMpn: text(row.primaryMpn ?? row.primary_mpn ?? row.mpn ?? firstItem.mpn, items[0]?.mpn ?? ""),
    primaryQuantity: number(
      row.primaryQuantity ?? row.primary_quantity ?? row.quantity ?? firstItem.quantity,
      items[0]?.quantity ?? 0
    ),
    assignedSeller,
    isNew: typeof row.isNew === "boolean" ? row.isNew : undefined
  };
}

export function normalizeRfqDetail(value: unknown): CommerceRfqDetail {
  const row = record(value);
  const summary = normalizeRfqSummary(value);
  const contact = normalizeContact(row.contact ?? row.contactSnapshot ?? row.contact_snapshot);
  const items = Array.isArray(row.items) ? row.items.map(normalizeRfqItem) : [];
  const clientRow = record(row.client);
  const quoteRow = record(row.quote ?? row.linkedQuote ?? row.linked_quote);
  const actions = record(row.actions);
  const pricingReady = typeof row.pricingReady === "boolean"
    ? row.pricingReady
    : items.length > 0 && items.every((item) => item.pricing?.available);
  return {
    ...summary,
    companyOrName: summary.companyOrName || contact.companyOrName,
    contactName: summary.contactName || contact.contact,
    country: summary.country || contact.country,
    contact,
    items,
    client: text(clientRow.id) ? { id: text(clientRow.id), name: text(clientRow.name ?? clientRow.companyOrName) } : null,
    pricingReady,
    assignedSeller: normalizeCommerceSeller(row.assignedSeller ?? row.assigned_seller),
    assignableSellers: Array.isArray(row.assignableSellers)
      ? row.assignableSellers.map(normalizeCommerceSeller).filter((seller): seller is CommerceSellerSummary => Boolean(seller))
      : [],
    quote: text(quoteRow.id)
      ? { id: text(quoteRow.id), number: text(quoteRow.number ?? quoteRow.quoteNumber), status: quoteStatus(quoteRow.status) }
      : null,
    actions: {
      markInReview: Boolean(actions.markInReview ?? actions.mark_in_review),
      assignSeller: Boolean(actions.assignSeller ?? actions.assign_seller),
      createClient: Boolean(actions.createClient ?? actions.create_client),
      createQuote: Boolean(actions.createQuote ?? actions.create_quote)
    }
  };
}

export function normalizeCommerceQuote(value: unknown): CommerceQuoteUi {
  const row = record(value);
  const customer = record(row.customer);
  const seller = record(row.seller);
  return {
    id: text(row.id),
    number: text(row.number ?? row.quoteNumber ?? row.quote_number),
    rfqId: text(row.rfqId ?? row.rfq_id) || null,
    sellerId: text(row.sellerId ?? row.seller_id),
    sellerName: text(row.sellerName ?? row.seller_name ?? seller.fullName ?? seller.full_name),
    customer: {
      id: text(customer.id ?? row.customerId ?? row.clientId),
      companyOrName: text(customer.companyOrName ?? customer.name ?? row.customerName)
    },
    createdAt: text(row.createdAt ?? row.created_at),
    updatedAt: text(row.updatedAt ?? row.updated_at),
    currency: "USD",
    items: Array.isArray(row.items) ? row.items.map((entry) => {
      const item = record(entry);
      return {
        productId: text(item.productId ?? item.product_id) || null,
        mpn: text(item.mpn),
        manufacturer: text(item.manufacturer),
        description: text(item.description),
        quantity: number(item.quantity),
        authorizedUnitPrice: number(item.authorizedUnitPrice ?? item.authorized_unit_price),
        sellerUnitPrice: number(item.sellerUnitPrice ?? item.seller_unit_price),
        discountPercent: number(item.discountPercent ?? item.discount_percent),
        lineSubtotal: number(item.lineSubtotal ?? item.line_total)
      };
    }) : [],
    subtotal: number(row.subtotal),
    taxRate: number(row.taxRate ?? row.tax_rate),
    tax: number(row.tax),
    total: number(row.total),
    validUntil: text(row.validUntil ?? row.valid_until),
    notes: text(row.notes),
    commercialTerms: text(row.commercialTerms ?? row.commercial_terms),
    status: quoteStatus(row.status),
    version: number(row.version, 1)
  };
}

export function parseRfqListPayload(value: unknown) {
  const row = record(value);
  const rfqs = Array.isArray(row.rfqs) ? row.rfqs.map(normalizeRfqSummary) : [];
  return {
    rfqs,
    pendingCount: number(row.pendingCount ?? row.pending_count, rfqs.filter(isPendingRfq).length)
  };
}

export function parseClientCommerceActivity(value: unknown): ClientCommerceActivity {
  const row = record(value);
  return {
    recentRfqs: Array.isArray(row.recentRfqs) ? row.recentRfqs.slice(0, 5).map(normalizeRfqSummary) : [],
    recentQuotes: Array.isArray(row.recentQuotes) ? row.recentQuotes.slice(0, 5).map(normalizeCommerceQuote) : []
  };
}

export function isPendingRfq(rfq: Pick<CommerceRfqSummary, "status">) {
  return rfq.status === "unassigned" || rfq.status === "assigned" || rfq.status === "in_review";
}

export function isUiNewRfq(
  rfq: Pick<CommerceRfqSummary, "status" | "createdAt" | "isNew">,
  now = Date.now(),
  recentWindowMs = 24 * 60 * 60 * 1000
) {
  if (typeof rfq.isNew === "boolean") return rfq.isNew;
  if (rfq.status !== "unassigned" && rfq.status !== "assigned") return false;
  const created = Date.parse(rfq.createdAt);
  return Number.isFinite(created) && now - created >= 0 && now - created <= recentWindowMs;
}

export function isDemoAccountName(name: string) {
  return /-demo$/i.test(name.trim());
}
