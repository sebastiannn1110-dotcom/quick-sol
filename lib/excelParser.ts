import * as XLSX from "xlsx";
import type { ParsedSheetRow } from "@/lib/types";
import { cleanRawRow, isEmptyRow } from "@/lib/validators";

export async function parseExcelOrCsv(file: File): Promise<ParsedSheetRow[]> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(Buffer.from(arrayBuffer), {
    type: "buffer",
    cellDates: true,
    cellFormula: false,
    raw: false
  });

  const rows: ParsedSheetRow[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
      defval: null,
      raw: false,
      blankrows: false
    });

    jsonRows.forEach((row, index) => {
      if (isEmptyRow(row)) return;

      const cleanedRow = cleanRawRow(row);
      if (Object.keys(cleanedRow).length === 0) return;

      rows.push({
        sourceSheet: sheetName,
        originalRowIndex: index + 2,
        rawData: cleanedRow
      });
    });
  }

  return rows;
}
