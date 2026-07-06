import { describe, expect, it } from "vitest";
import { validateUploadFile, validateUploadMetadata } from "@/lib/excel/validators";

describe("validateUploadFile", () => {
  it("rejects macro-enabled spreadsheets", () => {
    const file = new File(["x"], "danger.xlsm", {
      type: "application/vnd.ms-excel.sheet.macroEnabled.12"
    });

    expect(validateUploadFile(file).join(" ")).toContain("Macro");
  });

  it("accepts csv files", () => {
    const file = new File(["a,b\n1,2"], "valid.csv", { type: "text/csv" });
    expect(validateUploadFile(file)).toEqual([]);
  });

  it("validates direct upload metadata without reading file bytes", () => {
    expect(validateUploadMetadata({
      fileName: "large.xlsx",
      fileSize: 10 * 1024 * 1024,
      fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    })).toEqual([]);
  });

  it("rejects legacy xls files in the streaming upload flow", () => {
    expect(validateUploadMetadata({
      fileName: "legacy.xls",
      fileSize: 1024,
      fileType: "application/vnd.ms-excel"
    }).join(" ")).toContain("Only .xlsx or .csv");
  });
});
