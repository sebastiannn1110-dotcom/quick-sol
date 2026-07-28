import path from "node:path";
import type {
  OpportunityFileType,
  OpportunitySelectedRole
} from "@/lib/opportunity-finder/types";

const ALLOWED_EXTENSIONS = new Set([".xlsx", ".csv"]);
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
  const configured = Number(process.env.OPPORTUNITY_FINDER_MAX_FILE_SIZE_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : 64;
  return megabytes * 1024 * 1024;
}

export function opportunityFinderMaxRowsPerFile() {
  const configured = Number(process.env.OPPORTUNITY_FINDER_MAX_ROWS_PER_FILE);
  return Number.isFinite(configured) && configured > 0 ? configured : 250_000;
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

export function selectedRoleFromDetectedType(
  detectedType: OpportunityFileType
): OpportunitySelectedRole | null {
  if (detectedType === "financial" || detectedType === "unknown") return null;
  return detectedType;
}
