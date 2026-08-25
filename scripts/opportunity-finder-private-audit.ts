import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import {
  OPPORTUNITY_HEADER_ALIASES,
  normalizeOpportunityHeader
} from "@/lib/opportunity-finder/aliases";
import {
  inspectOpportunityXlsxPackage,
  parseOpportunityWorkbook,
  profileOpportunityWorkbook
} from "@/lib/opportunity-finder/parser";
import { selectedRoleFromDetectedType } from "@/lib/opportunity-finder/validation";

const PRIVATE_EXTENSIONS = new Set([".xlsx", ".csv", ".xls", ".xlsm", ".xlsb"]);
const SUPPORTED_EXTENSIONS = new Set([".xlsx", ".csv"]);

type SafeAuditError =
  | "unsupported_extension"
  | "file_empty"
  | "file_too_large"
  | "invalid_signature"
  | "encrypted_file"
  | "active_content"
  | "unsafe_archive"
  | "row_limit"
  | "parse_failed";

type CandidateCategory =
  | "mpn"
  | "manufacturer"
  | "quantity"
  | "price"
  | "target"
  | "unit"
  | "date"
  | "customer_context"
  | "supplier_context"
  | "validity"
  | "moq_spq"
  | "date_code_coo_lead_time_condition";

const HEADER_CATEGORIES: Record<CandidateCategory, readonly string[]> = {
  mpn: OPPORTUNITY_HEADER_ALIASES.mpn,
  manufacturer: OPPORTUNITY_HEADER_ALIASES.manufacturer,
  quantity: [
    ...OPPORTUNITY_HEADER_ALIASES.demandQuantity,
    ...OPPORTUNITY_HEADER_ALIASES.stockQuantity,
    ...OPPORTUNITY_HEADER_ALIASES.excessQuantity,
    ...OPPORTUNITY_HEADER_ALIASES.supplierQuantity,
    ...OPPORTUNITY_HEADER_ALIASES.receivedQuantity,
    ...OPPORTUNITY_HEADER_ALIASES.purchaseQuantity,
    ...OPPORTUNITY_HEADER_ALIASES.quoteQuantity
  ],
  price: [
    ...OPPORTUNITY_HEADER_ALIASES.offerPrice,
    ...OPPORTUNITY_HEADER_ALIASES.unitCost
  ],
  target: OPPORTUNITY_HEADER_ALIASES.targetPrice,
  unit: OPPORTUNITY_HEADER_ALIASES.unitOfMeasure,
  date: OPPORTUNITY_HEADER_ALIASES.requiredDate,
  customer_context: OPPORTUNITY_HEADER_ALIASES.customerReference,
  supplier_context: OPPORTUNITY_HEADER_ALIASES.supplierReference,
  validity: OPPORTUNITY_HEADER_ALIASES.expiryDate,
  moq_spq: [...OPPORTUNITY_HEADER_ALIASES.moq, ...OPPORTUNITY_HEADER_ALIASES.spq],
  date_code_coo_lead_time_condition: [
    ...OPPORTUNITY_HEADER_ALIASES.dateCode,
    ...OPPORTUNITY_HEADER_ALIASES.coo,
    ...OPPORTUNITY_HEADER_ALIASES.leadTime,
    ...OPPORTUNITY_HEADER_ALIASES.transitTime,
    ...OPPORTUNITY_HEADER_ALIASES.condition
  ]
};

function safeAuditError(error: unknown): SafeAuditError {
  const message = error instanceof Error ? error.message : "";
  if (/EXTENSION_INVALID/.test(message)) return "unsupported_extension";
  if (/EMPTY/.test(message)) return "file_empty";
  if (/TOO_LARGE|UNCOMPRESSED_LIMIT|ENTRY_LIMIT/.test(message)) return "file_too_large";
  if (/SIGNATURE_INVALID|PACKAGE_INVALID|ZIP_INVALID/.test(message)) return "invalid_signature";
  if (/ENCRYPTED/.test(message)) return "encrypted_file";
  if (/MACRO|ACTIVE/.test(message)) return "active_content";
  if (/ZIP64|MULTIDISK|COMPRESSION/.test(message)) return "unsafe_archive";
  if (/ROW_LIMIT/.test(message)) return "row_limit";
  return "parse_failed";
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

async function listPrivateFiles(root: string) {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (
        entry.isFile()
        && !entry.name.startsWith("~$")
        && PRIVATE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(fullPath);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function anonymousCategoryId(root: string, filePath: string) {
  const relativeDirectory = path.relative(root, path.dirname(filePath)).replace(/\\/g, "/");
  return `CAT-${createHash("sha256").update(relativeDirectory).digest("hex").slice(0, 10)}`;
}

function candidateHeaders(headers: string[]) {
  const normalized = headers.map(normalizeOpportunityHeader);
  return Object.fromEntries(Object.entries(HEADER_CATEGORIES).map(([category, aliases]) => {
    const aliasSet = new Set(aliases.map(normalizeOpportunityHeader));
    return [category, headers.filter((_, index) => aliasSet.has(normalized[index]))];
  }));
}

function countWorkbookTables(workbook: XLSX.WorkBook) {
  const files = (workbook as XLSX.WorkBook & { files?: Record<string, unknown> }).files;
  return Object.keys(files ?? {}).filter((name) => /^xl\/tables\/table\d+\.xml$/i.test(name)).length;
}

function inspectSheet(sheet: XLSX.WorkSheet) {
  const cells = Object.entries(sheet).filter(([address]) => !address.startsWith("!"));
  let formulaCells = 0;
  let cachedFormulaValues = 0;
  let errorCells = 0;
  let dateFormattedCells = 0;
  let numericFormattedCells = 0;
  const usedColumns = new Set<number>();
  for (const [address, rawCell] of cells) {
    const cell = rawCell as XLSX.CellObject;
    const decoded = XLSX.utils.decode_cell(address);
    usedColumns.add(decoded.c);
    if (cell.f) {
      formulaCells += 1;
      if (cell.v !== undefined && cell.v !== null) cachedFormulaValues += 1;
    }
    if (cell.t === "e") errorCells += 1;
    const format = String(cell.z ?? "");
    if (/[dmyhs]/i.test(format)) dateFormattedCells += 1;
    if (/[0#?]/.test(format) && !/[dmyhs]/i.test(format)) numericFormattedCells += 1;
  }
  const rows = (sheet["!rows"] ?? []) as Array<{ hidden?: boolean } | undefined>;
  const columns = (sheet["!cols"] ?? []) as Array<{ hidden?: boolean } | undefined>;
  return {
    physicalDimension: sheet["!ref"] ?? null,
    usefulColumns: usedColumns.size,
    hiddenRows: rows.filter((row) => Boolean(row?.hidden)).length,
    hiddenColumns: columns.filter((column) => Boolean(column?.hidden)).length,
    autoFilter: sheet["!autofilter"]?.ref ?? null,
    mergedCells: sheet["!merges"]?.length ?? 0,
    formulaCells,
    cachedFormulaValues,
    errorCells,
    dateFormattedCells,
    numericFormattedCells
  };
}

async function inspectOne(root: string, filePath: string, index: number) {
  const started = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;
  const stat = await fs.promises.stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const sha256 = await sha256File(filePath);
  const anonymousId = `PRV-${String(index + 1).padStart(3, "0")}-${sha256.slice(0, 10)}`;
  const base = {
    anonymousId,
    sha256,
    categoryId: anonymousCategoryId(root, filePath),
    extension,
    sizeBytes: stat.size
  };
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return {
      ...base,
      processed: false,
      terminalState: "unsupported_safe",
      safeError: "unsupported_extension" as const,
      elapsedMs: Math.round(performance.now() - started),
      heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore)
    };
  }
  try {
    const parseOnly = process.env.QUIKSOL_PRIVATE_AUDIT_PARSE_ONLY === "true";
    const neutralName = `private-input-${String(index + 1).padStart(3, "0")}${extension}`;
    const profileStarted = performance.now();
    const profile = await profileOpportunityWorkbook(filePath, neutralName);
    const profileMs = Math.round(performance.now() - profileStarted);
    const selectedRole = selectedRoleFromDetectedType(profile.detectedType);
    let parsedRows = 0;
    let rejectedRows = 0;
    let peakBatchRows = 0;
    let peakBatchBytes = 0;
    let peakObservedHeapBytes = process.memoryUsage().heapUsed;
    const parseStarted = performance.now();
    const parseMetrics = selectedRole
      ? await parseOpportunityWorkbook({
          filePath,
          fileName: neutralName,
          fileId: `private-file-${String(index + 1).padStart(3, "0")}`,
          jobId: "private-local-audit",
          side: "A",
          role: selectedRole,
          templateType: profile.templateType,
          onBatch: async (rows) => {
            parsedRows += rows.length;
            peakBatchRows = Math.max(peakBatchRows, rows.length);
            peakBatchBytes = Math.max(
              peakBatchBytes,
              Buffer.byteLength(JSON.stringify(rows), "utf8")
            );
            peakObservedHeapBytes = Math.max(peakObservedHeapBytes, process.memoryUsage().heapUsed);
          },
          onRejected: async (rows) => {
            rejectedRows += rows.length;
            peakObservedHeapBytes = Math.max(peakObservedHeapBytes, process.memoryUsage().heapUsed);
          }
        })
      : null;
    const parseMs = Math.round(performance.now() - parseStarted);
    const metadataStarted = performance.now();
    const packageInspection = extension === ".xlsx"
      ? await inspectOpportunityXlsxPackage(filePath)
      : null;
    const workbook = extension === ".xlsx" && !parseOnly
      ? XLSX.readFile(filePath, {
          cellDates: false,
          cellFormula: true,
          cellNF: true,
          cellStyles: true,
          bookFiles: true,
          bookVBA: false,
          WTF: false
        })
      : null;
    const profileBySheet = new Map(profile.sheets.map((sheet) => [sheet.sheetName, sheet]));
    const sheetDetails = workbook
      ? workbook.SheetNames.map((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const profiled = profileBySheet.get(sheetName);
          const headers = profiled?.headerRows.flatMap((row) => row.headers) ?? [];
          return {
            sheetName,
            usefulRows: profiled?.usefulRowCount ?? profiled?.rowCount ?? 0,
            headerRows: profiled?.headerRows ?? [],
            candidateHeaders: candidateHeaders(headers),
            warnings: profiled?.warnings ?? [],
            errors: profiled?.errors ?? [],
            ...inspectSheet(sheet)
          };
        })
      : profile.sheets.map((sheet) => ({
          sheetName: sheet.sheetName,
          usefulRows: sheet.usefulRowCount ?? sheet.rowCount,
          headerRows: sheet.headerRows,
          candidateHeaders: candidateHeaders(sheet.headerRows.flatMap((row) => row.headers)),
          warnings: sheet.warnings ?? [],
          errors: sheet.errors ?? []
        }));
    const metadataMs = Math.round(performance.now() - metadataStarted);
    return {
      ...base,
      processed: true,
      terminalState: profile.detectedType === "unknown" ? "completed_with_warnings" : "completed",
      safeError: null,
      detectedRole: profile.detectedType,
      classificationScore: profile.classificationScore,
      classificationConfidence: profile.classificationConfidence ?? null,
      classificationReasons: profile.classificationReasons,
      templateType: profile.templateType ?? "generic",
      mappingVersion: profile.mappingVersion ?? null,
      sheets: sheetDetails,
      sheetCount: profile.sheetCount,
      usefulRows: profile.usefulRowCount ?? profile.rowCount,
      hiddenRows: profile.hiddenRowCount ?? 0,
      parsedRows,
      rejectedRows,
      profileMs,
      parseMs,
      metadataMs,
      peakBatchRows,
      peakBatchBytes,
      peakObservedHeapBytes,
      parseMetrics,
      tableCount: workbook ? countWorkbookTables(workbook) : 0,
      externalLinks: packageInspection?.hasExternalLinks ?? false,
      externalConnections: packageInspection?.hasConnections ?? false,
      packageCompressedBytes: packageInspection?.totalCompressedBytes ?? null,
      packageUncompressedBytes: packageInspection?.totalUncompressedBytes ?? null,
      packageCompressionRatio: packageInspection
        ? Math.round((packageInspection.totalUncompressedBytes / Math.max(packageInspection.totalCompressedBytes, 1)) * 100) / 100
        : null,
      macros: false,
      warnings: profile.warnings ?? [],
      errors: profile.errors ?? [],
      elapsedMs: Math.round(performance.now() - started),
      heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore)
    };
  } catch (error) {
    return {
      ...base,
      processed: false,
      terminalState: "rejected_safe",
      safeError: safeAuditError(error),
      elapsedMs: Math.round(performance.now() - started),
      heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore)
    };
  }
}

async function main() {
  const root = process.env.QUIKSOL_PRIVATE_FIXTURES_DIR?.trim();
  const reportDirectory = process.env.QUIKSOL_PRIVATE_REPORT_DIR?.trim();
  if (!root || process.env.CI === "true") {
    console.log("PRIVATE_AUDIT_SKIPPED");
    return;
  }
  const resolvedRoot = path.resolve(root);
  const files = await listPrivateFiles(resolvedRoot);
  const results = [];
  for (let index = 0; index < files.length; index += 1) {
    results.push(await inspectOne(resolvedRoot, files[index], index));
  }
  const categories = Object.values(results.reduce<Record<string, {
    categoryId: string;
    files: number;
    processed: number;
    rejectedSafe: number;
    unsupportedSafe: number;
  }>>((accumulator, item) => {
    const category = accumulator[item.categoryId] ??= {
      categoryId: item.categoryId,
      files: 0,
      processed: 0,
      rejectedSafe: 0,
      unsupportedSafe: 0
    };
    category.files += 1;
    category.processed += Number(item.processed);
    category.rejectedSafe += Number(item.terminalState === "rejected_safe");
    category.unsupportedSafe += Number(item.terminalState === "unsupported_safe");
    return accumulator;
  }, {}));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    files: results,
    categories
  };
  if (reportDirectory) {
    const resolvedReport = path.resolve(reportDirectory);
    if (resolvedReport.startsWith(`${process.cwd()}${path.sep}`) || resolvedReport === process.cwd()) {
      throw new Error("PRIVATE_REPORT_MUST_BE_OUTSIDE_REPOSITORY");
    }
    await fs.promises.mkdir(resolvedReport, { recursive: true });
    await fs.promises.writeFile(
      path.join(
        resolvedReport,
        process.env.QUIKSOL_PRIVATE_AUDIT_PARSE_ONLY === "true"
          ? "private-opportunity-finder-parse-benchmark.json"
          : "private-opportunity-finder-inventory.json"
      ),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: "utf8", flag: "w" }
    );
    const compatibilityRows = [
      [
        "anonymous_id", "extension", "sheets", "rows", "role", "adapter", "processed",
        "state", "elapsed_ms", "peak_heap_bytes", "warnings", "safe_error"
      ],
      ...results.map((item) => [
        item.anonymousId,
        item.extension,
        "sheetCount" in item ? item.sheetCount : 0,
        "usefulRows" in item ? item.usefulRows : 0,
        "detectedRole" in item ? item.detectedRole : "unknown",
        "templateType" in item ? item.templateType : "none",
        item.processed,
        item.terminalState,
        item.elapsedMs,
        "peakObservedHeapBytes" in item ? item.peakObservedHeapBytes : item.heapDeltaBytes,
        "warnings" in item ? item.warnings.join("|") : "",
        item.safeError ?? ""
      ])
    ];
    await fs.promises.writeFile(
      path.join(resolvedReport, "private-opportunity-finder-compatibility.csv"),
      `\uFEFF${compatibilityRows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
      { encoding: "utf8", flag: "w" }
    );
    const categoryRows = [
      ["category_id", "files", "processed", "rejected_safe", "unsupported_safe"],
      ...categories.map((category) => [
        category.categoryId,
        category.files,
        category.processed,
        category.rejectedSafe,
        category.unsupportedSafe
      ])
    ];
    await fs.promises.writeFile(
      path.join(resolvedReport, "private-opportunity-finder-category-summary.csv"),
      `\uFEFF${categoryRows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
      { encoding: "utf8", flag: "w" }
    );
  }
  console.log("PRIVATE_AUDIT_COMPLETE");
  console.log(`FILES=${results.length}`);
  console.log(`PROCESSED=${results.filter((item) => item.processed).length}`);
  console.log(`REJECTED_SAFE=${results.filter((item) => item.terminalState === "rejected_safe").length}`);
  console.log(`UNSUPPORTED_SAFE=${results.filter((item) => item.terminalState === "unsupported_safe").length}`);
  console.log(`REPORT_WRITTEN=${reportDirectory ? 1 : 0}`);
}

main().catch(() => {
  console.error("PRIVATE_AUDIT_FAILED");
  process.exitCode = 1;
});
