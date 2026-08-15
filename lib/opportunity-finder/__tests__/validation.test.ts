import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCanonicalOpportunityStorageReference,
  isCanonicalOpportunityStorageReference,
  opportunityFinderMaxFileSizeBytes,
  opportunityFinderMaxRowsPerFile,
  safeOpportunityFileName,
  safeOpportunityStoragePath,
  validateOpportunityFileMetadata
} from "@/lib/opportunity-finder/validation";

describe("Opportunity Finder upload validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the real large-workbook envelope without processing the file", () => {
    expect(validateOpportunityFileMetadata({
      fileName: "planned.xlsx",
      fileSize: 28 * 1024 * 1024,
      fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    })).toBeNull();
    expect(opportunityFinderMaxFileSizeBytes()).toBe(64 * 1024 * 1024);
    expect(opportunityFinderMaxRowsPerFile()).toBe(250_000);
  });

  it.each([
    ["demand.csv", "text/csv"],
    ["stock.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
  ])("accepts a supported physical upload %s", (fileName, fileType) => {
    expect(validateOpportunityFileMetadata({
      fileName,
      fileSize: 1024,
      fileType
    })).toBeNull();
  });

  it("rejects a normal physical JSON upload", () => {
    expect(validateOpportunityFileMetadata({
      fileName: "platform-snapshot.json",
      fileSize: 1024,
      fileType: "application/json"
    })).toBe("FILE_EXTENSION_INVALID");
  });

  it.each(["payload.exe", "macro.xlsm", "legacy.xls", "binary.xlsb"])(
    "blocks unsafe or unsupported extension %s",
    (fileName) => {
      expect(validateOpportunityFileMetadata({
        fileName,
        fileSize: 1024,
        fileType: "application/octet-stream"
      })).toBe("FILE_TYPE_BLOCKED");
    }
  );

  it("rejects invalid MIME, extension and oversized files", () => {
    expect(validateOpportunityFileMetadata({
      fileName: "data.xlsx",
      fileSize: 1024,
      fileType: "application/x-msdownload"
    })).toBe("FILE_MIME_INVALID");
    expect(validateOpportunityFileMetadata({
      fileName: "data.zip",
      fileSize: 1024,
      fileType: "application/octet-stream"
    })).toBe("FILE_EXTENSION_INVALID");
    expect(validateOpportunityFileMetadata({
      fileName: "data.xlsx",
      fileSize: 65 * 1024 * 1024,
      fileType: "application/octet-stream"
    })).toBe("FILE_TOO_LARGE");
  });

  it("uses the public size fallback but never exceeds the physical 64 MiB cap", () => {
    vi.stubEnv("OPPORTUNITY_FINDER_MAX_FILE_SIZE_MB", "");
    vi.stubEnv("NEXT_PUBLIC_OPPORTUNITY_FINDER_MAX_FILE_SIZE_MB", "48");
    expect(opportunityFinderMaxFileSizeBytes()).toBe(48 * 1024 * 1024);

    vi.stubEnv("OPPORTUNITY_FINDER_MAX_FILE_SIZE_MB", "128");
    expect(opportunityFinderMaxFileSizeBytes()).toBe(64 * 1024 * 1024);
  });

  it("sanitizes names and creates an owner/job/file scoped storage path", () => {
    expect(safeOpportunityFileName("..\\customer/plan?.xlsx")).toBe("..-customer-plan-.xlsx");
    expect(safeOpportunityStoragePath({
      userId: "owner",
      jobId: "job",
      fileId: "file",
      fileName: "plan.xlsx"
    })).toBe("owner/job/file.xlsx");
  });

  it("accepts only the canonical private bucket and owner/job/file path", () => {
    const reference = {
      ownerId: "68d74084-f3ca-41f0-b0dc-a9622a2c04d2",
      jobId: "58e678bf-599f-4bcd-846f-667b06af2ab3",
      fileId: "50c68859-b18d-46fc-8bf4-ebc5209dd47c",
      originalFileName: "Demand.CSV",
      storageBucket: "opportunity-finder",
      storagePath: "68d74084-f3ca-41f0-b0dc-a9622a2c04d2/58e678bf-599f-4bcd-846f-667b06af2ab3/50c68859-b18d-46fc-8bf4-ebc5209dd47c.csv"
    };

    expect(isCanonicalOpportunityStorageReference(reference)).toBe(true);
    expect(isCanonicalOpportunityStorageReference({
      ...reference,
      storageBucket: "private-customer-documents"
    })).toBe(false);
    expect(isCanonicalOpportunityStorageReference({
      ...reference,
      storagePath: `attacker/${reference.jobId}/${reference.fileId}.csv`
    })).toBe(false);
    expect(isCanonicalOpportunityStorageReference({
      ...reference,
      originalFileName: "payload.xlsm",
      storagePath: `${reference.ownerId}/${reference.jobId}/${reference.fileId}.xlsm`
    })).toBe(false);
    expect(() => assertCanonicalOpportunityStorageReference({
      ...reference,
      storagePath: `${reference.ownerId}/${reference.jobId}/another-file.csv`
    })).toThrow("OPPORTUNITY_STORAGE_REFERENCE_INVALID");
  });
});
