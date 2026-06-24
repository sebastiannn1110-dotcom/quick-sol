import { describe, expect, it } from "vitest";
import { validateUploadFile } from "@/lib/excel/validators";

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
});
