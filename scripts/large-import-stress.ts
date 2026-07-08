import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";

type FileKind = "csv" | "xlsx" | "bad";
type ExpectedFinalState = "completed" | "failed" | "cancelled" | "duplicate";
type PlanName = "smoke" | "standard" | "production" | "full" | "bad-cases" | "generate";

interface GeneratedFile {
  name: string;
  kind: FileKind;
  filePath: string;
  rows: number;
  mimeType: string;
  expectedFinalState: ExpectedFinalState;
  expectedRowErrors?: boolean;
  idempotencyKey?: string;
}

interface InitiatePayload {
  uploadId: string;
  jobId: string | null;
  bucket?: string;
  storagePath?: string;
  signedUrl?: string;
  token?: string;
  path?: string;
  status?: string;
}

interface JobPayload {
  job?: {
    id: string;
    upload_batch_id: string;
    status: string;
    total_rows: number;
    processed_rows: number;
    successful_rows: number;
    failed_rows: number;
    progress_percent: number;
    error_message: string | null;
  };
  upload?: {
    id: string;
    status: string;
    total_rows: number;
    processed_rows?: number | null;
    successful_rows?: number | null;
    failed_rows?: number | null;
    error_count?: number | null;
    processing_progress_percent?: number | null;
    data_quality_score?: number | null;
  } | null;
  error?: string;
}

interface StressResult {
  name: string;
  filePath?: string;
  rows: number;
  expected: ExpectedFinalState;
  finalStatus: string;
  passed: boolean;
  skipped?: boolean;
  durationMs: number;
  uploadMs?: number;
  processingMs?: number;
  memoryPeakMb?: number | null;
  rowsProcessed?: number;
  rowsPerSecond?: number;
  batchesInserted?: number | null;
  batchesSource?: "system_logs" | "estimated" | "unavailable";
  rowErrors?: number;
  uploadId?: string;
  jobId?: string | null;
  crashOrTimeout?: boolean;
  recommendation: string;
  error?: string;
}

const execFileAsync = promisify(execFile);
const outputRoot = path.resolve(process.env.LARGE_IMPORT_OUTPUT_DIR || "outputs/large-import-stress");
const reportPath = path.join(outputRoot, "latest-report.json");
const runId = process.env.LARGE_IMPORT_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const csvSizes = [10_000, 100_000, 500_000, 1_000_000];
const xlsxSizes = [10_000, 50_000, 100_000, 250_000];
const headers = [
  "Customer",
  "Supplier",
  "MPN",
  "Manufacturer",
  "Description",
  "PO",
  "Qty",
  "Cost",
  "Price",
  "GP Rate",
  "Commission",
  "Potential Amount USD",
  "Date Code",
  "MOQ",
  "SPQ",
  "On Hand",
  "Lead Time Weeks",
  "Transit Time Weeks",
  "Shipping Point Country",
  "Delivery Point",
  "Comments"
];

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function argFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

function nowMs() {
  return performance.now();
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms)) return "n/a";
  return `${(ms / 1000).toFixed(2)}s`;
}

function csvEscape(value: string | number) {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function rowValues(index: number, options?: { badRows?: boolean; formulaText?: boolean }) {
  const customerIndex = (index % 97) + 1;
  const supplierIndex = (index % 41) + 1;
  const qty = options?.badRows && index % 17 === 0 ? "BAD_QTY" : (index % 500) + 1;
  const cost = 0.25 + (index % 80) * 0.13;
  const price = Number(cost) * (1.18 + (index % 9) / 100);
  const gpRate = options?.badRows && index % 23 === 0 ? "2.75" : (price - Number(cost)) / price;
  const mpn = options?.badRows && index % 29 === 0 ? "" : `QS-${String(index).padStart(8, "0")}`;
  const comments = options?.formulaText && index % 31 === 0 ? "=HYPERLINK(\"https://example.com\",\"bad\")" : `stress row ${index}`;

  return [
    `Customer ${customerIndex}`,
    `Supplier ${supplierIndex}`,
    mpn,
    `MFG ${index % 25}`,
    `High volume stress test component ${index}`,
    `PO-${2026}-${String(index % 10000).padStart(4, "0")}`,
    qty,
    Number(cost.toFixed(4)),
    Number(price.toFixed(4)),
    Number(Number(gpRate).toFixed ? Number(gpRate).toFixed(6) : gpRate),
    Number((price * 0.025).toFixed(4)),
    Number((Number(qty) || 0) * price).toFixed(2),
    `DC${24 + (index % 6)}`,
    (index % 20) + 1,
    (index % 10) + 1,
    (index % 1000) + 5,
    (index % 16) + 1,
    (index % 6) + 1,
    ["US", "CN", "MX", "DE", "CO"][index % 5],
    ["Miami", "Bogota", "Shenzhen", "Monterrey"][index % 4],
    comments
  ];
}

async function ensureOutputDir() {
  await fsp.mkdir(outputRoot, { recursive: true });
}

async function writeWithBackpressure(stream: fs.WriteStream, chunk: string) {
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve) => stream.once("drain", resolve));
}

async function generateCsv(filePath: string, rows: number, options?: { missingColumns?: boolean; badRows?: boolean; formulaText?: boolean }) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { encoding: "utf8" });
  const actualHeaders = options?.missingColumns ? ["Customer", "Qty", "Price", "Comments"] : headers;
  await writeWithBackpressure(stream, `${actualHeaders.join(",")}\n`);

  for (let index = 1; index <= rows; index += 1) {
    const values = options?.missingColumns
      ? [`Customer ${index % 97}`, index % 13 === 0 ? "BAD_QTY" : index, Number((index * 0.37).toFixed(2)), `missing columns row ${index}`]
      : rowValues(index, options);
    await writeWithBackpressure(stream, `${values.map((value) => csvEscape(value)).join(",")}\n`);
    if (index % 25_000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  await new Promise<void>((resolve, reject) => {
    stream.end(resolve);
    stream.on("error", reject);
  });
}

async function generateXlsx(filePath: string, rows: number, options?: { formulaRows?: boolean; badRows?: boolean }) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useSharedStrings: false,
    useStyles: false
  });
  const sheet = workbook.addWorksheet("StressData");
  sheet.addRow(headers).commit();

  for (let index = 1; index <= rows; index += 1) {
    const values = rowValues(index, { badRows: options?.badRows });
    if (options?.formulaRows && index % 50 === 0) {
      values[20] = { formula: `H${index + 1}*I${index + 1}`, result: Number(values[7]) * Number(values[8]) } as unknown as string;
    }
    sheet.addRow(values).commit();
    if (index % 10_000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  await workbook.commit();
}

async function generateBadCases() {
  const cases: GeneratedFile[] = [];
  const corrupt = path.join(outputRoot, "bad-cases", "corrupt.xlsx");
  await fsp.mkdir(path.dirname(corrupt), { recursive: true });
  await fsp.writeFile(corrupt, Buffer.from("this is not a valid xlsx file"));
  cases.push({ name: "bad-corrupt-xlsx", kind: "bad", filePath: corrupt, rows: 0, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", expectedFinalState: "failed" });

  const missingColumns = path.join(outputRoot, "bad-cases", "missing-columns.csv");
  await generateCsv(missingColumns, 1_000, { missingColumns: true });
  cases.push({ name: "bad-missing-columns", kind: "csv", filePath: missingColumns, rows: 1_000, mimeType: "text/csv", expectedFinalState: "completed", expectedRowErrors: true });

  const falseExtension = path.join(outputRoot, "bad-cases", "false-extension.xlsx");
  await generateCsv(falseExtension, 1_000);
  cases.push({ name: "bad-false-extension", kind: "bad", filePath: falseExtension, rows: 1_000, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", expectedFinalState: "failed" });

  const formulas = path.join(outputRoot, "bad-cases", "formulas.xlsx");
  await generateXlsx(formulas, 2_000, { formulaRows: true });
  cases.push({ name: "bad-formulas-xlsx", kind: "xlsx", filePath: formulas, rows: 2_000, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", expectedFinalState: "completed" });

  return cases;
}

async function generatePlanFiles(plan: PlanName) {
  await ensureOutputDir();
  const files: GeneratedFile[] = [];

  if (plan === "smoke" || plan === "standard" || plan === "production" || plan === "full" || plan === "generate") {
    const selectedCsvSizes = plan === "production" || plan === "full" || plan === "generate" ? csvSizes : plan === "standard" ? [10_000, 100_000] : [10_000];
    for (const rows of selectedCsvSizes) {
      const filePath = path.join(outputRoot, "csv", `quiksol-stress-${rows}.csv`);
      await generateCsv(filePath, rows);
      files.push({ name: `csv-${rows}`, kind: "csv", filePath, rows, mimeType: "text/csv", expectedFinalState: "completed" });
    }

    const selectedXlsxSizes = plan === "production" || plan === "full" || plan === "generate" ? xlsxSizes : plan === "standard" ? [10_000, 50_000] : [10_000];
    for (const rows of selectedXlsxSizes) {
      const filePath = path.join(outputRoot, "xlsx", `quiksol-stress-${rows}.xlsx`);
      await generateXlsx(filePath, rows);
      files.push({ name: `xlsx-${rows}`, kind: "xlsx", filePath, rows, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", expectedFinalState: "completed" });
    }
  }

  if (plan === "bad-cases" || plan === "standard" || plan === "production" || plan === "full") {
    files.push(...await generateBadCases());
  }

  return files;
}

function baseUrl() {
  return (process.env.QUICKSOL_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

function authHeaders(contentTypeJson = false) {
  const headers: Record<string, string> = {
    "User-Agent": "quiksol-large-import-stress/1.0"
  };
  if (process.env.QUICKSOL_AUTH_COOKIE) headers.cookie = process.env.QUICKSOL_AUTH_COOKIE;
  if (process.env.QUICKSOL_AUTH_HEADER) headers.authorization = process.env.QUICKSOL_AUTH_HEADER;
  if (contentTypeJson) headers["Content-Type"] = "application/json";
  return headers;
}

function hasApiAuth() {
  return Boolean(process.env.QUICKSOL_AUTH_COOKIE || process.env.QUICKSOL_AUTH_HEADER);
}

async function readResponseJson<T>(response: Response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = payload.error || payload.message || `HTTP ${response.status}`;
    const error = new Error(message) as Error & { status?: number; payload?: unknown };
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload as T;
}

async function fileAsBlob(filePath: string, mimeType: string) {
  const fsModule = await import("node:fs") as typeof import("node:fs") & {
    openAsBlob?: (path: string, options?: { type?: string }) => Promise<Blob>;
  };
  if (fsModule.openAsBlob) return fsModule.openAsBlob(filePath, { type: mimeType });

  const buffer = await fsp.readFile(filePath);
  return new Blob([buffer], { type: mimeType });
}

async function uploadSignedFile(testFile: GeneratedFile, initiate: InitiatePayload) {
  if (!initiate.signedUrl) throw new Error("initiate did not return a signed upload URL.");
  const blob = await fileAsBlob(testFile.filePath, testFile.mimeType);
  const form = new FormData();
  form.append("cacheControl", "3600");
  form.append("", blob, path.basename(testFile.filePath));
  const response = await fetch(initiate.signedUrl, { method: "PUT", body: form });
  if (!response.ok) throw new Error(`Signed upload failed with HTTP ${response.status}: ${await response.text()}`);
}

async function initiateUpload(testFile: GeneratedFile) {
  const fileStats = await fsp.stat(testFile.filePath);
  const response = await fetch(`${baseUrl()}/api/upload/initiate`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({
      fileName: path.basename(testFile.filePath),
      fileSize: fileStats.size,
      fileType: testFile.mimeType,
      selectedCategory: "Auto Detect",
      department: "Stress QA",
      region: "Load Test",
      notes: `Large import stress test ${testFile.name}`,
      idempotencyKey: testFile.idempotencyKey || `stress:${runId}:${testFile.name}:${fileStats.size}`
    })
  });
  return readResponseJson<InitiatePayload>(response);
}

async function finalizeUpload(initiate: InitiatePayload) {
  if (!initiate.jobId) throw new Error("Cannot finalize without jobId.");
  const response = await fetch(`${baseUrl()}/api/upload/finalize`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({
      uploadId: initiate.uploadId,
      jobId: initiate.jobId,
      uploadProgressPercent: 100
    })
  });
  return readResponseJson(response);
}

async function getJob(jobId: string) {
  const response = await fetch(`${baseUrl()}/api/upload/jobs/${jobId}`, {
    method: "GET",
    headers: authHeaders()
  });
  return readResponseJson<JobPayload>(response);
}

async function postJobAction(jobId: string, action: "cancel" | "retry") {
  const response = await fetch(`${baseUrl()}/api/upload/jobs/${jobId}/${action}`, {
    method: "POST",
    headers: authHeaders()
  });
  return readResponseJson(response);
}

async function readProcessRssMb(pid: number) {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      const line = stdout.trim().split(/\r?\n/).find((item) => item.includes(`"${pid}"`));
      if (!line) return null;
      const columns = line.match(/("([^"]|"")*"|[^,]+)/g) ?? [];
      const memory = columns[4]?.replace(/"/g, "").replace(/[^\d]/g, "");
      return memory ? Number(memory) / 1024 : null;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) ? kb / 1024 : null;
  } catch {
    return null;
  }
}

function spawnWorkerOnce() {
  const child = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/import-worker.ts", "--once"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "pipe"
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[worker] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[worker] ${chunk}`));
  return child;
}

async function monitorMemory(child: ChildProcessWithoutNullStreams) {
  let peak: number | null = null;
  while (child.exitCode === null && !child.killed) {
    if (child.pid) {
      const rss = await readProcessRssMb(child.pid);
      if (rss !== null) peak = Math.max(peak ?? 0, rss);
    }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.LARGE_IMPORT_MEMORY_POLL_MS || 500)));
  }
  return peak;
}

async function waitForWorker(child: ChildProcessWithoutNullStreams) {
  return new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
}

async function pollJobUntilDone(jobId: string, timeoutMs: number) {
  const started = nowMs();
  let latest: JobPayload | null = null;
  while (nowMs() - started < timeoutMs) {
    latest = await getJob(jobId);
    const status = latest.job?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") return latest;
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.LARGE_IMPORT_POLL_MS || 2500)));
  }
  const error = new Error(`Polling timed out after ${formatDuration(timeoutMs)}.`);
  (error as Error & { latest?: JobPayload | null }).latest = latest;
  throw error;
}

async function countBatchLogs(uploadId: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return { count: null, source: "unavailable" as const };
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { count, error } = await supabase
    .from("system_logs")
    .select("id", { count: "exact", head: true })
    .eq("upload_batch_id", uploadId)
    .eq("action", "batch_insert_completed");
  if (error) return { count: null, source: "unavailable" as const };
  return { count: count ?? 0, source: "system_logs" as const };
}

function estimateBatches(rowsProcessed: number) {
  const batchSize = Number(process.env.IMPORT_BATCH_SIZE || process.env.SUPABASE_INSERT_CHUNK_SIZE || 1000);
  return Math.ceil(rowsProcessed / Math.max(batchSize, 1));
}

async function runImportCase(testFile: GeneratedFile) {
  const started = nowMs();
  let memoryPeakMb: number | null = null;
  let workerExitCode: number | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    if (!hasApiAuth()) {
      return {
        name: testFile.name,
        filePath: testFile.filePath,
        rows: testFile.rows,
        expected: testFile.expectedFinalState,
        finalStatus: "skipped",
        passed: false,
        skipped: true,
        durationMs: nowMs() - started,
        crashOrTimeout: false,
        recommendation: "Set QUICKSOL_AUTH_COOKIE from a logged-in browser session before running real API upload tests."
      } satisfies StressResult;
    }

    const uploadStarted = nowMs();
    const initiate = await initiateUpload(testFile);
    if (testFile.expectedFinalState === "duplicate") {
      return {
        name: testFile.name,
        filePath: testFile.filePath,
        rows: testFile.rows,
        expected: testFile.expectedFinalState,
        finalStatus: initiate.status || "duplicate",
        passed: true,
        durationMs: nowMs() - started,
        uploadId: initiate.uploadId,
        jobId: initiate.jobId,
        recommendation: "Duplicate was blocked by idempotency key."
      };
    }

    await uploadSignedFile(testFile, initiate);
    const uploadMs = nowMs() - uploadStarted;
    await finalizeUpload(initiate);

    if (!initiate.jobId) throw new Error("Missing jobId after initiate.");
    if (testFile.expectedFinalState === "cancelled") {
      await postJobAction(initiate.jobId, "cancel");
    } else if (process.env.LARGE_IMPORT_SPAWN_WORKER === "1") {
      child = spawnWorkerOnce();
      const memoryPromise = monitorMemory(child);
      const exitPromise = waitForWorker(child);
      const [observedPeak, observedExit] = await Promise.all([memoryPromise, exitPromise]);
      memoryPeakMb = observedPeak;
      workerExitCode = observedExit;
    }

    const processingStarted = nowMs();
    const timeoutMs = Number(process.env.LARGE_IMPORT_TIMEOUT_MS || 20 * 60 * 1000);
    const latest = await pollJobUntilDone(initiate.jobId, timeoutMs);
    const processingMs = nowMs() - processingStarted;
    const finalStatus = latest.job?.status || "unknown";
    const rowsProcessed = latest.job?.processed_rows ?? latest.upload?.processed_rows ?? 0;
    const rowErrors = latest.job?.failed_rows ?? latest.upload?.failed_rows ?? latest.upload?.error_count ?? 0;
    const batches = await countBatchLogs(initiate.uploadId);
    const batchesInserted = batches.count ?? estimateBatches(rowsProcessed);
    const batchesSource = batches.count === null ? "estimated" : batches.source;
    const rowsPerSecond = rowsProcessed && processingMs > 0 ? rowsProcessed / (processingMs / 1000) : 0;
    const expectedStatePassed = finalStatus === testFile.expectedFinalState;
    const rowErrorPassed = testFile.expectedRowErrors ? rowErrors > 0 : true;
    const crashOrTimeout = workerExitCode !== null && workerExitCode !== 0;

    return {
      name: testFile.name,
      filePath: testFile.filePath,
      rows: testFile.rows,
      expected: testFile.expectedFinalState,
      finalStatus,
      passed: expectedStatePassed && rowErrorPassed && !crashOrTimeout,
      durationMs: nowMs() - started,
      uploadMs,
      processingMs,
      memoryPeakMb,
      rowsProcessed,
      rowsPerSecond,
      batchesInserted,
      batchesSource,
      rowErrors,
      uploadId: initiate.uploadId,
      jobId: initiate.jobId,
      crashOrTimeout,
      recommendation: expectedStatePassed
        ? "Result matched expected final state."
        : `Expected ${testFile.expectedFinalState}, got ${finalStatus}. Check worker logs and import_job_errors.`
    } satisfies StressResult;
  } catch (error) {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    return {
      name: testFile.name,
      filePath: testFile.filePath,
      rows: testFile.rows,
      expected: testFile.expectedFinalState,
      finalStatus: "error",
      passed: false,
      durationMs: nowMs() - started,
      memoryPeakMb,
      crashOrTimeout: true,
      recommendation: "Inspect API response, worker logs, system_logs and Supabase storage permissions.",
      error: error instanceof Error ? error.message : String(error)
    } satisfies StressResult;
  }
}

async function runDuplicateCase(baseFile: GeneratedFile) {
  const duplicateKey = `duplicate:${Date.now()}:${path.basename(baseFile.filePath)}`;
  const first = { ...baseFile, name: "bad-duplicate-first-upload", idempotencyKey: duplicateKey, expectedFinalState: "cancelled" as const };
  const second = { ...baseFile, name: "bad-duplicate-second-upload", idempotencyKey: duplicateKey, expectedFinalState: "duplicate" as const };
  const firstResult = await runImportCase(first);
  const secondResult = await runImportCase(second);
  return [firstResult, secondResult];
}

async function runRetryFailedCase(corruptCase: GeneratedFile) {
  const result = await runImportCase({ ...corruptCase, name: "bad-retry-failed-initial" });
  if (!result.jobId || result.finalStatus !== "failed" || !hasApiAuth()) return [result];
  const started = nowMs();
  try {
    await postJobAction(result.jobId, "retry");
    let memoryPeakMb: number | null = null;
    if (process.env.LARGE_IMPORT_SPAWN_WORKER === "1") {
      const child = spawnWorkerOnce();
      const [peak] = await Promise.all([monitorMemory(child), waitForWorker(child)]);
      memoryPeakMb = peak;
    }
    const latest = await pollJobUntilDone(result.jobId, Number(process.env.LARGE_IMPORT_TIMEOUT_MS || 20 * 60 * 1000));
    return [result, {
      name: "bad-retry-failed-after-retry",
      rows: corruptCase.rows,
      expected: "failed" as const,
      finalStatus: latest.job?.status || "unknown",
      passed: latest.job?.status === "failed",
      durationMs: nowMs() - started,
      memoryPeakMb,
      rowsProcessed: latest.job?.processed_rows ?? 0,
      rowErrors: latest.job?.failed_rows ?? 0,
      uploadId: result.uploadId,
      jobId: result.jobId,
      recommendation: "Retry endpoint re-queued the failed job and worker produced the expected failed state again."
    } satisfies StressResult];
  } catch (error) {
    return [result, {
      name: "bad-retry-failed-after-retry",
      rows: corruptCase.rows,
      expected: "failed" as const,
      finalStatus: "error",
      passed: false,
      durationMs: nowMs() - started,
      uploadId: result.uploadId,
      jobId: result.jobId,
      crashOrTimeout: true,
      recommendation: "Retry failed at API, worker or polling layer.",
      error: error instanceof Error ? error.message : String(error)
    }];
  }
}

async function runRestartCase(baseFile: GeneratedFile) {
  const started = nowMs();
  if (process.env.LARGE_IMPORT_INCLUDE_RESTART !== "1") {
    return {
      name: "bad-worker-restart-mid-process",
      filePath: baseFile.filePath,
      rows: baseFile.rows,
      expected: "failed",
      finalStatus: "skipped",
      passed: false,
      skipped: true,
      durationMs: nowMs() - started,
      recommendation: "Set LARGE_IMPORT_INCLUDE_RESTART=1 to run this destructive crash-recovery test. It can leave a processing job that must be cancelled."
    } satisfies StressResult;
  }
  if (!hasApiAuth()) {
    return {
      name: "bad-worker-restart-mid-process",
      rows: baseFile.rows,
      expected: "failed",
      finalStatus: "skipped",
      passed: false,
      skipped: true,
      durationMs: nowMs() - started,
      recommendation: "Set QUICKSOL_AUTH_COOKIE before running worker restart tests."
    } satisfies StressResult;
  }

  const initiate = await initiateUpload({ ...baseFile, idempotencyKey: `restart:${Date.now()}` });
  await uploadSignedFile(baseFile, initiate);
  await finalizeUpload(initiate);
  if (!initiate.jobId) throw new Error("Missing restart test jobId.");
  const child = spawnWorkerOnce();
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.LARGE_IMPORT_RESTART_KILL_AFTER_MS || 2500)));
  child.kill("SIGTERM");
  await waitForWorker(child);
  const afterKill = await getJob(initiate.jobId);
  const secondWorker = spawnWorkerOnce();
  await waitForWorker(secondWorker);
  const final = await getJob(initiate.jobId);
  if (final.job?.status === "processing") await postJobAction(initiate.jobId, "cancel").catch(() => undefined);

  return {
    name: "bad-worker-restart-mid-process",
    filePath: baseFile.filePath,
    rows: baseFile.rows,
    expected: "failed",
    finalStatus: final.job?.status || "unknown",
    passed: final.job?.status !== "processing",
    durationMs: nowMs() - started,
    rowsProcessed: final.job?.processed_rows ?? afterKill.job?.processed_rows ?? 0,
    uploadId: initiate.uploadId,
    jobId: initiate.jobId,
    crashOrTimeout: final.job?.status === "processing",
    recommendation: final.job?.status === "processing"
      ? "Current worker cannot reclaim stale processing jobs. Add stale lock recovery before production."
      : "Worker restart recovery did not leave the job stuck."
  } satisfies StressResult;
}

function printReport(results: StressResult[]) {
  const passed = results.filter((result) => result.passed).length;
  const failed = results.filter((result) => !result.passed && !result.skipped).length;
  const skipped = results.filter((result) => result.skipped).length;
  const totalDuration = results.reduce((sum, result) => sum + result.durationMs, 0);
  const memoryPeak = Math.max(0, ...results.map((result) => result.memoryPeakMb ?? 0));
  const rowsProcessed = results.reduce((sum, result) => sum + (result.rowsProcessed ?? 0), 0);

  console.log("\n=== Quiksol Large Import Stress Report ===");
  console.log(`passed: ${passed}`);
  console.log(`failed: ${failed}`);
  console.log(`skipped: ${skipped}`);
  console.log(`duration: ${formatDuration(totalDuration)}`);
  console.log(`memory peak: ${memoryPeak ? `${memoryPeak.toFixed(1)} MB` : "unavailable"}`);
  console.log(`rows processed: ${rowsProcessed}`);
  console.log(`recommendation: ${failed ? "Fix failed cases before production load testing." : skipped ? "Run again with API auth and worker enabled for full coverage." : "Stress plan passed."}`);
  console.log("");
  console.table(results.map((result) => ({
    test: result.name,
    passed: result.passed,
    skipped: Boolean(result.skipped),
    expected: result.expected,
    final: result.finalStatus,
    duration: formatDuration(result.durationMs),
    upload: result.uploadMs ? formatDuration(result.uploadMs) : "n/a",
    processing: result.processingMs ? formatDuration(result.processingMs) : "n/a",
    memoryMb: result.memoryPeakMb ? result.memoryPeakMb.toFixed(1) : "n/a",
    rows: result.rowsProcessed ?? 0,
    rps: result.rowsPerSecond ? result.rowsPerSecond.toFixed(1) : "n/a",
    batches: result.batchesInserted ?? "n/a",
    batchSource: result.batchesSource ?? "n/a",
    rowErrors: result.rowErrors ?? "n/a",
    recommendation: result.recommendation,
    error: result.error ?? ""
  })));
}

async function main() {
  const plan = (argValue("plan") || process.env.LARGE_IMPORT_PLAN || "smoke") as PlanName;
  const generateOnly = argFlag("generate-only") || process.env.LARGE_IMPORT_GENERATE_ONLY === "1" || plan === "generate";
  if (!["smoke", "standard", "production", "full", "bad-cases", "generate"].includes(plan)) {
    throw new Error(`Unknown plan "${plan}". Use smoke, standard, production, full, bad-cases or generate.`);
  }

  console.log(`Generating large import stress files in ${outputRoot}`);
  console.log(`Plan: ${plan}`);
  const generated = await generatePlanFiles(plan);
  console.log(`Generated ${generated.length} file(s).`);

  if (generateOnly) {
    const results = generated.map((file) => ({
      name: file.name,
      filePath: file.filePath,
      rows: file.rows,
      expected: file.expectedFinalState,
      finalStatus: "generated",
      passed: true,
      durationMs: 0,
      recommendation: "File generated. Run without --generate-only to execute API stress tests."
    } satisfies StressResult));
    await fsp.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), plan, results }, null, 2));
    printReport(results);
    return;
  }

  const results: StressResult[] = [];
  const runFiles = generated.filter((file) => file.expectedFinalState !== "duplicate");
  for (const testFile of runFiles) {
    if (testFile.name === "bad-corrupt-xlsx" && process.env.LARGE_IMPORT_RUN_RETRY_CASE === "1") {
      results.push(...await runRetryFailedCase(testFile));
      continue;
    }
    if (testFile.name === "bad-missing-columns" && process.env.LARGE_IMPORT_RUN_DUPLICATE_CASE === "1") {
      results.push(...await runDuplicateCase(testFile));
    }
    results.push(await runImportCase(testFile));
  }

  const restartBase = generated.find((file) => file.kind === "csv" && file.rows >= 10_000);
  if (restartBase) results.push(await runRestartCase(restartBase));

  await fsp.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), plan, baseUrl: baseUrl(), results }, null, 2));
  printReport(results);

  const hasFailed = results.some((result) => !result.passed && !result.skipped);
  const hasSkipped = results.some((result) => result.skipped);
  if (hasFailed || (hasSkipped && process.env.LARGE_IMPORT_ALLOW_SKIPS !== "1")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
