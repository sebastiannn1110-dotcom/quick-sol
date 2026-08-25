const PRIMARY_MPN_ALIASES = [
  "mpn",
  "manufacturer part number",
  "mfr part number",
  "mfg part number",
  "mfg partno",
  "mfg p/n",
  "mfr #",
  "mfr#"
] as const;

const CONTEXTUAL_MPN_ALIASES = ["mfr", "mfr number"] as const;

export const OPPORTUNITY_HEADER_ALIASES = {
  primaryMpn: PRIMARY_MPN_ALIASES,
  mpn: [...PRIMARY_MPN_ALIASES, ...CONTEXTUAL_MPN_ALIASES],
  supplierOfferMpn: ["mfr", "mfr number", "mfg partno"] as const,
  receivedMpn: ["mfg partno"] as const,
  requestedMpn: ["generic", "mfg p/n", "manufacturer part number", "mpn"] as const,
  offeredMpn: ["mpn quoted", "offered part#", "offered part", "quiksol mpn available"] as const,
  manufacturer: [
    "mfg",
    "manufacturer",
    "maker",
    "brand",
    "manuname",
    "global manufacturer name",
    "global mfg name",
    "clean mfg"
  ] as const,
  offeredManufacturer: ["manufacturer quoted", "manufacturer", "mfr"] as const,
  stockManufacturer: ["mfg"] as const,
  customerReference: [
    "global customer name",
    "customer",
    "client",
    "customer name",
    "requi"
  ] as const,
  supplierReference: [
    "global supplier name",
    "supplier",
    "supplier name",
    "vendor",
    "bpname"
  ] as const,
  requiredDate: [
    "requireddate",
    "required date",
    "need date",
    "startdate",
    "start date",
    "impact date"
  ] as const,
  unitOfMeasure: ["uom", "unit of measure", "unit", "um"] as const,
  demandQuantity: [
    "quantity",
    "required qty",
    "required quantity",
    "demand qty",
    "demand quantity",
    "req qty",
    "needed qty",
    "open qty",
    "rfq qty",
    "shortage qty",
    "qty 1 shortage",
    "qty 2 lead time scheduled"
  ] as const,
  stockQuantity: [
    "stock qty",
    "on hand",
    "on hand qty",
    "available qty",
    "available quantity",
    "inventory qty"
  ] as const,
  excessQuantity: [
    "quantity",
    "excess qty",
    "excess quantity",
    "surplus qty",
    "available excess"
  ] as const,
  supplierQuantity: [
    "qty",
    "quantity",
    "max qty",
    "on hand",
    "on hand qty",
    "available qty"
  ] as const,
  receivedQuantity: ["rcpt qty", "received qty", "receipt qty"] as const,
  purchaseQuantity: ["rcpt qty", "received qty", "receipt qty"] as const,
  quoteQuantity: ["qty", "quantity"] as const,
  eventId: ["orddd", "escalation number", "line id"] as const,
  compId: ["comp id"] as const,
  lineId: ["line id"] as const,
  orddd: ["orddd"] as const,
  item: ["item", "item number", "cpn"] as const,
  facility: ["plant", "facility"] as const,
  targetPrice: [
    "target price",
    "target to vendor",
    "tgt",
    "customers target purchase price",
    "customer's target purchase price"
  ] as const,
  offerPrice: ["best price offered", "quiksol unit price", "price"] as const,
  unitCost: ["cost", "unit cost"] as const,
  currency: ["currency", "currency code", "curr", "moneda"] as const,
  primaryOption: ["sanm unicos"] as const,
  supplierOfferQuantity: ["on hand", "quiksol qty available", "offered stk qty"] as const,
  moq: ["moq"] as const,
  spq: ["spq"] as const,
  dateCode: ["date code yyww", "date code", "dc"] as const,
  coo: ["coo", "coo non china"] as const,
  leadTime: ["lead time wks", "lt wks", "lt weeks"] as const,
  transitTime: ["transit time wks", "transit time weeks"] as const,
  condition: ["condition", "packing"] as const,
  expiryDate: ["expires at", "expiry date", "valid until"] as const
} as const;

export const OPPORTUNITY_STRUCTURAL_HEADER_ALIASES = Array.from(new Set(
  Object.entries(OPPORTUNITY_HEADER_ALIASES)
    .filter(([key]) => key !== "unitOfMeasure")
    .flatMap(([, aliases]) => [...aliases])
));

export const OPPORTUNITY_QUANTITY_HEADER_ALIASES = Array.from(new Set([
  ...OPPORTUNITY_HEADER_ALIASES.demandQuantity,
  ...OPPORTUNITY_HEADER_ALIASES.stockQuantity,
  ...OPPORTUNITY_HEADER_ALIASES.excessQuantity,
  ...OPPORTUNITY_HEADER_ALIASES.supplierQuantity,
  ...OPPORTUNITY_HEADER_ALIASES.receivedQuantity,
  ...OPPORTUNITY_HEADER_ALIASES.purchaseQuantity,
  ...OPPORTUNITY_HEADER_ALIASES.quoteQuantity
]));

const FORBIDDEN_UNIT_SOURCE_TOKENS = new Set([
  "cost",
  "cogs",
  "price",
  "amount",
  "amt",
  "value",
  "currency",
  "margin",
  "gp",
  "profit",
  "usd",
  "eur"
]);

const FORBIDDEN_UNIT_SOURCE_FRAGMENTS = [
  "unitcost",
  "costperunit",
  "unitprice",
  "priceperunit",
  "priceunit",
  "gprate",
  "grossprofit",
  "grossmargin",
  "netprofit"
] as const;

export function normalizeOpportunityHeader(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\u00a0/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\bno\b/g, "number")
    .replace(/\s+/g, " ")
    .trim();
}

function containsWholePhrase(header: string, alias: string) {
  if (!alias) return false;
  return (` ${header} `).includes(` ${alias} `);
}

export function findOpportunityHeaderColumn(
  headers: unknown[],
  aliases: readonly string[],
  options: { allowPartial?: boolean } = {}
) {
  const normalizedHeaders = headers.map(normalizeOpportunityHeader);
  const normalizedAliases = aliases.map(normalizeOpportunityHeader);
  const exact = normalizedHeaders.findIndex((header) => normalizedAliases.includes(header));
  if (exact >= 0) return exact;
  if (options.allowPartial === false) return null;
  const partial = normalizedHeaders.findIndex((header) =>
    normalizedAliases.some((alias) => containsWholePhrase(header, alias))
  );
  return partial >= 0 ? partial : null;
}

export function opportunityHeaderHasAlias(
  headers: string[],
  aliases: readonly string[]
) {
  const normalizedHeaders = headers.map(normalizeOpportunityHeader);
  const normalizedAliases = aliases.map(normalizeOpportunityHeader);
  return normalizedHeaders.some((header) =>
    normalizedAliases.some((alias) => header === alias || containsWholePhrase(header, alias))
  );
}

export function isForbiddenOpportunityUnitSourceHeader(value: unknown) {
  const normalized = normalizeOpportunityHeader(value);
  const tokens = normalized.split(" ").filter(Boolean);
  const compact = tokens.join("");
  return (
    tokens.some((token) => FORBIDDEN_UNIT_SOURCE_TOKENS.has(token)) ||
    /\bg\s+p\b/.test(normalized) ||
    FORBIDDEN_UNIT_SOURCE_FRAGMENTS.some((fragment) => compact.includes(fragment))
  );
}

export function findSafeOpportunityUnitColumn(headers: unknown[]) {
  const normalizedAliases = new Set(
    OPPORTUNITY_HEADER_ALIASES.unitOfMeasure.map(normalizeOpportunityHeader)
  );
  const index = headers.findIndex((header) => {
    const normalized = normalizeOpportunityHeader(header);
    return (
      normalizedAliases.has(normalized) &&
      !isForbiddenOpportunityUnitSourceHeader(normalized)
    );
  });
  return index >= 0 ? index : null;
}
