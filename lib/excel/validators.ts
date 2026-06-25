import { z } from "zod";
import { SECURITY_LIMITS } from "@/lib/security/env";

const ALLOWED_EXTENSIONS = [".xlsx", ".xls", ".csv"];
const BLOCKED_EXTENSIONS = [".xlsm", ".exe", ".bat", ".cmd", ".js", ".ps1", ".vbs", ".scr"];
const ALLOWED_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream"
]);

export const uploadFormSchema = z.object({
  selectedCategory: z.string().min(1).default("Auto Detect"),
  department: z.string().trim().min(1, "Department is required."),
  region: z.string().trim().min(1, "Region is required."),
  notes: z.string().trim().max(2000).optional().or(z.literal(""))
});

export const recordsFilterSchema = z.object({
  query: z.string().optional(),
  category: z.string().optional(),
  uploadedBy: z.string().uuid().optional(),
  uploadBatchId: z.string().uuid().optional(),
  customer: z.string().optional(),
  supplier: z.string().optional(),
  mpn: z.string().optional(),
  manufacturer: z.string().optional(),
  lineId: z.string().optional(),
  po: z.string().optional(),
  status: z.string().optional(),
  country: z.string().optional(),
  department: z.string().optional(),
  region: z.string().optional(),
  hasErrors: z.enum(["true", "false"]).optional(),
  gpRateMin: z.coerce.number().optional(),
  gpRateMax: z.coerce.number().optional(),
  costMin: z.coerce.number().optional(),
  costMax: z.coerce.number().optional(),
  priceMin: z.coerce.number().optional(),
  priceMax: z.coerce.number().optional(),
  qtyMin: z.coerce.number().optional(),
  qtyMax: z.coerce.number().optional(),
  uploadDateFrom: z.string().optional(),
  uploadDateTo: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

export function getFileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

export function sanitizeFileName(fileName: string) {
  const baseName = fileName
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return baseName || "uploaded-file";
}

export function validateUploadFile(file: File) {
  const extension = getFileExtension(file.name);
  const errors: string[] = [];

  if (!file.size) errors.push("File is empty.");
  if (file.size > SECURITY_LIMITS.maxUploadSizeBytes) {
    errors.push(
      `File exceeds the ${Math.round(SECURITY_LIMITS.maxUploadSizeBytes / 1024 / 1024)} MB limit.`
    );
  }
  if (BLOCKED_EXTENSIONS.includes(extension)) {
    errors.push("Macro, script or executable files are not allowed.");
  }
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    errors.push("Only .xlsx, .xls or .csv files are allowed.");
  }
  if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
    errors.push("File MIME type is not allowed for Excel/CSV imports.");
  }

  return errors;
}

export function safeStoragePath(userId: string, uploadBatchId: string, fileName: string) {
  const extension = getFileExtension(fileName) || ".xlsx";
  return `${userId}/${uploadBatchId}/${crypto.randomUUID()}${extension}`;
}
