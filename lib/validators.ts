import {
  BUSINESS_CATEGORIES,
  SELECTABLE_UPLOAD_CATEGORIES,
  type BusinessCategory,
  type JsonPrimitive,
  type JsonRecord,
  type UploadCategory
} from "@/lib/types";

export const ALLOWED_FILE_EXTENSIONS = [".xlsx", ".xls", ".csv"];
export const DEFAULT_MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

export function getMaxUploadSizeBytes() {
  const configured = Number(process.env.MAX_UPLOAD_SIZE_MB);
  if (Number.isFinite(configured) && configured > 0) {
    return configured * 1024 * 1024;
  }

  return DEFAULT_MAX_UPLOAD_SIZE_BYTES;
}

export function getFileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

export function sanitizeFileName(fileName: string) {
  const safeName = fileName
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return safeName || "uploaded-file";
}

export function isAllowedFileType(fileName: string) {
  return ALLOWED_FILE_EXTENSIONS.includes(getFileExtension(fileName));
}

export function isBusinessCategory(value: string): value is BusinessCategory {
  return BUSINESS_CATEGORIES.includes(value as BusinessCategory);
}

export function isUploadCategory(value: string): value is UploadCategory {
  return SELECTABLE_UPLOAD_CATEGORIES.includes(value as UploadCategory);
}

export function validateUploadPayload(input: {
  employeeId?: string | null;
  employeeName?: string | null;
  department?: string | null;
  region?: string | null;
  selectedCategory?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
}) {
  const errors: string[] = [];

  if (!input.employeeId?.trim()) errors.push("Employee ID is required.");
  if (!input.employeeName?.trim()) errors.push("Employee Name is required.");
  if (!input.department?.trim()) errors.push("Department is required.");
  if (!input.region?.trim()) errors.push("Region is required.");
  if (!input.selectedCategory?.trim()) errors.push("Upload Category is required.");

  if (input.selectedCategory && !isUploadCategory(input.selectedCategory)) {
    errors.push("Upload Category is not supported.");
  }

  if (!input.fileName) {
    errors.push("File is required.");
  } else if (!isAllowedFileType(input.fileName)) {
    errors.push("Only .xlsx, .xls or .csv files are allowed.");
  }

  const maxUploadSize = getMaxUploadSizeBytes();
  if (!input.fileSize || input.fileSize <= 0) {
    errors.push("File is empty.");
  } else if (input.fileSize > maxUploadSize) {
    errors.push(`File exceeds the ${Math.round(maxUploadSize / 1024 / 1024)} MB limit.`);
  }

  return errors;
}

export function cleanHeader(header: string) {
  return header
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactKey(header: string) {
  return cleanHeader(header).replace(/\s+/g, "");
}

export function isEmptyValue(value: unknown) {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  );
}

export function isEmptyRow(row: Record<string, unknown>) {
  return Object.values(row).every(isEmptyValue);
}

export function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const stripped = value
    .replace(/[%,$]/g, "")
    .replace(/\s/g, "")
    .replace(/,(?=\d{3}(\D|$))/g, "");
  const numberValue = Number(stripped);

  if (!Number.isFinite(numberValue)) return null;

  if (/%/.test(value) && numberValue > 1) {
    return numberValue / 100;
  }

  return numberValue;
}

export function normalizeDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "number" && value > 25569 && value < 60000) {
    const milliseconds = (value - 25569) * 86400 * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof value !== "string" || !value.trim()) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function sanitizeCellValue(value: unknown): JsonPrimitive {
  if (isEmptyValue(value)) return null;

  if (value instanceof Date) {
    return normalizeDate(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  const stringValue = String(value).replace(/\u0000/g, "").trim();
  if (!stringValue) return null;

  if (/^[=+\-@]/.test(stringValue)) {
    return `'${stringValue}`;
  }

  return stringValue;
}

export function cleanRawRow(row: Record<string, unknown>): JsonRecord {
  return Object.entries(row).reduce<JsonRecord>((acc, [key, value]) => {
    const header = String(key).trim();
    if (!header || header.startsWith("__EMPTY")) return acc;

    const cleanedValue = sanitizeCellValue(value);
    if (!isEmptyValue(cleanedValue)) {
      acc[header] = cleanedValue;
    }

    return acc;
  }, {});
}
