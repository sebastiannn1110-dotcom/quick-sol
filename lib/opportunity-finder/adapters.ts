import {
  findOpportunityHeaderColumn,
  findSafeOpportunityUnitColumn,
  normalizeOpportunityHeader,
  OPPORTUNITY_HEADER_ALIASES
} from "@/lib/opportunity-finder/aliases";
import type {
  OpportunityColumnMapping,
  OpportunityFileType,
  OpportunitySelectedRole,
  OpportunitySheetProfile,
  OpportunityTemplateType
} from "@/lib/opportunity-finder/types";

export const OPPORTUNITY_MAPPING_VERSIONS = {
  sanmina_spotbuys: "sanmina-spotbuys-v1",
  sanmina_asia_rfq: "sanmina-asia-rfq-v1",
  flex_shortage: "flex-shortage-v1",
  flex_shortage_shifted_offer: "flex-shortage-shifted-offer-v1",
  flex_week_27_rfq: "flex-rfq-wk27-v1",
  flex_week_28_rfq: "flex-rfq-wk28-v1",
  flex_purchase_cube: "flex-purchase-cube-v1",
  quote_database: "quote-database-v1",
  generic: "generic-v2"
} as const satisfies Record<OpportunityTemplateType, string>;

export type OpportunityQuantityMode = "positive" | "absolute" | "historical";

export type OpportunityAdapterColumnMap = {
  mpn: number;
  quantity: number | null;
  quantityMode: OpportunityQuantityMode;
  manufacturer: number | null;
  customerContext: number | null;
  supplierContext: number | null;
  requiredDate: number | null;
  unitOfMeasure: number | null;
  eventSourceId: number | null;
  compId: number | null;
  item: number | null;
  facility: number | null;
  endCustomer: number | null;
  primaryOption: number | null;
  targetPrice: number | null;
  offerPrice: number | null;
  unitCost: number | null;
  currency: number | null;
  moq: number | null;
  spq: number | null;
  dateCode: number | null;
  coo: number | null;
  leadTime: number | null;
  transitTime: number | null;
  condition: number | null;
  expiryDate: number | null;
  templateType: OpportunityTemplateType;
  mappingVersion: string;
  shifted: boolean;
};

export type OpportunityTemplateDetection = {
  templateType: OpportunityTemplateType;
  mappingVersion: string;
  forcedRole: OpportunityFileType | null;
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

const EMBEDDED_OFFER_TEMPLATES = new Set<OpportunityTemplateType>([
  "sanmina_spotbuys",
  "flex_shortage",
  "flex_shortage_shifted_offer"
]);

export function opportunityTemplateHasEmbeddedOffers(
  templateType: OpportunityTemplateType
) {
  return EMBEDDED_OFFER_TEMPLATES.has(templateType);
}

function normalizedHeaderRows(sheets: OpportunitySheetProfile[]) {
  return sheets.flatMap((sheet) => sheet.headerRows.map((row) => ({
    sheet,
    row,
    values: row.headers.map(normalizeOpportunityHeader)
  })));
}

function hasEvery(headers: string[], terms: string[]) {
  const set = new Set(headers.filter(Boolean));
  return terms.every((term) => set.has(normalizeOpportunityHeader(term)));
}

function numericPreviewCount(sheet: OpportunitySheetProfile, sourceColumn: string) {
  return (sheet.previewRows ?? []).filter((row) => {
    const value = row.values[sourceColumn];
    if (value === null || value === undefined || value.trim() === "") return false;
    return Number.isFinite(Number(value.replace(/,/g, "")));
  }).length;
}

export function detectOpportunityTemplate(
  sheets: OpportunitySheetProfile[]
): OpportunityTemplateDetection {
  const rows = normalizedHeaderRows(sheets);

  for (const { values } of rows) {
    if (hasEvery(values, ["Line ID", "ORDDD", "GENERIC", "CLEAN_MFG", "RFQ QTY", "Target_to_Vendor"])) {
      return detected("sanmina_spotbuys", "demand", "sanmina_spotbuys_signature");
    }
  }

  for (const { sheet, values } of rows) {
    if (hasEvery(values, ["Comp ID", "Item", "Escalation Number", "Shortage Qty", "MPN", "Global Mfg Name"])) {
      const standardOffer = hasEvery(values, ["SUPPLIER", "QUIKSOL MPN AVAILABLE", "QUIKSOL QTY AVAILABLE"]);
      const shiftedOffer = !values[15] && values[16] === "manufacturer" && values[17] === "quiksol qty available";
      if (shiftedOffer && !standardOffer) {
        return detected(
          "flex_shortage_shifted_offer",
          "demand",
          "flex_shortage_shifted_offer_signature"
        );
      }
      return detected("flex_shortage", "demand", "flex_shortage_signature");
    }

    if (hasEvery(values, ["MFG P/N", "Alternate P/N's", "QTY 1 (shortage)", "QTY 2 (Lead time/scheduled)", "Offered Part#", "Vendor Code"])) {
      const quantityInD = numericPreviewCount(sheet, "D");
      const quantityInF = numericPreviewCount(sheet, "F");
      if (quantityInD > quantityInF) {
        return detected("flex_week_28_rfq", "demand", "flex_rfq_quantity_in_alternate_column");
      }
      return {
        ...detected("flex_week_27_rfq", "demand", "flex_rfq_quantity_in_qty2_column"),
        confidence: quantityInF > 0 ? "high" : "medium"
      };
    }
  }

  for (const { values } of rows) {
    if (hasEvery(values, ["Company", "Facility", "Global Supplier Name", "Global Customer Name", "Mfg Partno", "Total"])) {
      return detected("flex_purchase_cube", "purchase_history", "flex_purchase_cube_signature");
    }
    if (hasEvery(values, ["MPN", "MFG", "QTY", "Cost", "Price", "Total Price", "GP rate", "GP"])) {
      return detected("quote_database", "quote_history", "quote_database_signature");
    }
    if (hasEvery(values, ["MFG P/N", "MFG", "QTY", "TGT", "OEM", "Application", "Offered Part#", "Vendor Code"])) {
      return detected("sanmina_asia_rfq", "demand", "sanmina_asia_rfq_signature");
    }
  }

  return {
    templateType: "generic",
    mappingVersion: OPPORTUNITY_MAPPING_VERSIONS.generic,
    forcedRole: null,
    confidence: "low",
    reasons: []
  };
}

function detected(
  templateType: Exclude<OpportunityTemplateType, "generic">,
  forcedRole: OpportunityFileType,
  reason: string
): OpportunityTemplateDetection {
  return {
    templateType,
    mappingVersion: OPPORTUNITY_MAPPING_VERSIONS[templateType],
    forcedRole,
    confidence: "high",
    reasons: [reason]
  };
}

function exactColumn(headers: unknown[], ...names: string[]) {
  return findOpportunityHeaderColumn(headers, names, { allowPartial: false });
}

function genericQuantityAliases(role: OpportunitySelectedRole) {
  if (role === "demand") return OPPORTUNITY_HEADER_ALIASES.demandQuantity;
  if (role === "stock") return OPPORTUNITY_HEADER_ALIASES.stockQuantity;
  if (role === "excess") return OPPORTUNITY_HEADER_ALIASES.excessQuantity;
  if (role === "supplier_offer") return OPPORTUNITY_HEADER_ALIASES.supplierQuantity;
  if (role === "received_history") return OPPORTUNITY_HEADER_ALIASES.receivedQuantity;
  if (role === "purchase_history") return OPPORTUNITY_HEADER_ALIASES.purchaseQuantity;
  if (role === "quote_history") return OPPORTUNITY_HEADER_ALIASES.quoteQuantity;
  return [] as const;
}

function emptyMap(
  mpn: number,
  quantity: number | null,
  quantityMode: OpportunityQuantityMode,
  templateType: OpportunityTemplateType
): OpportunityAdapterColumnMap {
  return {
    mpn,
    quantity,
    quantityMode,
    manufacturer: null,
    customerContext: null,
    supplierContext: null,
    requiredDate: null,
    unitOfMeasure: null,
    eventSourceId: null,
    compId: null,
    item: null,
    facility: null,
    endCustomer: null,
    primaryOption: null,
    targetPrice: null,
    offerPrice: null,
    unitCost: null,
    currency: null,
    moq: null,
    spq: null,
    dateCode: null,
    coo: null,
    leadTime: null,
    transitTime: null,
    condition: null,
    expiryDate: null,
    templateType,
    mappingVersion: OPPORTUNITY_MAPPING_VERSIONS[templateType],
    shifted: templateType === "flex_shortage_shifted_offer"
  };
}

export function buildOpportunityAdapterColumnMap(
  headerValues: unknown[],
  role: OpportunitySelectedRole,
  templateType: OpportunityTemplateType = "generic"
): OpportunityAdapterColumnMap | null {
  if (role === "ignore") return null;
  const headers = headerValues.map(normalizeOpportunityHeader);

  if (templateType === "sanmina_spotbuys") {
    const demand = role === "demand";
    const mpn = exactColumn(headers, demand ? "GENERIC" : "MPN Quoted");
    const fallbackMpn = exactColumn(headers, "GENERIC");
    const resolvedMpn = mpn ?? fallbackMpn;
    const quantity = exactColumn(headers, demand ? "RFQ QTY" : "On Hand");
    if (resolvedMpn === null || quantity === null) return null;
    return {
      ...emptyMap(resolvedMpn, quantity, "positive", templateType),
      manufacturer: exactColumn(headers, demand ? "CLEAN_MFG" : "Manufacturer Quoted"),
      customerContext: exactColumn(headers, "CUSTOMER"),
      supplierContext: demand ? null : exactColumn(headers, "Supplier Name"),
      eventSourceId: exactColumn(headers, "ORDDD"),
      item: exactColumn(headers, "item"),
      facility: exactColumn(headers, "Plant"),
      endCustomer: exactColumn(headers, "CUSTOMER"),
      primaryOption: exactColumn(headers, "SANM UNICOS"),
      targetPrice: exactColumn(headers, "Target_to_Vendor"),
      offerPrice: demand ? null : exactColumn(headers, "Best Price Offered"),
      currency: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.currency),
      moq: demand ? null : exactColumn(headers, "MOQ"),
      spq: demand ? null : exactColumn(headers, "SPQ"),
      dateCode: demand ? null : exactColumn(headers, "Date Code (yyww)"),
      leadTime: demand ? null : exactColumn(headers, "Lead Time (wks)"),
      transitTime: demand ? null : exactColumn(headers, "Transit Time (wks)"),
      requiredDate: demand ? null : exactColumn(headers, "Earliest Shipping Date (mm/dd/yy)"),
      coo: demand ? null : exactColumn(headers, "Shipping Point (Country)"),
      condition: demand ? null : exactColumn(headers, "Comments")
    };
  }

  if (templateType === "flex_shortage" || templateType === "flex_shortage_shifted_offer") {
    const demand = role === "demand";
    const mpn = demand
      ? exactColumn(headers, "MPN")
      : templateType === "flex_shortage_shifted_offer"
        ? 16
        : exactColumn(headers, "QUIKSOL MPN AVAILABLE");
    const quantity = demand
      ? exactColumn(headers, "Shortage Qty")
      : templateType === "flex_shortage_shifted_offer"
        ? 17
        : exactColumn(headers, "QUIKSOL QTY AVAILABLE");
    if (mpn === null || quantity === null) return null;
    return {
      ...emptyMap(mpn, quantity, demand ? "absolute" : "positive", templateType),
      manufacturer: demand
        ? exactColumn(headers, "Global Mfg Name")
        : templateType === "flex_shortage_shifted_offer"
          ? null
          : exactColumn(headers, "MANUFACTURER"),
      customerContext: exactColumn(headers, "Global Customer Name"),
      supplierContext: demand
        ? exactColumn(headers, "Global Supplier Name")
        : templateType === "flex_shortage_shifted_offer"
          ? 15
          : exactColumn(headers, "SUPPLIER"),
      requiredDate: exactColumn(headers, "Impact Date"),
      eventSourceId: exactColumn(headers, "Escalation Number"),
      compId: exactColumn(headers, "Comp ID"),
      item: exactColumn(headers, "Item"),
      facility: exactColumn(headers, "Facility"),
      endCustomer: exactColumn(headers, "Global Customer Name"),
      targetPrice: exactColumn(headers, "Target Price"),
      offerPrice: demand
        ? null
        : templateType === "flex_shortage_shifted_offer"
          ? 18
          : exactColumn(headers, "QUIKSOL UNIT PRICE"),
      currency: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.currency),
      coo: demand ? null : templateType === "flex_shortage_shifted_offer" ? 20 : exactColumn(headers, "COO"),
      dateCode: demand ? null : templateType === "flex_shortage_shifted_offer" ? 21 : exactColumn(headers, "DC"),
      leadTime: demand ? null : templateType === "flex_shortage_shifted_offer" ? 22 : exactColumn(headers, "LT WKS"),
      moq: demand ? null : templateType === "flex_shortage_shifted_offer" ? 23 : exactColumn(headers, "MOQ"),
      spq: demand ? null : templateType === "flex_shortage_shifted_offer" ? 24 : exactColumn(headers, "SPQ"),
      condition: demand ? null : templateType === "flex_shortage_shifted_offer" ? 25 : exactColumn(headers, "Comments")
    };
  }

  if (templateType === "flex_week_27_rfq" || templateType === "flex_week_28_rfq") {
    const mpn = exactColumn(headers, "MFG P/N");
    const quantity = templateType === "flex_week_28_rfq" ? 3 : 5;
    if (mpn === null) return null;
    return {
      ...emptyMap(mpn, quantity, "positive", templateType),
      manufacturer: exactColumn(headers, "MFG"),
      item: exactColumn(headers, "CPN"),
      targetPrice: exactColumn(headers, "Customers Target Purchase Price"),
      offerPrice: exactColumn(headers, "Price"),
      currency: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.currency),
      moq: exactColumn(headers, "MOQ"),
      spq: exactColumn(headers, "SPQ"),
      dateCode: exactColumn(headers, "DC"),
      leadTime: exactColumn(headers, "LT(weeks)"),
      coo: exactColumn(headers, "COO (Non China)")
    };
  }

  if (templateType === "sanmina_asia_rfq") {
    const mpn = exactColumn(headers, "MFG P/N");
    const quantity = exactColumn(headers, "QTY");
    if (mpn === null || quantity === null) return null;
    return {
      ...emptyMap(mpn, quantity, "positive", templateType),
      manufacturer: exactColumn(headers, "MFG"),
      customerContext: exactColumn(headers, "OEM"),
      endCustomer: exactColumn(headers, "OEM"),
      item: exactColumn(headers, "CPN"),
      targetPrice: exactColumn(headers, "TGT"),
      offerPrice: exactColumn(headers, "Price"),
      currency: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.currency),
      moq: exactColumn(headers, "MOQ"),
      spq: exactColumn(headers, "SPQ"),
      dateCode: exactColumn(headers, "DC"),
      leadTime: exactColumn(headers, "LT(weeks)"),
      coo: exactColumn(headers, "COO (Non China)")
    };
  }

  if (templateType === "flex_purchase_cube") {
    const mpn = exactColumn(headers, "Mfg Partno");
    if (mpn === null) return null;
    return {
      ...emptyMap(mpn, exactColumn(headers, "RCPT Qty"), "historical", templateType),
      manufacturer: exactColumn(headers, "Global Manufacturer Name"),
      customerContext: exactColumn(headers, "Global Customer Name"),
      supplierContext: exactColumn(headers, "Global Supplier Name"),
      facility: exactColumn(headers, "Facility"),
      item: exactColumn(headers, "Item"),
      currency: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.currency)
    };
  }

  if (templateType === "quote_database") {
    const mpn = exactColumn(headers, "MPN");
    if (mpn === null) return null;
    return {
      ...emptyMap(mpn, exactColumn(headers, "QTY"), "historical", templateType),
      manufacturer: exactColumn(headers, "MFG"),
      unitCost: exactColumn(headers, "Cost"),
      offerPrice: exactColumn(headers, "Price"),
      currency: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.currency)
    };
  }

  const mpn = findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.mpn);
  if (mpn === null) return null;
  const quantity = findOpportunityHeaderColumn(headers, genericQuantityAliases(role));
  const historical = ["received_history", "purchase_history", "quote_history", "sales_history"].includes(role);
  if (!historical && quantity === null) return null;
  return {
    ...emptyMap(mpn, quantity, historical ? "historical" : "positive", "generic"),
    manufacturer: findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.manufacturer),
    customerContext: findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.customerReference),
    supplierContext: findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.supplierReference),
    requiredDate: findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.requiredDate),
    unitOfMeasure: findSafeOpportunityUnitColumn(headers),
    targetPrice: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.targetPrice),
    offerPrice: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.offerPrice),
    unitCost: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.unitCost),
    currency: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.currency),
    moq: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.moq),
    spq: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.spq),
    dateCode: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.dateCode),
    coo: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.coo),
    leadTime: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.leadTime),
    transitTime: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.transitTime),
    condition: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.condition),
    expiryDate: exactColumn(headers, ...OPPORTUNITY_HEADER_ALIASES.expiryDate)
  };
}

export function excelColumnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

export function opportunityColumnMappings(
  map: OpportunityAdapterColumnMap,
  headers: unknown[]
): OpportunityColumnMapping[] {
  const ignored = new Set(["templateType", "mappingVersion", "quantityMode", "shifted"]);
  return Object.entries(map).flatMap(([canonicalField, index]) => {
    if (ignored.has(canonicalField) || typeof index !== "number" || index < 0) return [];
    return [{
      canonicalField,
      sourceHeader: String(headers[index] ?? ""),
      sourceColumn: excelColumnName(index),
      confidence: map.shifted && ["mpn", "quantity", "supplierContext", "offerPrice"].includes(canonicalField)
        ? "review" as const
        : "high" as const,
      mappingVersion: map.mappingVersion
    }];
  });
}

function keyPiece(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000\u001f|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildOpportunityDemandEventKey(input: {
  templateType: OpportunityTemplateType;
  snapshotKey: string;
  orddd?: unknown;
  compId?: unknown;
  item?: unknown;
  escalationNumber?: unknown;
  fallback?: unknown;
}) {
  const snapshot = keyPiece(input.snapshotKey);
  if (input.templateType === "sanmina_spotbuys") {
    const orddd = keyPiece(input.orddd);
    return orddd ? `SANMINA|${snapshot}|${orddd}` : null;
  }
  if (input.templateType === "flex_shortage" || input.templateType === "flex_shortage_shifted_offer") {
    const pieces = [input.compId, input.item, input.escalationNumber].map(keyPiece);
    return pieces.every(Boolean) ? `FLEX|${snapshot}|${pieces.join("|")}` : null;
  }
  const fallback = keyPiece(input.fallback);
  return fallback ? `ROW|${snapshot}|${fallback}` : null;
}
