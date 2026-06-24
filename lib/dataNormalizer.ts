import type { BusinessCategory, JsonPrimitive, JsonRecord } from "@/lib/types";
import { cleanHeader, compactKey, isEmptyValue, normalizeDate, normalizeNumber } from "@/lib/validators";

type FieldMap = Record<string, string[]>;

const ALIASES: Partial<Record<BusinessCategory, FieldMap>> = {
  Inventory: {
    partNumber: ["part number", "pn", "mpn", "manufacturer part number", "part no", "part"],
    manufacturer: ["manufacturer", "brand", "mfg"],
    componentCategory: ["component category", "category", "type", "product category"],
    description: ["description", "desc", "item description"],
    quantityAvailable: ["qty", "quantity", "stock", "quantity available", "available qty", "inventory"],
    warehouseLocation: ["warehouse", "warehouse location", "location"],
    dateCode: ["date code", "dc"],
    condition: ["condition", "part condition"],
    moq: ["moq", "minimum order quantity"],
    leadTime: ["lead time", "leadtime"],
    unitCost: ["unit cost", "cost", "buy price"],
    sellingPrice: ["selling price", "sale price", "price", "sell price"],
    supplier: ["supplier", "vendor", "source"],
    status: ["status", "inventory status", "availability"]
  },
  Customers: {
    companyName: ["company name", "company", "customer", "customer name", "account"],
    customerType: ["customer type", "type", "segment"],
    country: ["country", "market"],
    contactName: ["contact name", "contact", "buyer"],
    email: ["email", "email address"],
    phone: ["phone", "telephone", "mobile"],
    industry: ["industry", "vertical"],
    assignedSalesperson: ["assigned salesperson", "salesperson", "account manager", "sales rep"],
    lastPurchaseDate: ["last purchase date", "last order", "last transaction"],
    creditTerms: ["credit terms", "terms"],
    customerPriority: ["customer priority", "priority", "tier"],
    notes: ["notes", "comments"]
  },
  Suppliers: {
    supplierName: ["supplier name", "supplier", "vendor"],
    country: ["country", "market"],
    contactPerson: ["contact person", "contact", "representative"],
    email: ["email", "email address"],
    productCategories: ["product categories", "categories", "product lines"],
    reliabilityScore: ["reliability score", "reliability", "score"],
    deliveryTime: ["delivery time", "lead time"],
    paymentTerms: ["payment terms", "terms"],
    certifications: ["certifications", "certification"],
    lastTransaction: ["last transaction", "last purchase"],
    riskLevel: ["risk level", "risk"]
  },
  RFQ: {
    rfqId: ["rfq id", "rfq", "quote id", "request id"],
    customer: ["customer", "company", "account"],
    partNumber: ["part number", "pn", "mpn"],
    manufacturer: ["manufacturer", "brand", "mfg"],
    quantityRequested: ["quantity requested", "qty requested", "quantity", "qty"],
    targetPrice: ["target price", "target"],
    quotedPrice: ["quoted price", "quote price", "quoted"],
    supplierSource: ["supplier source", "source", "supplier"],
    margin: ["margin", "gross margin"],
    salesperson: ["salesperson", "sales rep", "owner"],
    status: ["status", "rfq status"],
    dateRequested: ["date requested", "request date"],
    deadline: ["deadline", "due date"]
  },
  Orders: {
    orderId: ["order id", "sales order", "so", "po", "purchase order"],
    customer: ["customer", "company", "account"],
    partNumber: ["part number", "pn", "mpn"],
    quantitySold: ["quantity sold", "qty sold", "quantity", "qty"],
    salePrice: ["sale price", "selling price", "unit price"],
    totalSale: ["total sale", "total", "revenue", "amount"],
    supplierCost: ["supplier cost", "cost", "buy cost"],
    grossMargin: ["gross margin", "margin"],
    paymentStatus: ["payment status", "payment"],
    shippingStatus: ["shipping status", "shipment status"],
    invoiceNumber: ["invoice number", "invoice", "invoice no"],
    salesperson: ["salesperson", "sales rep", "owner"]
  },
  Logistics: {
    shipmentId: ["shipment id", "shipment", "shipping id"],
    orderId: ["order id", "sales order", "so"],
    origin: ["origin", "ship from"],
    destination: ["destination", "ship to"],
    carrier: ["carrier", "forwarder"],
    trackingNumber: ["tracking number", "tracking", "awb"],
    shippingCost: ["shipping cost", "freight cost", "cost"],
    estimatedArrival: ["estimated arrival", "eta", "arrival date"],
    currentStatus: ["current status", "status", "shipment status"],
    customsStatus: ["customs status", "customs"],
    deliveryConfirmation: ["delivery confirmation", "delivered", "pod"]
  },
  "Quality Inspection": {
    inspectionId: ["inspection id", "inspection", "report id"],
    partNumber: ["part number", "pn", "mpn"],
    manufacturer: ["manufacturer", "brand", "mfg"],
    supplier: ["supplier", "vendor"],
    batchLotNumber: ["batch lot number", "lot number", "batch", "lot"],
    dateCode: ["date code", "dc"],
    visualInspection: ["visual inspection", "visual"],
    electricalTest: ["electrical test", "test"],
    authenticityResult: ["authenticity result", "authenticity"],
    inspector: ["inspector", "qa inspector"],
    photos: ["photos", "photo links"],
    reportPdf: ["report pdf", "pdf", "report"],
    finalStatus: ["final status", "status", "result"]
  },
  "Market Insights": {
    componentCategory: ["component category", "category", "product category"],
    partNumber: ["part number", "pn", "mpn"],
    marketTrend: ["market trend", "trend"],
    averagePrice: ["average price", "avg price", "price"],
    region: ["region", "market"],
    demandLevel: ["demand level", "demand"],
    shortageRisk: ["shortage risk", "risk"],
    forecast: ["forecast", "outlook"],
    source: ["source", "data source"],
    updatedDate: ["updated date", "last updated", "date"]
  },
  Finance: {
    productCost: ["product cost", "cost", "cogs"],
    sellingPrice: ["selling price", "sale price", "revenue"],
    grossMargin: ["gross margin", "margin"],
    shippingCost: ["shipping cost", "freight cost"],
    taxesDuties: ["taxes duties", "taxes", "duties"],
    netProfit: ["net profit", "profit"],
    currency: ["currency", "ccy"],
    exchangeRate: ["exchange rate", "fx rate"],
    paymentTerms: ["payment terms", "terms"],
    commission: ["commission", "sales commission"]
  },
  Employees: {
    employeeName: ["employee name", "employee", "name"],
    department: ["department", "dept"],
    region: ["region", "market"],
    role: ["role", "title"],
    assignedCustomers: ["assigned customers", "customers"],
    assignedSuppliers: ["assigned suppliers", "suppliers"],
    monthlySales: ["monthly sales", "sales"],
    tasksPending: ["tasks pending", "pending tasks"],
    performanceScore: ["performance score", "score"]
  },
  Unknown: {}
};

const NUMBER_FIELDS = new Set([
  "quantityAvailable",
  "moq",
  "unitCost",
  "sellingPrice",
  "reliabilityScore",
  "quantityRequested",
  "targetPrice",
  "quotedPrice",
  "margin",
  "quantitySold",
  "salePrice",
  "totalSale",
  "supplierCost",
  "grossMargin",
  "shippingCost",
  "averagePrice",
  "productCost",
  "taxesDuties",
  "netProfit",
  "exchangeRate",
  "commission",
  "monthlySales",
  "tasksPending",
  "performanceScore"
]);

const DATE_FIELDS = new Set([
  "lastPurchaseDate",
  "lastTransaction",
  "dateRequested",
  "deadline",
  "estimatedArrival",
  "updatedDate"
]);

function getValueByAliases(row: JsonRecord, aliases: string[]) {
  const lookup = Object.entries(row).map(([key, value]) => ({
    key,
    cleanKey: cleanHeader(key),
    compact: compactKey(key),
    value
  }));

  for (const alias of aliases) {
    const cleanAlias = cleanHeader(alias);
    const compactAlias = compactKey(alias);
    const exact = lookup.find(
      (entry) => entry.cleanKey === cleanAlias || entry.compact === compactAlias
    );
    if (exact && !isEmptyValue(exact.value)) return exact.value;
  }

  for (const alias of aliases) {
    const cleanAlias = cleanHeader(alias);
    const partial = lookup.find(
      (entry) =>
        !isEmptyValue(entry.value) &&
        (entry.cleanKey.includes(cleanAlias) || cleanAlias.includes(entry.cleanKey))
    );
    if (partial) return partial.value;
  }

  return null;
}

function normalizeFieldValue(field: string, value: JsonPrimitive | JsonPrimitive[]) {
  if (Array.isArray(value)) return value;
  if (isEmptyValue(value)) return null;

  if (DATE_FIELDS.has(field)) {
    return normalizeDate(value) ?? value;
  }

  if (NUMBER_FIELDS.has(field)) {
    return normalizeNumber(value) ?? value;
  }

  return value;
}

export function normalizeBusinessRecord(category: BusinessCategory, row: JsonRecord): JsonRecord {
  if (category === "Unknown") {
    return { ...row };
  }

  const fieldMap = ALIASES[category] ?? {};
  return Object.entries(fieldMap).reduce<JsonRecord>((normalized, [field, aliases]) => {
    const value = getValueByAliases(row, aliases);
    const normalizedValue = normalizeFieldValue(field, value);
    if (!isEmptyValue(normalizedValue)) {
      normalized[field] = normalizedValue as JsonPrimitive | JsonPrimitive[];
    }
    return normalized;
  }, {});
}

export function buildSearchableText(input: {
  employeeId: string;
  employeeName: string;
  department: string;
  region: string;
  category: BusinessCategory;
  rawData: JsonRecord;
  normalizedData: JsonRecord;
}) {
  return [
    input.employeeId,
    input.employeeName,
    input.department,
    input.region,
    input.category,
    ...Object.values(input.rawData),
    ...Object.values(input.normalizedData)
  ]
    .flat()
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}

export function getNormalizedPrimaryValue(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (!isEmptyValue(value) && !Array.isArray(value)) return String(value);
  }
  return "";
}
