import { normalizePartNumberForMatch } from "@/lib/stock-needs/stock-needs";

function cleanMpnInput(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u0000/g, "").trim().slice(0, 160);
}

function removeNumericGroupingSeparators(value: string) {
  return /^\d{1,3}([,.]\d{3})+$/.test(value) ? value.replace(/[,.]/g, "") : value;
}

export function mpnIdentity(value: unknown) {
  const rawMpn = cleanMpnInput(value);
  const displayMpn = removeNumericGroupingSeparators(rawMpn);
  const normalizedMpn = normalizePartNumberForMatch(rawMpn) ?? "";
  return {
    rawMpn,
    displayMpn,
    normalizedMpn,
    reviewKey: normalizedMpn.replace(/[^A-Z0-9]/g, "")
  };
}

export function safeContextText(value: unknown, max = 160) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/\u0000/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

export function parseOpportunityQuantity(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return { value: null, valid: false, negative: false };
  }
  if (typeof value === "number") {
    return {
      value: Number.isFinite(value) ? value : null,
      valid: Number.isFinite(value),
      negative: Number.isFinite(value) && value < 0
    };
  }
  const text = String(value).trim();
  if (!text) return { value: null, valid: false, negative: false };
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

export function normalizeManufacturer(value: string | null | undefined) {
  const text = safeContextText(value)?.toUpperCase() ?? "";
  const aliases: Record<string, string> = {
    TI: "TEXASINSTRUMENTS",
    "TEXAS INSTRUMENTS": "TEXASINSTRUMENTS",
    ST: "STMICROELECTRONICS",
    STM: "STMICROELECTRONICS",
    "ST MICRO": "STMICROELECTRONICS",
    SAMSUNG: "SAMSUNG",
    MICRON: "MICRON",
    KINGSTON: "KINGSTON"
  };
  return aliases[text] ?? text.replace(/[^A-Z0-9]/g, "");
}

export function manufacturersConflict(left: string | null, right: string | null) {
  const normalizedLeft = normalizeManufacturer(left);
  const normalizedRight = normalizeManufacturer(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return !(
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}
