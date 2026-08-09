const MAX_MPN_LENGTH = 160;

/**
 * This catalog is deliberately small, explicit and versioned.  New aliases must
 * be approved; similarity and substring matches never become equivalence rules.
 */
export const OPPORTUNITY_MANUFACTURER_ALIAS_VERSION = "mfg-aliases-2026-08-01";

const APPROVED_MANUFACTURER_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["TI", "TEXAS INSTRUMENTS"],
  ["TEXAS INSTRUMENTS", "TEXAS INSTRUMENTS"],
  ["TEXAS INSTRUMENTS INC", "TEXAS INSTRUMENTS"],
  ["TEXAS INSTRUMENTS INCORPORATED", "TEXAS INSTRUMENTS"],
  ["ST", "STMICROELECTRONICS"],
  ["STM", "STMICROELECTRONICS"],
  ["ST MICRO", "STMICROELECTRONICS"],
  ["ST MICROELECTRONICS", "STMICROELECTRONICS"],
  ["STMICROELECTRONICS", "STMICROELECTRONICS"],
  ["ON SEMICONDUCTOR", "ONSEMI"],
  ["ON SEMICONDUCTOR INC", "ONSEMI"],
  ["ONSEMI", "ONSEMI"],
  ["INFINEON TECHNOLOGIES", "INFINEON TECHNOLOGIES"],
  ["INFINEON TECHNOLOGIES AG", "INFINEON TECHNOLOGIES"],
  ["DIODES", "DIODES INCORPORATED"],
  ["DIODES INC", "DIODES INCORPORATED"],
  ["DIODES INCORPORATED", "DIODES INCORPORATED"],
  ["MICROCHIP", "MICROCHIP TECHNOLOGY"],
  ["MICROCHIP TECHNOLOGY", "MICROCHIP TECHNOLOGY"],
  ["MICROCHIP TECHNOLOGY INC", "MICROCHIP TECHNOLOGY"],
  ["SAMSUNG", "SAMSUNG"],
  ["MICRON", "MICRON"],
  ["KINGSTON", "KINGSTON"]
];

function normalizeUnicode(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u0000\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\u00A0/g, " ");
}

function normalizeDashes(value: string) {
  // Keep the punctuation boundary while making visually equivalent Unicode
  // hyphens deterministic.
  return value.replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-");
}

function cleanMpnInput(value: unknown) {
  if (value === null || value === undefined) return "";
  return normalizeUnicode(String(value))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MPN_LENGTH);
}

function removeNumericGroupingSeparators(value: string) {
  // Retained for the certified legacy fixture where Excel rendered a numeric
  // identifier with thousands separators. Punctuation in alphanumeric MPNs is
  // never removed from the exact key.
  return /^\d{1,3}([,.]\d{3})+$/.test(value) ? value.replace(/[,.]/g, "") : value;
}

/** Exact MPN identity: NFKC + uppercase + normalized whitespace and dashes. */
export function normalizeOpportunityMpnExact(value: unknown) {
  const text = cleanMpnInput(value);
  if (!text) return "";
  return removeNumericGroupingSeparators(normalizeDashes(text).toUpperCase());
}

/** Search-only key. It must never be sufficient for automatic allocation. */
export function normalizeOpportunityMpnSearch(value: unknown) {
  return normalizeOpportunityMpnExact(value).replace(/[^A-Z0-9]/g, "");
}

export function mpnIdentity(value: unknown) {
  const rawMpn = cleanMpnInput(value);
  const displayMpn = removeNumericGroupingSeparators(rawMpn);
  const normalizedMpn = normalizeOpportunityMpnExact(rawMpn);
  return {
    rawMpn,
    displayMpn,
    normalizedMpn,
    reviewKey: normalizeOpportunityMpnSearch(rawMpn)
  };
}

export function safeContextText(value: unknown, max = 160) {
  if (value === null || value === undefined) return null;
  const text = normalizeUnicode(String(value))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

export function isOpportunityExcelError(value: unknown) {
  if (value === null || value === undefined) return false;
  return /^#(?:N\/A|VALUE!|REF!|DIV\/0!|NAME\?|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/i.test(
    String(value).trim()
  );
}

export function parseOpportunityQuantity(value: unknown) {
  if (value === null || value === undefined || value === "" || isOpportunityExcelError(value)) {
    return { value: null, valid: false, negative: false };
  }
  if (typeof value === "number") {
    return {
      value: Number.isFinite(value) ? value : null,
      valid: Number.isFinite(value),
      negative: Number.isFinite(value) && value < 0
    };
  }
  const text = normalizeUnicode(String(value)).trim();
  if (!text || text.startsWith("=")) {
    return { value: null, valid: false, negative: false };
  }
  const normalized = text
    .replace(/\s/g, "")
    .replace(/^\((.*)\)$/, "-$1")
    .replace(/,/g, "");
  const parsed = Number(normalized);
  return {
    value: Number.isFinite(parsed) ? parsed : null,
    valid: Number.isFinite(parsed),
    negative: Number.isFinite(parsed) && parsed < 0
  };
}

function manufacturerExact(value: string | null | undefined) {
  return (safeContextText(value)?.normalize("NFKC").toUpperCase() ?? "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const APPROVED_MANUFACTURER_MAP = new Map(
  APPROVED_MANUFACTURER_ALIASES.map(([alias, canonical]) => [manufacturerExact(alias), canonical])
);

export function manufacturerIdentity(value: string | null | undefined) {
  const raw = safeContextText(value);
  const exact = manufacturerExact(raw);
  const approvedCanonical = APPROVED_MANUFACTURER_MAP.get(exact);
  return {
    raw,
    exact,
    canonical: approvedCanonical ?? exact,
    approvedAlias: Boolean(exact && approvedCanonical && approvedCanonical !== exact),
    aliasVersion: OPPORTUNITY_MANUFACTURER_ALIAS_VERSION
  };
}

export function normalizeManufacturer(value: string | null | undefined) {
  return manufacturerIdentity(value).canonical;
}

export function manufacturersConflict(left: string | null, right: string | null) {
  const normalizedLeft = normalizeManufacturer(left);
  const normalizedRight = normalizeManufacturer(right);
  if (!normalizedLeft || !normalizedRight) return false;
  // Exact catalog identity only. Substring checks would make short aliases such
  // as ST/TI unsafe and could approve unrelated manufacturers.
  return normalizedLeft !== normalizedRight;
}
