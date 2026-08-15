import path from "node:path";
import type {
  OpportunityFileType,
  OpportunitySelectedRole
} from "@/lib/opportunity-finder/types";

const ALLOWED_EXTENSIONS = new Set([".xlsx", ".csv"]);
export const OPPORTUNITY_FINDER_STORAGE_BUCKET = "opportunity-finder";
const OPPORTUNITY_FINDER_PHYSICAL_MAX_FILE_SIZE_MB = 64;
const BLOCKED_EXTENSIONS = new Set([
  ".xls", ".xlsm", ".xlsb", ".xlam", ".exe", ".bat", ".cmd", ".js", ".ps1", ".vbs", ".scr"
]);
const ALLOWED_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
  ""
]);

export function opportunityFinderMaxFileSizeBytes() {
  const configured = Number(
    process.env.OPPORTUNITY_FINDER_MAX_FILE_SIZE_MB?.trim()
    || process.env.NEXT_PUBLIC_OPPORTUNITY_FINDER_MAX_FILE_SIZE_MB?.trim()
  );
  const megabytes = Number.isFinite(configured) && configured > 0
    ? Math.min(configured, OPPORTUNITY_FINDER_PHYSICAL_MAX_FILE_SIZE_MB)
    : OPPORTUNITY_FINDER_PHYSICAL_MAX_FILE_SIZE_MB;
  return Math.floor(megabytes * 1024 * 1024);
}

export function opportunityFinderMaxRowsPerFile() {
  const configured = Number(process.env.OPPORTUNITY_FINDER_MAX_ROWS_PER_FILE);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 250_000;
}

export function opportunityFinderMaxXlsxUncompressedBytes() {
  const configured = Number(process.env.OPPORTUNITY_FINDER_MAX_XLSX_UNCOMPRESSED_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : 512;
  return Math.floor(megabytes * 1024 * 1024);
}

export function opportunityFinderMaxXlsxEntries() {
  const configured = Number(process.env.OPPORTUNITY_FINDER_MAX_XLSX_ENTRIES);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 20_000;
}

export function opportunityFinderMaxCompressionRatio() {
  const configured = Number(process.env.OPPORTUNITY_FINDER_MAX_XLSX_COMPRESSION_RATIO);
  return Number.isFinite(configured) && configured > 0 ? configured : 200;
}

export function opportunityFinderXlsxStreamingThresholdBytes() {
  const configured = Number(process.env.OPPORTUNITY_FINDER_XLSX_STREAMING_THRESHOLD_MB);
  const megabytes = Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.min(configured, 64))
    : 16;
  return Math.floor(megabytes * 1024 * 1024);
}

export function validateOpportunityFileMetadata(input: {
  fileName: string;
  fileSize: number;
  fileType?: string | null;
}) {
  const extension = path.extname(input.fileName).toLowerCase();
  if (!input.fileName.trim()) return "FILE_NAME_REQUIRED";
  if (!Number.isFinite(input.fileSize) || input.fileSize <= 0) return "FILE_EMPTY";
  if (input.fileSize > opportunityFinderMaxFileSizeBytes()) return "FILE_TOO_LARGE";
  if (BLOCKED_EXTENSIONS.has(extension)) return "FILE_TYPE_BLOCKED";
  if (!ALLOWED_EXTENSIONS.has(extension)) return "FILE_EXTENSION_INVALID";
  if (!ALLOWED_MIME_TYPES.has(input.fileType ?? "")) return "FILE_MIME_INVALID";
  return null;
}

export function safeOpportunityFileName(value: string) {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return sanitized || "opportunity-file.xlsx";
}

export function safeOpportunityStoragePath(input: {
  userId: string;
  jobId: string;
  fileId: string;
  fileName: string;
}) {
  const extension = path.extname(input.fileName).toLowerCase();
  return `${input.userId}/${input.jobId}/${input.fileId}${extension}`;
}

export function isCanonicalOpportunityStorageReference(input: {
  ownerId: string;
  jobId: string;
  fileId: string;
  originalFileName: string;
  storageBucket: string;
  storagePath: string;
}) {
  const extension = path.extname(input.originalFileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return false;
  if (input.storageBucket !== OPPORTUNITY_FINDER_STORAGE_BUCKET) return false;
  return input.storagePath === safeOpportunityStoragePath({
    userId: input.ownerId,
    jobId: input.jobId,
    fileId: input.fileId,
    fileName: input.originalFileName
  });
}

export function assertCanonicalOpportunityStorageReference(
  input: Parameters<typeof isCanonicalOpportunityStorageReference>[0]
) {
  if (!isCanonicalOpportunityStorageReference(input)) {
    throw new Error("OPPORTUNITY_STORAGE_REFERENCE_INVALID");
  }
}

export function selectedRoleFromDetectedType(
  detectedType: OpportunityFileType
): OpportunitySelectedRole | null {
  if (detectedType === "financial" || detectedType === "unknown") return null;
  return detectedType;
}
