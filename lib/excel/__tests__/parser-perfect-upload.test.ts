import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseExcelWorkbook } from "@/lib/excel/parser";

describe("parseExcelWorkbook perfect upload fixture", () => {
  it("imports the generated Quiksol clean workbook without errors", async () => {
    const filePath = path.resolve(process.cwd(), "test-files/quiksol_perfect_upload_clean.xlsx");
    const bytes = await readFile(filePath);
    const file = new File([new Uint8Array(bytes)], "quiksol_perfect_upload_clean.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });

    const result = await parseExcelWorkbook(file);

    expect(result.detectedCategory).toBe("Sales Margin");
    expect(result.totalRows).toBe(1000);
    expect(result.validRows).toBe(1000);
    expect(result.invalidRows).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.dataQualityScore).toBe(100);
  });
});
