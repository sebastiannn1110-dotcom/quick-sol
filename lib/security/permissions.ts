import type { UserRole } from "@/lib/types";

export type RolePermissions = {
  canViewSensitivePricing: boolean;
  canViewCosts: boolean;
  canViewGp: boolean;
  canViewSupplierDetails: boolean;
  canViewCustomerDetails: boolean;
  canViewPurchaseOrders: boolean;
  canViewInternalNotes: boolean;
  canViewClients: boolean;
  canViewOpportunities: boolean;
  canManageClients: boolean;
  canAssignClientUploads: boolean;
  canArchiveClients: boolean;
  canViewPrivateClientIdentification: boolean;
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

const SAFE_ACCOUNT_CONTEXT_KEYS = new Set(["accountclients", "accountclientid", "accountclientname"]);

function normalizedKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function sensitiveGroupForKey(key: string): SensitiveGroup | null {
  const normalized = normalizedKey(key);
  if (SAFE_ACCOUNT_CONTEXT_KEYS.has(normalized)) return null;
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
      canViewInternalNotes: true,
      canViewClients: true,
      canViewOpportunities: true,
      canManageClients: true,
      canAssignClientUploads: true,
      canArchiveClients: true,
      canViewPrivateClientIdentification: true
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
      canViewInternalNotes: false,
      canViewClients: true,
      canViewOpportunities: true,
      canManageClients: true,
      canAssignClientUploads: true,
      canArchiveClients: true,
      canViewPrivateClientIdentification: true
    };
  }

  return {
    canViewSensitivePricing: false,
    canViewCosts: false,
    canViewGp: false,
    canViewSupplierDetails: false,
    canViewCustomerDetails: false,
    canViewPurchaseOrders: false,
    canViewInternalNotes: false,
    canViewClients: true,
    canViewOpportunities: true,
    canManageClients: false,
    canAssignClientUploads: false,
    canArchiveClients: false,
    canViewPrivateClientIdentification: false
  };
}

export function canManageClients(role: UserRole) {
  return getRolePermissions(role).canManageClients;
}

export function canAssignClientUploads(role: UserRole) {
  return getRolePermissions(role).canAssignClientUploads;
}

export function canArchiveClients(role: UserRole) {
  return getRolePermissions(role).canArchiveClients;
}

export function canViewPrivateClientIdentification(role: UserRole) {
  return getRolePermissions(role).canViewPrivateClientIdentification;
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

export function canUseSensitiveCommercialDataInAi(role: UserRole) {
  void role;
  return false;
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
  const asksOnlyForStructure =
    /\b(columnas?|campos?|headers?|encabezados?|estructura|perfil|schema|formato|plantilla|representa|representan|detectaste)\b/.test(normalized) &&
    /\b(archivo|upload|carga|excel|sheet|hoja|subid[oa]|ultim[oa])\b/.test(normalized) &&
    !/\b(muestrame|mostrar|lista|listame|valores?|datos?|registros?|tenemos|tienen|hay|cuant[oa]s?|total|promedio|calcula|calcular|gp\s*rate|margen(?:es)?|profit)\b/.test(normalized);
  if (asksOnlyForStructure) return false;

  return /\b(costos?|cost|precio(?:s)?|price(?:s)?|margen(?:es)?|margin(?:s)?|gp(?:\s*rate)?|gross\s*profit|profit|commission|comision|unit\s*cost|price\s*book|pricebook|global\s*price|globalprice|contract\s*global\s*price|contractglobalprice|usd\s*extended\s*price|po|purchase\s*order|notas?\s+internas?|internal\s+notes?)\b/.test(normalized);
}

export function shouldBlockSensitiveAiQuestion(question: string, role: UserRole) {
  return questionRequestsSensitiveCommercialData(question) && !canUseSensitiveCommercialDataInAi(role);
}
