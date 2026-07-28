import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const sourceDirectory = process.argv[2];
const requestedFiles = new Set(process.argv.slice(3).map((value) => value.toLowerCase()));
if (!sourceDirectory) {
  throw new Error("Usage: node scripts/profile-opportunity-files.mjs <directory>");
}

const structuralKeywords =
  /mpn|mfr|mfg|part|item|qty|quantity|stock|maker|brand|manufacturer|supplier|customer|required|date|price|cost|total|aging|invoice|credit|balance|sales|gp|rcpt|requi|description|pdl/i;

for (const fileName of fs.readdirSync(sourceDirectory).filter((value) =>
  value.toLowerCase().endsWith(".xlsx") &&
  (!requestedFiles.size || requestedFiles.has(value.toLowerCase()))
)) {
  const filePath = path.join(sourceDirectory, fileName);
  const startedAt = performance.now();
  const workbook = XLSX.readFile(filePath, {
    dense: true,
    cellDates: true,
    cellFormula: false
  });

  process.stdout.write(`${JSON.stringify({
    file: fileName,
    sizeBytes: fs.statSync(filePath).size,
    sheetCount: workbook.SheetNames.length,
    loadMs: Math.round(performance.now() - startedAt)
  })}\n`);

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: null,
      range: 0,
      blankrows: true,
      raw: false
    }).slice(0, 35);
    let candidate = { rowIndex: -1, score: -1, headers: [] };
    const structuralRows = [];

    rows.forEach((row, rowIndex) => {
      const cells = row.map((value) => String(value ?? "").trim()).filter(Boolean);
      const recognizedCells = cells.filter((value) => structuralKeywords.test(value));
      const score = recognizedCells.length * 3 + Math.min(cells.length, 25);
      if (recognizedCells.length >= 2) {
        structuralRows.push({ row: rowIndex + 1, recognizedCells: recognizedCells.slice(0, 60) });
      }
      if (score > candidate.score) {
        candidate = { rowIndex, score, headers: cells };
      }
    });

    process.stdout.write(`${JSON.stringify({
      sheet: sheetName,
      range: worksheet["!ref"] ?? "",
      headerRow: candidate.rowIndex + 1,
      headers: candidate.headers.slice(0, 60),
      structuralRows
    })}\n`);
  }
}
