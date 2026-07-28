import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateOpportunityCompatibility } from "@/lib/opportunity-finder/compatibility";
import { matchOpportunityRows } from "@/lib/opportunity-finder/matcher";
import {
  parseOpportunityWorkbook,
  profileOpportunityWorkbook,
  type OpportunityParseMetrics
} from "@/lib/opportunity-finder/parser";
import type {
  CanonicalOpportunityRow,
  OpportunityFileType,
  OpportunitySelectedRole,
  OpportunitySummary
} from "@/lib/opportunity-finder/types";
import { logger } from "@/lib/logger/logger";

const INSERT_CHUNK_SIZE = 500;
const QUERY_PAGE_SIZE = 1000;

export type OpportunityFinderJobRow = {
  id: string;
  created_by: string;
  status: string;
  current_stage: string;
  progress_percent: number;
  file_a_id: string;
  file_b_id: string;
  file_a_role: OpportunitySelectedRole | null;
  file_b_role: OpportunitySelectedRole | null;
  attempts: number;
  max_attempts: number;
  cancel_requested: boolean;
};

type OpportunityFinderFileRow = {
  id: string;
  job_id: string;
  side: "A" | "B";
  original_file_name: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number;
  detected_type: OpportunityFileType;
  selected_role: OpportunitySelectedRole | null;
};

class OpportunityFinderCancelledError extends Error {
  constructor() {
    super("OPPORTUNITY_JOB_CANCELLED");
    this.name = "OpportunityFinderCancelledError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeWorkerErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/CANCELLED/.test(message)) return "JOB_CANCELLED";
  if (/SIGNATURE/.test(message)) return "FILE_SIGNATURE_INVALID";
  if (/MACRO/.test(message)) return "MACRO_FILE_BLOCKED";
  if (/EXTENSION/.test(message)) return "FILE_EXTENSION_INVALID";
  if (/compatib/i.test(message)) return "ROLES_INCOMPATIBLE";
  if (/storage|download|signed/i.test(message)) return "STORAGE_DOWNLOAD_FAILED";
  if (/workbook|xlsx|csv|zip|parse/i.test(message)) return "FILE_PARSE_FAILED";
  return "OPPORTUNITY_PROCESSING_FAILED";
}

async function updateHeartbeat(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string
) {
  await supabase
    .from("opportunity_finder_jobs")
    .update({ heartbeat_at: nowIso(), locked_by: workerId })
    .eq("id", jobId)
    .in("status", ["profiling", "parsing", "matching"]);
}

async function updateJob(
  supabase: SupabaseClient,
  jobId: string,
  values: Record<string, unknown>
) {
  const { error } = await supabase
    .from("opportunity_finder_jobs")
    .update({ ...values, heartbeat_at: nowIso(), updated_at: nowIso() })
    .eq("id", jobId);
  if (error) throw error;
}

async function isCancelled(supabase: SupabaseClient, jobId: string) {
  const { data, error } = await supabase
    .from("opportunity_finder_jobs")
    .select("status,cancel_requested")
    .eq("id", jobId)
    .single();
  if (error) throw error;
  return Boolean(data?.cancel_requested || data?.status === "cancelled");
}

async function requireNotCancelled(supabase: SupabaseClient, jobId: string) {
  if (await isCancelled(supabase, jobId)) throw new OpportunityFinderCancelledError();
}

async function loadJobFiles(supabase: SupabaseClient, jobId: string) {
  const { data, error } = await supabase
    .from("opportunity_finder_files")
    .select("id,job_id,side,original_file_name,storage_bucket,storage_path,mime_type,size_bytes,detected_type,selected_role")
    .eq("job_id", jobId)
    .order("side", { ascending: true });
  if (error) throw error;
  if ((data ?? []).length !== 2) throw new Error("OPPORTUNITY_REQUIRES_EXACTLY_TWO_FILES");
  return data as OpportunityFinderFileRow[];
}

async function downloadFile(
  supabase: SupabaseClient,
  file: OpportunityFinderFileRow,
  tempDirectory: string
) {
  const { data, error } = await supabase.storage
    .from(file.storage_bucket)
    .createSignedUrl(file.storage_path, 60 * 60);
  if (error || !data?.signedUrl) throw error ?? new Error("STORAGE_SIGNED_URL_FAILED");
  const response = await fetch(data.signedUrl);
  if (!response.ok || !response.body) throw new Error("STORAGE_DOWNLOAD_FAILED");
  const extension = path.extname(file.original_file_name).toLowerCase();
  const localPath = path.join(tempDirectory, `${file.id}${extension}`);
  const webStream = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(Readable.fromWeb(webStream), fs.createWriteStream(localPath));
  return localPath;
}

async function downloadJobFiles(
  supabase: SupabaseClient,
  files: OpportunityFinderFileRow[],
  jobId: string
) {
  const tempDirectory = await fs.promises.mkdtemp(
    path.join(process.env.OPPORTUNITY_FINDER_TEMP_DIR || os.tmpdir(), `quiksol-opportunity-${jobId}-`)
  );
  try {
    const downloaded = await Promise.all(
      files.map(async (file) => ({
        file,
        localPath: await downloadFile(supabase, file, tempDirectory)
      }))
    );
    return { tempDirectory, downloaded };
  } catch (error) {
    await fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function profileFiles(
  supabase: SupabaseClient,
  job: OpportunityFinderJobRow,
  files: OpportunityFinderFileRow[],
  localFiles: Map<string, string>
) {
  await updateJob(supabase, job.id, {
    status: "profiling",
    current_stage: "inspecting_sheets",
    progress_percent: 8
  });
  let processed = 0;
  for (const file of files) {
    await requireNotCancelled(supabase, job.id);
    await supabase.from("opportunity_finder_files").update({ parse_status: "profiling" }).eq("id", file.id);
    const profile = await profileOpportunityWorkbook(localFiles.get(file.id)!, file.original_file_name);
    processed += 1;
    const { error } = await supabase
      .from("opportunity_finder_files")
      .update({
        detected_type: profile.detectedType,
        classification_score: profile.classificationScore,
        classification_reasons: profile.classificationReasons,
        sheet_profiles: profile.sheets,
        sheet_count: profile.sheetCount,
        row_count: profile.rowCount,
        parse_status: "profiled",
        profiled_at: nowIso()
      })
      .eq("id", file.id)
      .eq("job_id", job.id);
    if (error) throw error;
    await updateJob(supabase, job.id, {
      current_stage: "detecting_headers",
      progress_percent: processed === 1 ? 16 : 24,
      ...(file.side === "A" ? { total_rows_a: profile.rowCount } : { total_rows_b: profile.rowCount })
    });
  }
  await updateJob(supabase, job.id, {
    status: "awaiting_roles",
    current_stage: "confirming_roles",
    progress_percent: 25,
    attempts: 0,
    locked_at: null,
    locked_by: null,
    heartbeat_at: null
  });
}

function rowInsert(row: CanonicalOpportunityRow) {
  return {
    job_id: row.jobId,
    file_id: row.fileId,
    side: row.side,
    sheet_name: row.sheetName,
    source_row: row.sourceRow,
    original_index: row.originalIndex,
    record_role: row.recordRole,
    raw_mpn: row.rawMpn,
    display_mpn: row.displayMpn,
    normalized_mpn: row.normalizedMpn,
    review_key: row.reviewKey,
    manufacturer: row.manufacturer,
    customer_context: row.customerContext,
    supplier_context: row.supplierContext,
    required_qty: row.requiredQty,
    available_qty: row.availableQty,
    excess_qty: row.excessQty,
    required_date: row.requiredDate,
    unit_of_measure: row.unitOfMeasure,
    quality_flags: row.qualityFlags
  };
}

async function insertCanonicalRows(
  supabase: SupabaseClient,
  rows: CanonicalOpportunityRow[]
) {
  for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
    const { error } = await supabase
      .from("opportunity_finder_rows")
      .insert(rows.slice(index, index + INSERT_CHUNK_SIZE).map(rowInsert));
    if (error) throw error;
  }
}

function databaseCanonicalRow(row: Record<string, unknown>): CanonicalOpportunityRow {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    fileId: row.file_id as string,
    side: row.side as "A" | "B",
    fileName: row.file_name as string,
    sheetName: row.sheet_name as string,
    sourceRow: Number(row.source_row),
    originalIndex: Number(row.original_index),
    recordRole: row.record_role as OpportunitySelectedRole,
    rawMpn: row.raw_mpn as string,
    displayMpn: row.display_mpn as string,
    normalizedMpn: row.normalized_mpn as string,
    reviewKey: row.review_key as string,
    manufacturer: row.manufacturer as string | null,
    customerContext: row.customer_context as string | null,
    supplierContext: row.supplier_context as string | null,
    requiredQty: row.required_qty === null ? null : Number(row.required_qty),
    availableQty: row.available_qty === null ? null : Number(row.available_qty),
    excessQty: row.excess_qty === null ? null : Number(row.excess_qty),
    requiredDate: row.required_date as string | null,
    unitOfMeasure: row.unit_of_measure as string | null,
    qualityFlags: (row.quality_flags ?? []) as CanonicalOpportunityRow["qualityFlags"]
  };
}

async function loadCanonicalRowsByRole(
  supabase: SupabaseClient,
  jobId: string,
  files: OpportunityFinderFileRow[],
  role: OpportunitySelectedRole
) {
  const fileNames = new Map(files.map((file) => [file.id, file.original_file_name]));
  const rows: CanonicalOpportunityRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("opportunity_finder_rows")
      .select("id,job_id,file_id,side,sheet_name,source_row,original_index,record_role,raw_mpn,display_mpn,normalized_mpn,review_key,manufacturer,customer_context,supplier_context,required_qty,available_qty,excess_qty,required_date,unit_of_measure,quality_flags")
      .eq("job_id", jobId)
      .eq("record_role", role)
      .order("normalized_mpn", { ascending: true })
      .order("required_date", { ascending: true, nullsFirst: false })
      .order("original_index", { ascending: true })
      .range(offset, offset + QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page.map((row) => databaseCanonicalRow({
      ...row,
      file_name: fileNames.get(row.file_id as string) ?? ""
    })));
    if (page.length < QUERY_PAGE_SIZE) break;
    offset += page.length;
  }
  return rows;
}

function emptyOpportunitySummary(): OpportunitySummary {
  return {
    analyzedMpns: 0,
    exactMatches: 0,
    fullSales: 0,
    partialSales: 0,
    sourcingNeeded: 0,
    excessResales: 0,
    supplierOfferMatches: 0,
    supplyWithoutDemand: 0,
    historicalSignals: 0,
    reviewRequired: 0,
    missingMpnRows: 0,
    invalidQuantityRows: 0,
    possibleMatches: 0
  };
}

function addResultToSummary(summary: OpportunitySummary, opportunityType: string) {
  if (opportunityType === "full_sale") summary.fullSales += 1;
  if (opportunityType === "partial_sale") summary.partialSales += 1;
  if (opportunityType === "sourcing_needed") summary.sourcingNeeded += 1;
  if (opportunityType === "excess_resale") summary.excessResales += 1;
  if (opportunityType === "supplier_offer_match") summary.supplierOfferMatches += 1;
  if (opportunityType === "supply_without_demand") summary.supplyWithoutDemand += 1;
  if (opportunityType === "historical_signal") summary.historicalSignals += 1;
  if (opportunityType === "review_required") summary.reviewRequired += 1;
}

async function matchCanonicalRowsIncrementally(input: {
  supabase: SupabaseClient;
  jobId: string;
  files: OpportunityFinderFileRow[];
  roleA: OpportunitySelectedRole;
  roleB: OpportunitySelectedRole;
  supplyRole: OpportunitySelectedRole;
  missingMpnRows: number;
  invalidQuantityRows: number;
}) {
  const supplyRows = await loadCanonicalRowsByRole(
    input.supabase,
    input.jobId,
    input.files,
    input.supplyRole
  );
  const supplyByMpn = new Map<string, CanonicalOpportunityRow[]>();
  const supplyByReviewKey = new Map<string, CanonicalOpportunityRow[]>();
  for (const row of supplyRows) {
    supplyByMpn.set(row.normalizedMpn, [...(supplyByMpn.get(row.normalizedMpn) ?? []), row]);
    if (row.reviewKey) {
      supplyByReviewKey.set(row.reviewKey, [...(supplyByReviewKey.get(row.reviewKey) ?? []), row]);
    }
  }
  supplyRows.length = 0;

  const summary = emptyOpportunitySummary();
  summary.missingMpnRows = input.missingMpnRows;
  summary.invalidQuantityRows = input.invalidQuantityRows;
  const demandMpns = new Set<string>();
  const exactMpns = new Set<string>();
  let warningCount = 0;
  let resultCount = 0;
  let offset = 0;
  let currentMpn = "";
  let currentDemandRows: CanonicalOpportunityRow[] = [];
  const fileNames = new Map(input.files.map((file) => [file.id, file.original_file_name]));

  async function processDemandMpn(rows: CanonicalOpportunityRow[]) {
    if (!rows.length) return;
    const normalizedMpn = rows[0].normalizedMpn;
    demandMpns.add(normalizedMpn);
    const exactSupply = supplyByMpn.get(normalizedMpn) ?? [];
    if (exactSupply.length) exactMpns.add(normalizedMpn);
    const reviewSupply = rows[0].reviewKey
      ? (supplyByReviewKey.get(rows[0].reviewKey) ?? []).filter((row) => row.normalizedMpn !== normalizedMpn)
      : [];
    const output = matchOpportunityRows({
      jobId: input.jobId,
      rows: [...rows, ...exactSupply, ...reviewSupply],
      roleA: input.roleA,
      roleB: input.roleB
    });
    output.results = output.results.filter((result) =>
      result.opportunityType !== "supply_without_demand" ||
      result.normalizedMpn === normalizedMpn
    );
    await persistMatchOutput(input.supabase, output);
    for (const result of output.results) {
      resultCount += 1;
      warningCount += result.warnings.length;
      addResultToSummary(summary, result.opportunityType);
    }
    summary.possibleMatches += output.possibleMatches.length;
  }

  while (true) {
    const { data, error } = await input.supabase
      .from("opportunity_finder_rows")
      .select("id,job_id,file_id,side,sheet_name,source_row,original_index,record_role,raw_mpn,display_mpn,normalized_mpn,review_key,manufacturer,customer_context,supplier_context,required_qty,available_qty,excess_qty,required_date,unit_of_measure,quality_flags")
      .eq("job_id", input.jobId)
      .eq("record_role", "demand")
      .order("normalized_mpn", { ascending: true })
      .order("required_date", { ascending: true, nullsFirst: false })
      .order("original_index", { ascending: true })
      .range(offset, offset + QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const databaseRow of page) {
      const row = databaseCanonicalRow({
        ...databaseRow,
        file_name: fileNames.get(databaseRow.file_id as string) ?? ""
      });
      if (currentMpn && row.normalizedMpn !== currentMpn) {
        await processDemandMpn(currentDemandRows);
        currentDemandRows = [];
      }
      currentMpn = row.normalizedMpn;
      currentDemandRows.push(row);
    }
    if (page.length < QUERY_PAGE_SIZE) break;
    offset += page.length;
  }
  await processDemandMpn(currentDemandRows);

  if (!["received_history", "sales_history"].includes(input.supplyRole)) {
    for (const [normalizedMpn, rows] of supplyByMpn) {
      if (demandMpns.has(normalizedMpn)) continue;
      const output = matchOpportunityRows({
        jobId: input.jobId,
        rows,
        roleA: input.roleA,
        roleB: input.roleB
      });
      await persistMatchOutput(input.supabase, output);
      for (const result of output.results) {
        resultCount += 1;
        warningCount += result.warnings.length;
        addResultToSummary(summary, result.opportunityType);
      }
    }
  }

  summary.exactMatches = exactMpns.size;
  summary.analyzedMpns = new Set([...demandMpns, ...supplyByMpn.keys()]).size;
  return { summary, resultCount, warningCount };
}

function resultInsert(result: ReturnType<typeof matchOpportunityRows>["results"][number]) {
  return {
    job_id: result.jobId,
    opportunity_type: result.opportunityType,
    exact_match: result.exactMatch,
    display_mpn: result.displayMpn,
    normalized_mpn: result.normalizedMpn,
    manufacturer: result.manufacturer,
    customer_context: result.customerContext,
    supplier_context: result.supplierContext,
    required_qty: result.requiredQty,
    available_qty: result.availableQty,
    allocated_qty: result.allocatedQty,
    shortage_qty: result.shortageQty,
    coverage_percent: result.coveragePercent,
    required_date: result.requiredDate,
    unit_of_measure: result.unitOfMeasure,
    demand_file_id: result.demandFileId,
    demand_file_name: result.demandFileName,
    demand_sheet_name: result.demandSheetName,
    supply_file_id: result.supplyFileId,
    supply_file_name: result.supplyFileName,
    supply_sheet_name: result.supplySheetName,
    demand_source_rows: result.demandSourceRows,
    supply_source_rows: result.supplySourceRows,
    reason_code: result.reasonCode,
    action_code: result.actionCode,
    warnings: result.warnings
  };
}

async function persistMatchOutput(
  supabase: SupabaseClient,
  output: ReturnType<typeof matchOpportunityRows>
) {
  for (let index = 0; index < output.results.length; index += INSERT_CHUNK_SIZE) {
    const { error } = await supabase
      .from("opportunity_finder_results")
      .insert(output.results.slice(index, index + INSERT_CHUNK_SIZE).map(resultInsert));
    if (error) throw error;
  }
  for (let index = 0; index < output.possibleMatches.length; index += INSERT_CHUNK_SIZE) {
    const { error } = await supabase
      .from("opportunity_finder_possible_matches")
      .insert(output.possibleMatches.slice(index, index + INSERT_CHUNK_SIZE).map((match) => ({
        job_id: match.jobId,
        demand_display_mpn: match.demandDisplayMpn,
        supply_display_mpn: match.supplyDisplayMpn,
        demand_normalized_mpn: match.demandNormalizedMpn,
        supply_normalized_mpn: match.supplyNormalizedMpn,
        review_key: match.reviewKey,
        demand_file_id: match.demandFileId,
        supply_file_id: match.supplyFileId,
        reason_code: match.reasonCode
      })));
    if (error) throw error;
  }
}

async function parseAndMatch(
  supabase: SupabaseClient,
  job: OpportunityFinderJobRow,
  files: OpportunityFinderFileRow[],
  localFiles: Map<string, string>
) {
  const roleA = job.file_a_role ?? files.find((file) => file.side === "A")?.selected_role ?? null;
  const roleB = job.file_b_role ?? files.find((file) => file.side === "B")?.selected_role ?? null;
  const compatibility = evaluateOpportunityCompatibility(roleA, roleB);
  if (!compatibility.compatible || !roleA || !roleB) {
    throw new Error(`OPPORTUNITY_ROLES_INCOMPATIBLE_${compatibility.reasonCode}`);
  }
  await Promise.all([
    supabase.from("opportunity_finder_rows").delete().eq("job_id", job.id),
    supabase.from("opportunity_finder_results").delete().eq("job_id", job.id),
    supabase.from("opportunity_finder_possible_matches").delete().eq("job_id", job.id)
  ]);
  await updateJob(supabase, job.id, {
    status: "parsing",
    current_stage: "normalizing_mpn",
    progress_percent: 30,
    processed_rows: 0,
    result_count: 0,
    warning_count: 0
  });

  const metrics: OpportunityParseMetrics[] = [];
  let processedFiles = 0;
  for (const file of files) {
    const role = file.side === "A" ? roleA : roleB;
    await requireNotCancelled(supabase, job.id);
    await supabase.from("opportunity_finder_files").update({ parse_status: "parsing" }).eq("id", file.id);
    const fileMetrics = await parseOpportunityWorkbook({
      filePath: localFiles.get(file.id)!,
      fileName: file.original_file_name,
      fileId: file.id,
      jobId: job.id,
      side: file.side,
      role,
      onBatch: async (rows) => {
        await insertCanonicalRows(supabase, rows);
        await requireNotCancelled(supabase, job.id);
      },
      shouldCancel: () => isCancelled(supabase, job.id)
    });
    metrics.push(fileMetrics);
    processedFiles += 1;
    await supabase.from("opportunity_finder_files").update({
      parse_status: "parsed",
      parsed_at: nowIso(),
      row_count: fileMetrics.totalRows
    }).eq("id", file.id);
    await updateJob(supabase, job.id, {
      processed_rows: metrics.reduce((sum, item) => sum + item.totalRows, 0),
      current_stage: "grouping_quantities",
      progress_percent: processedFiles === 1 ? 55 : 72
    });
  }

  await requireNotCancelled(supabase, job.id);
  await updateJob(supabase, job.id, {
    status: "matching",
    current_stage: "finding_matches",
    progress_percent: 78
  });
  const missingMpnRows = metrics.reduce((sum, item) => sum + item.missingMpnRows, 0);
  const invalidQuantityRows = metrics.reduce((sum, item) => sum + item.invalidQuantityRows, 0);
  const output = await matchCanonicalRowsIncrementally({
    supabase,
    jobId: job.id,
    files,
    roleA,
    roleB,
    supplyRole: compatibility.supplySide === "A" ? roleA : roleB,
    missingMpnRows,
    invalidQuantityRows
  });
  await updateJob(supabase, job.id, {
    current_stage: "generating_opportunities",
    progress_percent: 90
  });
  const warningCount = output.warningCount;
  const completedAt = nowIso();
  await updateJob(supabase, job.id, {
    status: warningCount || invalidQuantityRows ? "completed_with_warnings" : "completed",
    current_stage: "completed",
    progress_percent: 100,
    matched_mpns: output.summary.exactMatches,
    result_count: output.resultCount,
    warning_count: warningCount,
    missing_mpn_rows: missingMpnRows,
    invalid_quantity_rows: invalidQuantityRows,
    summary_json: output.summary,
    completed_at: completedAt,
    locked_at: null,
    locked_by: null,
    heartbeat_at: null,
    error_code: null
  });
}

export async function claimNextOpportunityFinderJob(
  supabase: SupabaseClient,
  workerId: string
) {
  const { data, error } = await supabase.rpc("claim_opportunity_finder_job", {
    worker_id_input: workerId,
    stale_after: "30 minutes"
  });
  if (error) throw error;
  return (data?.[0] ?? null) as OpportunityFinderJobRow | null;
}

export async function processOpportunityFinderJob(
  supabase: SupabaseClient,
  job: OpportunityFinderJobRow,
  workerId: string
) {
  const startedAt = performance.now();
  const logContext = {
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "opportunity-finder-worker",
    method: "WORKER",
    userId: job.created_by
  };
  const heartbeat = setInterval(() => {
    void updateHeartbeat(supabase, job.id, workerId).catch(() => undefined);
  }, 15_000);
  let tempDirectory: string | null = null;
  try {
    const files = await loadJobFiles(supabase, job.id);
    const downloaded = await downloadJobFiles(supabase, files, job.id);
    tempDirectory = downloaded.tempDirectory;
    const localFiles = new Map(downloaded.downloaded.map((item) => [item.file.id, item.localPath]));
    await logger.info({
      ...logContext,
      module: "opportunity-finder",
      action: "job_processing_started",
      message: "Opportunity Finder job processing started.",
      status: "started",
      metadata: { jobId: job.id, stage: job.current_stage, fileCount: files.length }
    });
    if (["inspecting_sheets", "detecting_headers"].includes(job.current_stage)) {
      await profileFiles(supabase, job, files, localFiles);
    } else {
      await parseAndMatch(supabase, job, files, localFiles);
    }
    await logger.info({
      ...logContext,
      module: "opportunity-finder",
      action: "job_processing_completed",
      message: "Opportunity Finder job stage completed.",
      status: "completed",
      durationMs: Math.round(performance.now() - startedAt),
      metadata: { jobId: job.id, stage: job.current_stage }
    });
  } catch (error) {
    const cancelled = error instanceof OpportunityFinderCancelledError || /CANCELLED/.test(error instanceof Error ? error.message : "");
    const canRetry = !cancelled && job.attempts < job.max_attempts;
    await updateJob(supabase, job.id, {
      status: cancelled ? "cancelled" : canRetry ? "queued" : "failed",
      error_code: cancelled ? "JOB_CANCELLED" : safeWorkerErrorCode(error),
      next_retry_at: canRetry ? new Date(Date.now() + Math.min(job.attempts * 60_000, 5 * 60_000)).toISOString() : null,
      cancelled_at: cancelled ? nowIso() : null,
      locked_at: null,
      locked_by: null,
      heartbeat_at: null
    });
    await logger.error({
      ...logContext,
      module: "opportunity-finder",
      action: "job_processing_failed",
      message: "Opportunity Finder job processing failed.",
      status: cancelled ? "completed" : "failed",
      durationMs: Math.round(performance.now() - startedAt),
      metadata: {
        jobId: job.id,
        stage: job.current_stage,
        errorCode: safeWorkerErrorCode(error),
        retryScheduled: canRetry
      }
    });
    if (!cancelled) throw error;
  } finally {
    clearInterval(heartbeat);
    if (tempDirectory) {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
