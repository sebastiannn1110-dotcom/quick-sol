import type { UserRole } from "@/lib/types";

export type RolePermissions = {
  canViewSensitivePricing: boolean;
  canViewCosts: boolean;
  canViewGp: boolean;
  canViewSupplierDetails: boolean;
  canViewCustomerDetails: boolean;
  canViewPurchaseOrders: boolean;
  canViewInternalNotes: boolean;
};

export const REDACTED_FIELD_VALUE = null;
export const SENSITIVE_DATA_DENIED_MESSAGE = "No tengo permiso para mostrar costos, precios o margen en esta vista.";

type SensitiveGroup = "pricing" | "cost" | "gp" | "supplier" | "customer" | "po" | "notes";

const EXACT_SENSITIVE_KEYS: Record<SensitiveGroup, string[]> = {
  pricing: [
    "price",
    "unitprice",
    "sellingprice",
    "saleprice",
    "quotedprice",
    "targetprice",
    "totalprice",
    "bestprice",
    "bestpriceoffered",
    "pricebook",
    "globalprice",
    "contractglobalprice",
    "usdextendedprice",
    "usdextendedprice2",
    "potentialamountusd",
    "amount",
    "revenue"
  ],
  cost: [
    "cost",
    "unitcost",
    "productcost",
    "suppliercost",
    "buycost",
    "buyprice",
    "targettovendor",
    "cogs"
  ],
  gp: [
    "gp",
    "gprate",
    "grossprofit",
    "grossprofitrate",
    "grossmargin",
    "margin",
    "marginrate",
    "commission",
    "comision",
    "netprofit"
  ],
  supplier: [
    "supplier",
    "suppliername",
    "globalsuppliername",
    "vendor",
    "vendorname",
    "manufacturer",
    "manufacturername",
    "globalmanufacturername",
    "mfg",
    "mfr",
    "manuname",
    "manucode",
    "cleanmfg"
  ],
  customer: [
    "customer",
    "customername",
    "globalcustomername",
    "client",
    "clientname",
    "endcustomer",
    "bpname",
    "businesspartnerid"
  ],
  po: ["po", "purchaseorder", "purchaseordernumber"],
  notes: ["notes", "note", "internalnotes", "internalnote", "comments", "comment", "remarks", "memo"]
};

const FIELD_PATTERNS: Array<{ group: SensitiveGroup; pattern: RegExp }> = [
  { group: "pricing", pattern: /(price|pricebook|globalprice|contractglobalprice|usdextendedprice|revenue|amount)$/ },
  { group: "cost", pattern: /(cost|cogs|buyprice|targettovendor)$/ },
  { group: "gp", pattern: /^(gp|gprate)$|grossprofit|grossmargin|marginrate|commission|comision|netprofit/ },
  { group: "supplier", pattern: /supplier|vendor|manufacturer|manuname|manucode|cleanmfg|^mfg$|^mfr$/ },
  { group: "customer", pattern: /customer|client|endcustomer|bpname|businesspartnerid/ },
  { group: "po", pattern: /^(po|purchaseorder|purchaseordernumber)$/ },
  { group: "notes", pattern: /internalnote|internalnotes|^notes?$|^comments?$|remarks|memo/ }
];

function normalizedKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function sensitiveGroupForKey(key: string): SensitiveGroup | null {
  const normalized = normalizedKey(key);
  for (const [group, keys] of Object.entries(EXACT_SENSITIVE_KEYS) as Array<[SensitiveGroup, string[]]>) {
    if (keys.includes(normalized)) return group;
  }
  return FIELD_PATTERNS.find((entry) => entry.pattern.test(normalized))?.group ?? null;
}

export function getRolePermissions(role: UserRole): RolePermissions {
  if (role === "admin") {
    return {
      canViewSensitivePricing: true,
      canViewCosts: true,
      canViewGp: true,
      canViewSupplierDetails: true,
      canViewCustomerDetails: true,
      canViewPurchaseOrders: true,
      canViewInternalNotes: true
    };
  }

  if (role === "manager") {
    return {
      canViewSensitivePricing: false,
      canViewCosts: false,
      canViewGp: false,
      canViewSupplierDetails: true,
      canViewCustomerDetails: true,
      canViewPurchaseOrders: false,
      canViewInternalNotes: false
    };
  }

  return {
    canViewSensitivePricing: false,
    canViewCosts: false,
    canViewGp: false,
    canViewSupplierDetails: false,
    canViewCustomerDetails: false,
    canViewPurchaseOrders: false,
    canViewInternalNotes: false
  };
}

export function canViewSensitivePricing(role: UserRole) {
  return getRolePermissions(role).canViewSensitivePricing;
}

export function canViewCosts(role: UserRole) {
  return getRolePermissions(role).canViewCosts;
}

export function canViewGp(role: UserRole) {
  return getRolePermissions(role).canViewGp;
}

export function canViewSupplierDetails(role: UserRole) {
  return getRolePermissions(role).canViewSupplierDetails;
}

export function canViewCustomerDetails(role: UserRole) {
  return getRolePermissions(role).canViewCustomerDetails;
}

function canViewGroup(role: UserRole, group: SensitiveGroup) {
  const permissions = getRolePermissions(role);
  if (group === "pricing") return permissions.canViewSensitivePricing;
  if (group === "cost") return permissions.canViewCosts;
  if (group === "gp") return permissions.canViewGp;
  if (group === "supplier") return permissions.canViewSupplierDetails;
  if (group === "customer") return permissions.canViewCustomerDetails;
  if (group === "po") return permissions.canViewPurchaseOrders;
  return permissions.canViewInternalNotes;
}

export function isSensitiveFieldKey(key: string) {
  return sensitiveGroupForKey(key) !== null;
}

export function shouldRedactFieldForRole(key: string, role: UserRole) {
  const group = sensitiveGroupForKey(key);
  return Boolean(group && !canViewGroup(role, group));
}

function redactValue(value: unknown, role: UserRole): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, role));
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = shouldRedactFieldForRole(key, role) ? REDACTED_FIELD_VALUE : redactValue(nestedValue, role);
  }
  return output;
}

export function redactSensitiveFieldsForRole<T>(data: T, role: UserRole): T {
  if (role === "admin") return data;
  return redactValue(data, role) as T;
}

export function redactSensitiveRecordForRole<T extends Record<string, unknown>>(record: T, role: UserRole): T {
  return redactSensitiveFieldsForRole(record, role);
}

export function redactSensitiveFieldsForLlm<T>(data: T): T {
  return redactValue(data, "employee") as T;
}

export function questionRequestsSensitiveCommercialData(question: string) {
  const normalized = question.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /\b(costos?|cost|precio|price|precios|gp|gp rate|margen|margin|gross profit|profit|commission|comision|po|purchase order|pricebook|globalprice|contractglobalprice)\b/.test(normalized);
}
