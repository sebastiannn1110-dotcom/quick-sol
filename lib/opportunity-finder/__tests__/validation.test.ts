import { describe, expect, it } from "vitest";
import {
  opportunityFinderMaxFileSizeBytes,
  opportunityFinderMaxRowsPerFile,
  safeOpportunityFileName,
  safeOpportunityStoragePath,
  validateOpportunityFileMetadata
} from "@/lib/opportunity-finder/validation";

describe("Opportunity Finder upload validation", () => {
  it("accepts the real large-workbook envelope without processing the file", () => {
    expect(validateOpportunityFileMetadata({
      fileName: "planned.xlsx",
      fileSize: 28 * 1024 * 1024,
      fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    })).toBeNull();
    expect(opportunityFinderMaxFileSizeBytes()).toBe(64 * 1024 * 1024);
    expect(opportunityFinderMaxRowsPerFile()).toBe(250_000);
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

  it("sanitizes names and creates an owner/job/file scoped storage path", () => {
    expect(safeOpportunityFileName("..\\customer/plan?.xlsx")).toBe("..-customer-plan-.xlsx");
    expect(safeOpportunityStoragePath({
      userId: "owner",
      jobId: "job",
      fileId: "file",
      fileName: "plan.xlsx"
    })).toBe("owner/job/file.xlsx");
  });
});
