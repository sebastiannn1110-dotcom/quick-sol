import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateOpportunityCompatibility } from "@/lib/opportunity-finder/compatibility";
import { matchOpportunityRows } from "@/lib/opportunity-finder/matcher";
import { safeContextText } from "@/lib/opportunity-finder/normalization";
import { manufacturerIdentity, mpnIdentity } from "@/lib/opportunity-finder/normalization";
import { OPPORTUNITY_FINDER_PIPELINE_VERSION } from "@/lib/opportunity-finder/pipeline";
import {
  parseOpportunityWorkbook,
  profileOpportunityWorkbook,
  type OpportunityParseMetrics
} from "@/lib/opportunity-finder/parser";
import type {
  CanonicalOpportunityRow,
  OpportunityFileType,
  OpportunityRejectedRow,
  OpportunitySelectedRole,
  OpportunitySummary
} from "@/lib/opportunity-finder/types";
import { logger } from "@/lib/logger/logger";
import { assertCanonicalOpportunityStorageReference } from "@/lib/opportunity-finder/validation";

const INSERT_CHUNK_SIZE = 500;
const QUERY_PAGE_SIZE = 1000;
const OUTPUT_STAGE_CHUNK_SIZE = 500;
const HISTORY_ROLES = new Set<OpportunitySelectedRole>([
  "received_history",
  "purchase_history",
  "quote_history",
  "sales_history"
]);
const CANONICAL_ROW_SELECT = [
  "id", "job_id", "file_id", "side", "sheet_name", "source_row", "original_index",
  "record_role", "record_kind", "template_type", "mapping_version", "header_row",
  "source_row_hidden", "source_columns", "source_cell_refs", "raw_row", "raw_mpn",
  "display_mpn", "normalized_mpn", "review_key", "manufacturer",
  "manufacturer_canonical", "manufacturer_alias_version", "snapshot_key",
  "demand_event_key", "demand_event_source_id", "supply_lot_key", "client_item",
  "plant_facility", "end_customer", "option_ordinal", "is_primary_option",
  "is_approved_alternate", "is_active_demand", "customer_context", "supplier_context",
  "raw_quantity", "required_qty", "available_qty", "excess_qty", "required_date",
  "required_date_quality", "unit_of_measure", "target_price", "target_currency",
  "offer_price", "unit_cost", "currency", "currency_status", "moq", "spq",
  "date_code", "coo", "lead_time_weeks", "transit_time_weeks", "condition",
  "expires_at", "is_live_supply", "quality_flags"
].join(",");

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
  tenant_id?: string;
  client_context?: string | null;
  locked_by?: string | null;
  lock_token?: string | null;
  processing_fence?: number | string | null;
  comparison_mode?: "single_file" | "two_files";
  uploaded_role?: OpportunitySelectedRole | null;
  opposite_dataset_role?: "demand" | "stock" | null;
  snapshot_status?: "not_required" | "pending" | "ready" | "failed";
  dataset_snapshot_id?: string | null;
  dataset_version?: string | null;
  performance_metrics?: Record<string, unknown> | null;
};

type OpportunityWorkerFence = {
  workerId: string;
  lockToken: string;
  processingFence: number;
};

type OpportunityOutputStageKind =
  | "results"
  | "possible_matches"
  | "rejected_rows"
  | "allocations"
  | "commercials"
  | "financials";

type OpportunityOutputStage = OpportunityWorkerFence & {
  jobId: string;
  commitKey: string;
  counts: Record<OpportunityOutputStageKind, number>;
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
  validity_override_expires_at?: string | null;
  content_sha256?: string | null;
  actual_size_bytes?: number | null;
  source_kind?: "uploaded" | "platform_snapshot";
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
  if (/SIZE_MISMATCH/.test(message)) return "FILE_SIZE_MISMATCH";
  if (/HASH_MISMATCH/.test(message)) return "FILE_HASH_MISMATCH";
  if (/MACRO/.test(message)) return "MACRO_FILE_BLOCKED";
  if (/ZIP_BOMB|ZIP_LIMIT|ENCRYPTED/.test(message)) return "UNSAFE_XLSX_PACKAGE";
  if (/ROW_LIMIT/.test(message)) return "FILE_ROW_LIMIT_EXCEEDED";
  if (/FENCE/.test(message)) return "WORKER_FENCE_LOST";
  if (/EXTENSION/.test(message)) return "FILE_EXTENSION_INVALID";
  if (/STORAGE_REFERENCE_INVALID/.test(message)) return "FILE_STORAGE_REFERENCE_INVALID";
  if (/compatib/i.test(message)) return "ROLES_INCOMPATIBLE";
  if (/storage|download|signed/i.test(message)) return "STORAGE_DOWNLOAD_FAILED";
  if (/workbook|xlsx|csv|zip|parse/i.test(message)) return "FILE_PARSE_FAILED";
  return "OPPORTUNITY_PROCESSING_FAILED";
}

async function updateHeartbeat(
  supabase: SupabaseClient,
  jobId: string,
  fence: OpportunityWorkerFence
) {
  const { error, count } = await supabase
    .from("opportunity_finder_jobs")
    .update({ heartbeat_at: nowIso(), locked_by: fence.workerId }, { count: "exact" })
    .eq("id", jobId)
    .eq("locked_by", fence.workerId)
    .eq("lock_token", fence.lockToken)
    .eq("processing_fence", fence.processingFence)
    .in("status", ["profiling", "parsing", "matching"]);
  if (error) throw error;
  if (count === 0) throw new Error("OPPORTUNITY_WORKER_FENCE_LOST");
}

async function updateJob(
  supabase: SupabaseClient,
  jobId: string,
  values: Record<string, unknown>,
  fence?: OpportunityWorkerFence
) {
  let query = supabase
    .from("opportunity_finder_jobs")
    .update({ ...values, heartbeat_at: nowIso(), updated_at: nowIso() }, { count: "exact" })
    .eq("id", jobId);
  if (fence) query = query.eq("locked_by", fence.workerId);
  if (fence) {
    query = query
      .eq("lock_token", fence.lockToken)
      .eq("processing_fence", fence.processingFence);
  }
  const { error, count } = await query;
  if (error) throw error;
  if (fence && count === 0) throw new Error("OPPORTUNITY_WORKER_FENCE_LOST");
}

function jobFence(job: OpportunityFinderJobRow) {
  const processingFence = Number(job.processing_fence);
  if (
    !job.locked_by
    || !job.lock_token
    || !Number.isSafeInteger(processingFence)
    || processingFence <= 0
  ) {
    throw new Error("OPPORTUNITY_OUTPUT_FENCE_MISSING");
  }
  return {
    workerId: job.locked_by,
    lockToken: job.lock_token,
    processingFence
  } satisfies OpportunityWorkerFence;
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
    .select("id,job_id,side,original_file_name,storage_bucket,storage_path,mime_type,size_bytes,detected_type,selected_role,validity_override_expires_at,content_sha256,actual_size_bytes,source_kind")
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
    .createSignedUrl(file.storage_path, 5 * 60);
  if (error || !data?.signedUrl) throw error ?? new Error("STORAGE_SIGNED_URL_FAILED");
  const response = await fetch(data.signedUrl);
  if (!response.ok || !response.body) throw new Error("STORAGE_DOWNLOAD_FAILED");
  const extension = path.extname(file.original_file_name).toLowerCase();
  const localPath = path.join(tempDirectory, `${file.id}${extension}`);
  const webStream = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(Readable.fromWeb(webStream), fs.createWriteStream(localPath));
  return localPath;
}

async function hashLocalFile(filePath: string) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  const stat = await fs.promises.stat(filePath);
  return { contentSha256: hash.digest("hex"), actualSizeBytes: stat.size };
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

function uploadedJobFiles(files: OpportunityFinderFileRow[]) {
  return files.filter((file) => file.source_kind !== "platform_snapshot");
}

async function profileFiles(
  supabase: SupabaseClient,
  job: OpportunityFinderJobRow,
  files: OpportunityFinderFileRow[],
  localFiles: Map<string, string>
) {
  const fence = jobFence(job);
  await updateJob(supabase, job.id, {
    status: "profiling",
    current_stage: "inspecting_sheets",
    progress_percent: 8
  }, fence);
  let processed = 0;
  for (const file of files) {
    await requireNotCancelled(supabase, job.id);
    const { error: profilingStatusError } = await supabase
      .from("opportunity_finder_files")
      .update({ parse_status: "profiling" })
      .eq("id", file.id)
      .eq("job_id", job.id);
    if (profilingStatusError) throw profilingStatusError;
    const profile = await profileOpportunityWorkbook(localFiles.get(file.id)!, file.original_file_name);
    await updateHeartbeat(supabase, job.id, fence);
    processed += 1;
    const { error } = await supabase
      .from("opportunity_finder_files")
      .update({
        detected_type: profile.detectedType,
        classification_score: profile.classificationScore,
        classification_confidence: profile.classificationConfidence ?? "review",
        classification_reasons: profile.classificationReasons,
        sheet_profiles: profile.sheets,
        sheet_count: profile.sheetCount,
        row_count: profile.rowCount,
        useful_row_count: profile.usefulRowCount ?? profile.rowCount,
        hidden_row_count: profile.hiddenRowCount ?? 0,
        template_type: profile.templateType ?? "generic",
        mapping_version: profile.mappingVersion ?? "generic-v1",
        column_mappings: profile.columnMappings ?? [],
        profile_warnings: profile.warnings ?? [],
        profile_errors: profile.errors ?? [],
        profile_json: profile,
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
    }, fence);
  }
  await updateJob(supabase, job.id, {
    status: "awaiting_roles",
    current_stage: "confirming_roles",
    progress_percent: 25,
    attempts: 0,
    locked_at: null,
    locked_by: null,
    lock_token: null,
    heartbeat_at: null
  }, fence);
}

async function discoverSingleFileCandidates(
  supabase: SupabaseClient,
  job: OpportunityFinderJobRow,
  files: OpportunityFinderFileRow[],
  localFiles: Map<string, string>
) {
  const fence = jobFence(job);
  const uploadedFile = uploadedJobFiles(files)[0];
  const role = job.uploaded_role ?? uploadedFile?.selected_role ?? null;
  if (!uploadedFile || !role || role === "ignore") throw new Error("OPPORTUNITY_SINGLE_ROLE_MISSING");
  const { error: resetError } = await supabase.rpc("reset_opportunity_finder_job_attempt", {
    job_id: job.id,
    worker_id: fence.workerId,
    lock_token: fence.lockToken,
    processing_fence: fence.processingFence
  });
  if (resetError) throw resetError;
  const parseStartedAt = performance.now();
  await updateJob(supabase, job.id, {
    status: "parsing",
    current_stage: "normalizing_mpn",
    progress_percent: 32
  }, fence);
  const metrics = await parseOpportunityWorkbook({
    filePath: localFiles.get(uploadedFile.id)!,
    fileName: uploadedFile.original_file_name,
    fileId: uploadedFile.id,
    jobId: job.id,
    side: uploadedFile.side,
    role,
    validityOverrideExpiresAt: uploadedFile.validity_override_expires_at ?? null,
    onBatch: async (rows) => {
      await updateHeartbeat(supabase, job.id, fence);
      await insertCanonicalRows(supabase, rows, fence);
      await requireNotCancelled(supabase, job.id);
    },
    shouldCancel: () => isCancelled(supabase, job.id)
  });
  const parseMs = Math.round((performance.now() - parseStartedAt) * 10) / 10;
  const { error: parsedStatusError } = await supabase
    .from("opportunity_finder_files")
    .update({
      parse_status: "parsed",
      parsed_at: nowIso(),
      row_count: metrics.totalRows,
      hidden_row_count: metrics.hiddenRows
    })
    .eq("id", uploadedFile.id)
    .eq("job_id", job.id);
  if (parsedStatusError) throw parsedStatusError;
  await updateJob(supabase, job.id, {
    status: "awaiting_roles",
    current_stage: "finding_matches",
    progress_percent: 50,
    processed_rows: metrics.totalRows,
    total_rows_a: metrics.totalRows,
    performance_metrics: { parseTimeMs: parseMs },
    attempts: 0,
    locked_at: null,
    locked_by: null,
    lock_token: null
  }, fence);
}

async function insertSingleFileSnapshotRows(
  supabase: SupabaseClient,
  job: OpportunityFinderJobRow,
  files: OpportunityFinderFileRow[],
  fence: OpportunityWorkerFence
) {
  if (job.comparison_mode !== "single_file") return 0;
  if (job.snapshot_status !== "ready" || !job.dataset_snapshot_id) {
    throw new Error("OPPORTUNITY_DATASET_SNAPSHOT_NOT_READY");
  }
  const virtualFile = files.find((file) => file.source_kind === "platform_snapshot");
  if (!virtualFile) throw new Error("OPPORTUNITY_VIRTUAL_FILE_MISSING");
  let offset = 0;
  let originalIndex = 0;
  while (true) {
    const { data, error } = await supabase
      .from("opportunity_finder_dataset_snapshot_rows")
      .select("id,role,source_key,source_upload_id,source_data_version,normalized_mpn,display_mpn,manufacturer,customer_context,supplier_context,required_qty,available_qty,excess_qty,required_date,unit_of_measure,lead_time_weeks,moq,spq,date_code,coo,condition,expires_at,is_active_demand,is_live_supply,quality_flags")
      .eq("job_id", job.id)
      .eq("snapshot_id", job.dataset_snapshot_id)
      .order("normalized_mpn", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as Array<Record<string, unknown>>;
    const canonical = page.map((row): CanonicalOpportunityRow => {
      originalIndex += 1;
      const identity = mpnIdentity(row.display_mpn ?? row.normalized_mpn);
      const manufacturer = typeof row.manufacturer === "string" ? row.manufacturer : null;
      const manufacturerData = manufacturerIdentity(manufacturer);
      const role = row.role as "demand" | "stock" | "excess" | "supplier_offer";
      const sourceKey = String(row.source_key);
      return {
        jobId: job.id,
        fileId: virtualFile.id,
        side: virtualFile.side,
        fileName: virtualFile.original_file_name,
        sheetName: "Base autorizada",
        sourceRow: originalIndex,
        originalIndex,
        recordRole: role,
        recordKind: role === "demand" ? "demand_option" : "supply_lot",
        templateType: "generic",
        mappingVersion: "platform-summary-v1",
        sourceColumns: {
          origin: "Base QuikSol autorizada",
          datasetVersion: job.dataset_version ?? "",
          sourceKey
        },
        sourceCellRefs: {},
        rawRow: {},
        ...identity,
        manufacturer,
        manufacturerCanonical: manufacturerData.canonical || null,
        manufacturerAliasVersion: manufacturerData.aliasVersion,
        snapshotKey: job.dataset_snapshot_id,
        demandEventKey: role === "demand" ? sourceKey : null,
        demandEventSourceId: role === "demand" ? sourceKey : null,
        supplyLotKey: role === "demand" ? null : sourceKey,
        optionOrdinal: role === "demand" ? 1 : null,
        isPrimaryOption: role === "demand" ? true : null,
        isApprovedAlternate: role === "demand" ? false : null,
        isActiveDemand: Boolean(row.is_active_demand),
        customerContext: typeof row.customer_context === "string" ? row.customer_context : null,
        supplierContext: typeof row.supplier_context === "string" ? row.supplier_context : null,
        requiredQty: nullableNumber(row.required_qty),
        availableQty: nullableNumber(row.available_qty),
        excessQty: nullableNumber(row.excess_qty),
        requiredDate: typeof row.required_date === "string" ? row.required_date : null,
        requiredDateQuality: row.required_date ? "valid" : "missing",
        unitOfMeasure: typeof row.unit_of_measure === "string" ? row.unit_of_measure : null,
        leadTimeWeeks: nullableNumber(row.lead_time_weeks),
        moq: nullableNumber(row.moq),
        spq: nullableNumber(row.spq),
        dateCode: typeof row.date_code === "string" ? row.date_code : null,
        coo: typeof row.coo === "string" ? row.coo : null,
        condition: typeof row.condition === "string" ? row.condition : null,
        expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
        isLiveSupply: Boolean(row.is_live_supply),
        qualityFlags: (Array.isArray(row.quality_flags) ? row.quality_flags : []) as CanonicalOpportunityRow["qualityFlags"]
      };
    });
    await insertCanonicalRows(supabase, canonical, fence);
    if (page.length < QUERY_PAGE_SIZE) break;
    offset += page.length;
  }
  return originalIndex;
}

function rowInsert(row: CanonicalOpportunityRow, fence: OpportunityWorkerFence) {
  return {
    job_id: row.jobId,
    file_id: row.fileId,
    side: row.side,
    sheet_name: row.sheetName,
    source_row: row.sourceRow,
    original_index: row.originalIndex,
    record_role: row.recordRole,
    record_kind: row.recordKind ?? (row.recordRole === "demand" ? "demand_option" : HISTORY_ROLES.has(row.recordRole) ? "historical_signal" : "supply_lot"),
    template_type: row.templateType ?? "generic",
    mapping_version: row.mappingVersion ?? "generic-v1",
    header_row: row.headerRow ?? null,
    source_row_hidden: Boolean(row.sourceRowHidden),
    source_columns: row.sourceColumns ?? {},
    source_cell_refs: row.sourceCellRefs ?? {},
    raw_row: row.rawRow ?? {},
    raw_mpn: row.rawMpn,
    display_mpn: row.displayMpn,
    normalized_mpn: row.normalizedMpn,
    review_key: row.reviewKey,
    manufacturer: row.manufacturer,
    manufacturer_canonical: row.manufacturerCanonical ?? null,
    manufacturer_alias_version: row.manufacturerAliasVersion ?? null,
    snapshot_key: row.snapshotKey ?? null,
    demand_event_key: row.demandEventKey ?? null,
    demand_event_source_id: row.demandEventSourceId ?? null,
    supply_lot_key: row.supplyLotKey ?? null,
    client_item: row.clientItem ?? null,
    plant_facility: row.plantFacility ?? null,
    end_customer: row.endCustomer ?? null,
    option_ordinal: row.optionOrdinal ?? null,
    is_primary_option: row.isPrimaryOption ?? null,
    is_approved_alternate: row.isApprovedAlternate ?? null,
    is_active_demand: row.isActiveDemand ?? true,
    customer_context: row.customerContext,
    supplier_context: row.supplierContext,
    raw_quantity: row.rawQuantity ?? null,
    required_qty: row.requiredQty,
    available_qty: row.availableQty,
    excess_qty: row.excessQty,
    required_date: row.requiredDate,
    required_date_quality: row.requiredDateQuality ?? null,
    unit_of_measure: row.unitOfMeasure,
    target_price: row.targetPrice ?? null,
    target_currency: row.targetCurrency ?? null,
    offer_price: row.offerPrice ?? null,
    unit_cost: row.unitCost ?? null,
    currency: row.currency ?? null,
    currency_status: row.currencyStatus ?? "unconfirmed",
    moq: row.moq ?? null,
    spq: row.spq ?? null,
    date_code: row.dateCode ?? null,
    coo: row.coo ?? null,
    lead_time_weeks: row.leadTimeWeeks ?? null,
    transit_time_weeks: row.transitTimeWeeks ?? null,
    condition: row.condition ?? null,
    expires_at: row.expiresAt ?? null,
    is_live_supply: row.isLiveSupply ?? null,
    ingestion_lock_token: fence.lockToken,
    ingestion_fence: fence.processingFence,
    quality_flags: row.qualityFlags
  };
}

async function insertCanonicalRows(
  supabase: SupabaseClient,
  rows: CanonicalOpportunityRow[],
  fence: OpportunityWorkerFence
) {
  for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
    const { error } = await supabase
      .from("opportunity_finder_rows")
      .insert(rows.slice(index, index + INSERT_CHUNK_SIZE).map((row) => rowInsert(row, fence)));
    if (error) throw error;
  }
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    recordKind: row.record_kind as CanonicalOpportunityRow["recordKind"],
    templateType: row.template_type as CanonicalOpportunityRow["templateType"],
    mappingVersion: row.mapping_version as string | undefined,
    headerRow: nullableNumber(row.header_row),
    sourceRowHidden: Boolean(row.source_row_hidden),
    sourceColumns: (row.source_columns ?? {}) as Record<string, string>,
    sourceCellRefs: (row.source_cell_refs ?? {}) as Record<string, string>,
    rawRow: (row.raw_row ?? {}) as Record<string, string | null>,
    rawMpn: row.raw_mpn as string,
    displayMpn: row.display_mpn as string,
    normalizedMpn: row.normalized_mpn as string,
    reviewKey: row.review_key as string,
    manufacturer: row.manufacturer as string | null,
    manufacturerCanonical: row.manufacturer_canonical as string | null,
    manufacturerAliasVersion: row.manufacturer_alias_version as string | null,
    snapshotKey: row.snapshot_key as string | null,
    demandEventKey: row.demand_event_key as string | null,
    demandEventSourceId: row.demand_event_source_id as string | null,
    supplyLotKey: row.supply_lot_key as string | null,
    clientItem: row.client_item as string | null,
    plantFacility: row.plant_facility as string | null,
    endCustomer: row.end_customer as string | null,
    optionOrdinal: nullableNumber(row.option_ordinal),
    isPrimaryOption: row.is_primary_option as boolean | null,
    isApprovedAlternate: row.is_approved_alternate as boolean | null,
    isActiveDemand: row.is_active_demand === null ? true : Boolean(row.is_active_demand),
    customerContext: row.customer_context as string | null,
    supplierContext: row.supplier_context as string | null,
    rawQuantity: row.raw_quantity as string | null,
    requiredQty: nullableNumber(row.required_qty),
    availableQty: nullableNumber(row.available_qty),
    excessQty: nullableNumber(row.excess_qty),
    requiredDate: row.required_date as string | null,
    requiredDateQuality: row.required_date_quality as CanonicalOpportunityRow["requiredDateQuality"],
    unitOfMeasure: row.unit_of_measure as string | null,
    targetPrice: nullableNumber(row.target_price),
    targetCurrency: row.target_currency as string | null,
    offerPrice: nullableNumber(row.offer_price),
    unitCost: nullableNumber(row.unit_cost),
    currency: row.currency as string | null,
    currencyStatus: row.currency_status as CanonicalOpportunityRow["currencyStatus"],
    moq: nullableNumber(row.moq),
    spq: nullableNumber(row.spq),
    dateCode: row.date_code as string | null,
    coo: row.coo as string | null,
    leadTimeWeeks: nullableNumber(row.lead_time_weeks),
    transitTimeWeeks: nullableNumber(row.transit_time_weeks),
    condition: row.condition as string | null,
    expiresAt: row.expires_at as string | null,
    isLiveSupply: row.is_live_supply as boolean | null,
    qualityFlags: (row.quality_flags ?? []) as CanonicalOpportunityRow["qualityFlags"]
  };
}

type MaterializedEntityIdentityMaps = {
  demandPartOptionIdsByIdentity: ReadonlyMap<string, string>;
  demandPartOptionIdsByOriginalIndex: ReadonlyMap<string, string>;
  supplyLotIdsByKey: ReadonlyMap<string, string>;
  supplyLotIdsBySource: ReadonlyMap<string, string>;
  demandEventCount: number;
  demandPartOptionCount: number;
  supplyLotCount: number;
};

function materializedDemandEventKey(row: CanonicalOpportunityRow) {
  const explicit = row.demandEventKey?.trim();
  return explicit || [
    row.normalizedMpn,
    row.customerContext ?? "",
    row.requiredDate ?? "",
    row.unitOfMeasure ?? ""
  ].join("\u001f");
}

export function demandRowWithFallbackContext(
  row: CanonicalOpportunityRow,
  fallbackContext?: string | null
) {
  const customerContext = safeContextText(row.customerContext, 160) ??
    safeContextText(fallbackContext, 160);
  return customerContext === row.customerContext
    ? row
    : { ...row, customerContext };
}

function demandPartOptionSourceKey(input: {
  eventKey: string;
  fileId: string;
  normalizedMpn: string;
  sheetName: string;
  sourceRow: number;
  originalIndex: number;
  optionOrdinal: number;
}) {
  return JSON.stringify([
    input.eventKey,
    input.fileId,
    input.normalizedMpn,
    input.sheetName,
    input.sourceRow,
    input.originalIndex,
    input.optionOrdinal
  ]);
}

function demandPartOptionOriginalIndexKey(input: {
  eventKey: string;
  fileId: string;
  normalizedMpn: string;
  sheetName: string;
  sourceRow: number;
  originalIndex: number;
}) {
  return JSON.stringify([
    input.eventKey,
    input.fileId,
    input.normalizedMpn,
    input.sheetName,
    input.sourceRow,
    input.originalIndex
  ]);
}

function supplyLotSourceKey(input: {
  fileId: string;
  normalizedMpn: string;
  sheetName: string;
  sourceRow: number;
  originalIndex: number;
}) {
  return JSON.stringify([
    input.fileId,
    input.normalizedMpn,
    input.sheetName,
    input.sourceRow,
    input.originalIndex
  ]);
}

function traceRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function loadMaterializedRows(
  supabase: SupabaseClient,
  table: string,
  select: string,
  jobId: string
) {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq("job_id", jobId)
      .order("id", { ascending: true })
      .range(offset, offset + QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < QUERY_PAGE_SIZE) break;
    offset += page.length;
  }
  return rows;
}

async function loadMaterializedEntityIdentityMaps(
  supabase: SupabaseClient,
  jobId: string
): Promise<MaterializedEntityIdentityMaps> {
  const [events, options, lots] = await Promise.all([
    loadMaterializedRows(
      supabase,
      "opportunity_finder_demand_events",
      "id,event_key",
      jobId
    ),
    loadMaterializedRows(
      supabase,
      "opportunity_finder_demand_part_options",
      "id,demand_event_id,file_id,exact_norm,option_ordinal,source_trace",
      jobId
    ),
    loadMaterializedRows(
      supabase,
      "opportunity_finder_supply_lots",
      "id,lot_key,file_id,exact_norm,source_trace",
      jobId
    )
  ]);
  const eventKeys = new Map(events.map((event) => [
    String(event.id),
    String(event.event_key)
  ]));
  const demandPartOptionIdsByIdentity = new Map<string, string>();
  const demandPartOptionIdsByOriginalIndex = new Map<string, string>();
  for (const option of options) {
    const eventKey = eventKeys.get(String(option.demand_event_id));
    const trace = traceRecord(option.source_trace);
    const sourceRow = Number(trace.sourceRow);
    const originalIndex = Number(trace.originalIndex);
    const optionOrdinal = Number(trace.optionOrdinal ?? option.option_ordinal);
    if (
      !eventKey ||
      !Number.isFinite(sourceRow) ||
      !Number.isFinite(originalIndex) ||
      !Number.isFinite(optionOrdinal)
    ) continue;
    const sourceIdentity = {
      eventKey,
      fileId: String(option.file_id),
      normalizedMpn: String(option.exact_norm),
      sheetName: String(trace.sheetName ?? ""),
      sourceRow,
      originalIndex
    };
    demandPartOptionIdsByIdentity.set(demandPartOptionSourceKey({
      ...sourceIdentity,
      optionOrdinal
    }), String(option.id));
    demandPartOptionIdsByOriginalIndex.set(
      demandPartOptionOriginalIndexKey(sourceIdentity),
      String(option.id)
    );
  }
  const supplyLotIdsByKey = new Map<string, string>();
  const supplyLotIdsBySource = new Map<string, string>();
  for (const lot of lots) {
    const id = String(lot.id);
    const lotKey = String(lot.lot_key ?? "");
    if (lotKey) supplyLotIdsByKey.set(lotKey, id);
    const trace = traceRecord(lot.source_trace);
    const sourceRow = Number(trace.sourceRow);
    const originalIndex = Number(trace.originalIndex);
    if (!Number.isFinite(sourceRow) || !Number.isFinite(originalIndex)) continue;
    supplyLotIdsBySource.set(supplyLotSourceKey({
      fileId: String(lot.file_id),
      normalizedMpn: String(lot.exact_norm),
      sheetName: String(trace.sheetName ?? ""),
      sourceRow,
      originalIndex
    }), id);
  }
  return {
    demandPartOptionIdsByIdentity,
    demandPartOptionIdsByOriginalIndex,
    supplyLotIdsByKey,
    supplyLotIdsBySource,
    demandEventCount: events.length,
    demandPartOptionCount: options.length,
    supplyLotCount: lots.length
  };
}

export function attachMaterializedEntityIds(
  row: CanonicalOpportunityRow,
  identities: MaterializedEntityIdentityMaps
): CanonicalOpportunityRow {
  const demandPartOptionId = row.demandPartOptionId ?? (
    row.recordRole === "demand"
      ? (
        row.optionOrdinal !== null && row.optionOrdinal !== undefined
          ? identities.demandPartOptionIdsByIdentity.get(demandPartOptionSourceKey({
            eventKey: materializedDemandEventKey(row),
            fileId: row.fileId,
            normalizedMpn: row.normalizedMpn,
            sheetName: row.sheetName,
            sourceRow: row.sourceRow,
            originalIndex: row.originalIndex,
            optionOrdinal: row.optionOrdinal
          }))
          : undefined
      ) ?? identities.demandPartOptionIdsByOriginalIndex.get(demandPartOptionOriginalIndexKey({
        eventKey: materializedDemandEventKey(row),
        fileId: row.fileId,
        normalizedMpn: row.normalizedMpn,
        sheetName: row.sheetName,
        sourceRow: row.sourceRow,
        originalIndex: row.originalIndex
      })) ?? null
      : null
  );
  const supplyLotId = row.supplyLotId ?? (
    row.recordKind === "supply_lot" || ["stock", "excess", "supplier_offer"].includes(row.recordRole)
      ? (
        row.supplyLotKey
          ? identities.supplyLotIdsByKey.get(row.supplyLotKey)
          : undefined
      ) ?? identities.supplyLotIdsBySource.get(supplyLotSourceKey({
        fileId: row.fileId,
        normalizedMpn: row.normalizedMpn,
        sheetName: row.sheetName,
        sourceRow: row.sourceRow,
        originalIndex: row.originalIndex
      })) ?? null
      : null
  );
  return { ...row, demandPartOptionId, supplyLotId };
}

async function loadCanonicalRowsByRole(
  supabase: SupabaseClient,
  jobId: string,
  files: OpportunityFinderFileRow[],
  role: OpportunitySelectedRole,
  fence: OpportunityWorkerFence
) {
  const fileNames = new Map(files.map((file) => [file.id, file.original_file_name]));
  const rows: CanonicalOpportunityRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("opportunity_finder_rows")
      .select(CANONICAL_ROW_SELECT)
      .eq("job_id", jobId)
      .eq("ingestion_lock_token", fence.lockToken)
      .eq("ingestion_fence", fence.processingFence)
      .eq("record_role", role)
      .order("normalized_mpn", { ascending: true })
      .order("required_date", { ascending: true, nullsFirst: false })
      .order("original_index", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map((row) => databaseCanonicalRow({
      ...row,
      file_name: fileNames.get(row.file_id as string) ?? ""
    })));
    if (page.length < QUERY_PAGE_SIZE) break;
    offset += page.length;
  }
  return rows;
}

function uniqueSupplyRows(rows: CanonicalOpportunityRow[]) {
  return Array.from(new Map(rows.map((row) => [
    row.supplyLotKey || `${row.fileId}:${row.sheetName}:${row.sourceRow}:${row.originalIndex}`,
    row
  ])).values());
}

async function loadCurrentComparisonSupplyRows(
  supabase: SupabaseClient,
  jobId: string,
  files: OpportunityFinderFileRow[],
  primaryRole: OpportunitySelectedRole,
  fence: OpportunityWorkerFence,
  roles?: OpportunitySelectedRole[]
) {
  const requestedRoles = roles ?? Array.from(new Set([
    primaryRole,
    ...(primaryRole === "supplier_offer" ? [] : ["supplier_offer" as const])
  ]));
  const roleRows = await Promise.all(requestedRoles.map((role) =>
    loadCanonicalRowsByRole(supabase, jobId, files, role, fence)
  ));
  return uniqueSupplyRows(roleRows.flat());
}

function emptyOpportunitySummary(): OpportunitySummary {
  return {
    analyzedMpns: 0,
    exactMatches: 0,
    usableAvailabilityMatches: 0,
    exactQuantityMatches: 0,
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
    possibleMatches: 0,
    rejectedRows: 0,
    demandEvents: 0,
    demandPartOptions: 0,
    supplyLots: 0
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
  supplyRoles?: OpportunitySelectedRole[];
  missingMpnRows: number;
  invalidQuantityRows: number;
  rejectedRows: number;
  outputStage: OpportunityOutputStage;
  lockToken: string;
  workerId: string;
  processingFence: number;
  customerContext?: string | null;
}) {
  const fence: OpportunityWorkerFence = {
    workerId: input.workerId,
    lockToken: input.lockToken,
    processingFence: input.processingFence
  };
  const [identities, rawSupplyRows] = await Promise.all([
    loadMaterializedEntityIdentityMaps(input.supabase, input.jobId),
    loadCurrentComparisonSupplyRows(
      input.supabase,
      input.jobId,
      input.files,
      input.supplyRole,
      fence,
      input.supplyRoles
    )
  ]);
  const supplyRows = rawSupplyRows.map((row) => attachMaterializedEntityIds(row, identities));
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
  summary.rejectedRows = input.rejectedRows;
  summary.demandEvents = identities.demandEventCount;
  summary.demandPartOptions = identities.demandPartOptionCount;
  summary.supplyLots = identities.supplyLotCount;
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
      roleB: input.roleB,
      clientContext: input.customerContext
    });
    output.results = output.results.filter((result) =>
      result.opportunityType !== "supply_without_demand" ||
      result.normalizedMpn === normalizedMpn
    );
    await stageMatchOutput(input.supabase, input.outputStage, output);
    if (output.results.some((result) => result.usableAvailabilityMatch)) {
      summary.usableAvailabilityMatches += 1;
    }
    summary.exactQuantityMatches += output.results.filter(
      (result) => result.exactQuantityMatch
    ).length;
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
      .select(CANONICAL_ROW_SELECT)
      .eq("job_id", input.jobId)
      .eq("ingestion_lock_token", input.lockToken)
      .eq("ingestion_fence", input.processingFence)
      .eq("record_role", "demand")
      .order("normalized_mpn", { ascending: true })
      .order("required_date", { ascending: true, nullsFirst: false })
      .order("original_index", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const databaseRow of page) {
      const row = attachMaterializedEntityIds(
        demandRowWithFallbackContext(databaseCanonicalRow({
          ...databaseRow,
          file_name: fileNames.get(databaseRow.file_id as string) ?? ""
        }), input.customerContext),
        identities
      );
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

  if (!HISTORY_ROLES.has(input.supplyRole)) {
    for (const [normalizedMpn, rows] of supplyByMpn) {
      if (demandMpns.has(normalizedMpn)) continue;
      const output = matchOpportunityRows({
        jobId: input.jobId,
        rows,
        roleA: input.roleA,
        roleB: input.roleB,
        clientContext: input.customerContext
      });
      await stageMatchOutput(input.supabase, input.outputStage, output);
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

async function matchCanonicalRowsByEvent(input: {
  supabase: SupabaseClient;
  jobId: string;
  files: OpportunityFinderFileRow[];
  roleA: OpportunitySelectedRole;
  roleB: OpportunitySelectedRole;
  supplyRole: OpportunitySelectedRole;
  supplyRoles?: OpportunitySelectedRole[];
  missingMpnRows: number;
  invalidQuantityRows: number;
  rejectedRows: number;
  outputStage: OpportunityOutputStage;
  lockToken: string;
  workerId: string;
  processingFence: number;
  customerContext?: string | null;
}) {
  const fence: OpportunityWorkerFence = {
    workerId: input.workerId,
    lockToken: input.lockToken,
    processingFence: input.processingFence
  };
  const [identities, rawDemandRows, rawSupplyRows] = await Promise.all([
    loadMaterializedEntityIdentityMaps(input.supabase, input.jobId),
    loadCanonicalRowsByRole(input.supabase, input.jobId, input.files, "demand", fence),
    loadCurrentComparisonSupplyRows(
      input.supabase,
      input.jobId,
      input.files,
      input.supplyRole,
      fence,
      input.supplyRoles
    )
  ]);
  const demandRows = rawDemandRows.map((row) => attachMaterializedEntityIds(
    demandRowWithFallbackContext(row, input.customerContext),
    identities
  ));
  const supplyRows = rawSupplyRows.map((row) => attachMaterializedEntityIds(row, identities));
  const output = matchOpportunityRows({
    jobId: input.jobId,
    rows: [...demandRows, ...supplyRows],
    roleA: input.roleA,
    roleB: input.roleB,
    clientContext: input.customerContext,
    missingMpnRows: input.missingMpnRows,
    invalidQuantityRows: input.invalidQuantityRows,
    rejectedRows: input.rejectedRows
  });
  await stageMatchOutput(input.supabase, input.outputStage, output);
  return {
    summary: output.summary,
    resultCount: output.results.length,
    warningCount: output.results.reduce((sum, result) => sum + result.warnings.length, 0)
  };
}

function deterministicUuidFromHex(hex: string) {
  const value = hex.slice(0, 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16], 16) & 0x3) | 0x8).toString(16);
  const compact = value.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function candidateUuid(candidateKey: string) {
  if (!/^[a-f0-9]{64}$/i.test(candidateKey)) {
    throw new Error("OPPORTUNITY_CANDIDATE_KEY_INVALID");
  }
  return deterministicUuidFromHex(candidateKey.toLowerCase());
}

function resultIdentity(result: ReturnType<typeof matchOpportunityRows>["results"][number]) {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      jobId: result.jobId,
      opportunityType: result.opportunityType,
      demandEventKey: result.demandEventKey ?? null,
      normalizedMpn: result.normalizedMpn,
      customerContext: result.customerContext,
      supplierContext: result.supplierContext,
      requiredDate: result.requiredDate,
      ...(result.candidateId ? { candidateId: result.candidateId } : {}),
      demandTraces: (result.demandTraces ?? []).map((trace) => [
        trace.fileId,
        trace.sheetName,
        trace.sourceRow
      ]),
      supplyTraces: (result.supplyTraces ?? []).map((trace) => [
        trace.fileId,
        trace.sheetName,
        trace.sourceRow
      ])
    }), "utf8")
    .digest("hex");
  return { resultKey: digest, id: deterministicUuidFromHex(digest) };
}

export function resultInsert(result: ReturnType<typeof matchOpportunityRows>["results"][number]) {
  const identity = resultIdentity(result);
  result.id = result.id ?? identity.id;
  return {
    id: result.id,
    result_key: identity.resultKey,
    job_id: result.jobId,
    opportunity_type: result.opportunityType,
    exact_match: result.exactMpnMatch,
    exact_mpn_match: result.exactMpnMatch,
    usable_availability_match: result.usableAvailabilityMatch,
    exact_quantity_match: result.exactQuantityMatch,
    match_tier: result.matchTier ?? null,
    confidence: result.confidence ?? "low",
    match_explanation: result.matchExplanation ?? null,
    review_status: result.reviewStatus ?? "not_required",
    candidate_id: result.candidateId ?? null,
    demand_event_key: result.demandEventKey ?? null,
    demand_mpn_original: result.demandMpnOriginal ?? null,
    supply_mpn_original: result.supplyMpnOriginal ?? null,
    display_mpn: result.displayMpn,
    normalized_mpn: result.normalizedMpn,
    manufacturer: result.manufacturer,
    manufacturer_canonical: result.manufacturerCanonical ?? null,
    customer_context: result.customerContext,
    supplier_context: result.supplierContext,
    required_qty: result.requiredQty,
    available_qty: result.availableQty,
    allocated_qty: result.allocatedQty,
    remaining_qty: result.remainingQty ?? null,
    shortage_qty: result.shortageQty,
    coverage_percent: result.coveragePercent,
    required_date: result.requiredDate,
    unit_of_measure: result.unitOfMeasure,
    moq: result.moq ?? null,
    spq: result.spq ?? null,
    date_code: result.dateCode ?? null,
    coo: result.coo ?? null,
    lead_time_weeks: result.leadTimeWeeks ?? null,
    condition: result.condition ?? null,
    expires_at: result.expiresAt ?? null,
    demand_file_id: result.demandFileId,
    demand_file_name: result.demandFileName,
    demand_sheet_name: result.demandSheetName,
    supply_file_id: result.supplyFileId,
    supply_file_name: result.supplyFileName,
    supply_sheet_name: result.supplySheetName,
    demand_source_rows: result.demandSourceRows,
    supply_source_rows: result.supplySourceRows,
    demand_traces: result.demandTraces ?? [],
    supply_traces: result.supplyTraces ?? [],
    allocations_trace: result.allocations ?? [],
    reason_code: result.reasonCode,
    action_code: result.actionCode,
    warnings: result.warnings
  };
}

export function commercialInsert(
  result: ReturnType<typeof matchOpportunityRows>["results"][number],
  resultId: string
) {
  const values = [
    result.targetPrice,
    result.offerPrice,
    result.targetGapPercent,
    result.revenuePotential,
    result.currency
  ];
  if (values.every((value) => value === null || value === undefined || value === "")) return null;
  return {
    result_id: resultId,
    job_id: result.jobId,
    target_price: result.targetPrice ?? null,
    offer_price: result.offerPrice ?? null,
    target_gap_percent: result.targetGapPercent ?? null,
    currency: result.currency ?? null,
    revenue_potential: result.revenuePotential ?? null,
    pricing_quality: result.pricingQuality ?? ((
      result.targetPrice !== null && result.targetPrice !== undefined ||
      result.offerPrice !== null && result.offerPrice !== undefined
    ) && (
      (result.targetPrice === null || result.targetPrice === undefined || Boolean(result.targetCurrency)) &&
      (result.offerPrice === null || result.offerPrice === undefined || Boolean(result.offerCurrency)) &&
      (
        result.targetPrice === null || result.targetPrice === undefined ||
        result.offerPrice === null || result.offerPrice === undefined ||
        result.targetCurrency === result.offerCurrency
      )
    )
      ? "confirmed"
      : "unconfirmed")
  };
}

export function financialInsert(
  result: ReturnType<typeof matchOpportunityRows>["results"][number],
  resultId: string
) {
  const values = [result.unitCost, result.grossProfit, result.grossMarginPercent];
  if (values.every((value) => value === null || value === undefined)) return null;
  const validCost = result.financialQuality === "valid" && Boolean(result.costCurrency);
  return {
    result_id: resultId,
    job_id: result.jobId,
    unit_cost: result.unitCost ?? null,
    cost_currency: validCost ? result.costCurrency ?? null : null,
    gross_profit: validCost ? result.grossProfit ?? null : null,
    gross_margin_percent: validCost ? result.grossMarginPercent ?? null : null,
    cost_quality: validCost ? "valid" : "untrusted",
    cost_source_trace: {
      sources: result.allocations?.length
        ? result.allocations.map((allocation) => allocation.supply)
        : result.supplyTraces ?? []
    },
    computed_at: validCost ? nowIso() : null
  };
}

function allocationInserts(
  result: ReturnType<typeof matchOpportunityRows>["results"][number],
  resultId: string
) {
  return (result.allocations ?? []).map((allocation, allocationIndex) => {
    if (!allocation.demandPartOptionId) {
      throw new Error("OPPORTUNITY_ALLOCATION_DEMAND_OPTION_ID_MISSING");
    }
    if (!allocation.supplyLotId) {
      throw new Error("OPPORTUNITY_ALLOCATION_SUPPLY_LOT_ID_MISSING");
    }
    return {
      allocation_key: `${resultId}:${allocation.lotKey}`,
      result_id: resultId,
      demand_event_key: result.demandEventKey ?? null,
      demand_part_option_id: allocation.demandPartOptionId,
      supply_lot_id: allocation.supplyLotId,
      supply_lot_key: allocation.lotKey,
      allocated_qty: allocation.allocatedQty,
      reserved_qty: allocation.reservedQty ?? allocation.allocatedQty,
      deterministic_rank: allocationIndex,
      decision_trace: {
        matchTier: result.matchTier ?? null,
        confidence: result.confidence ?? null,
        reasonCode: result.reasonCode
      },
      supply_trace: allocation.supply
    };
  });
}

export function possibleMatchInsert(
  match: ReturnType<typeof matchOpportunityRows>["possibleMatches"][number]
) {
  const id = candidateUuid(match.candidateKey);
  match.id = match.id ?? id;
  if (match.id !== id) throw new Error("OPPORTUNITY_CANDIDATE_ID_CONFLICT");
  return {
    id,
    job_id: match.jobId,
    candidate_key: match.candidateKey,
    demand_option_id: match.demandOptionId,
    supply_lot_id: match.supplyLotId,
    demand_display_mpn: match.demandDisplayMpn,
    supply_display_mpn: match.supplyDisplayMpn,
    demand_normalized_mpn: match.demandNormalizedMpn,
    supply_normalized_mpn: match.supplyNormalizedMpn,
    review_key: match.reviewKey,
    demand_file_id: match.demandFileId,
    supply_file_id: match.supplyFileId,
    reason_code: match.reasonCode,
    match_tier: match.matchTier ?? "search_mpn_mfg",
    confidence: match.confidence ?? "review",
    review_status: match.reviewStatus ?? "pending",
    explanation: match.explanation ?? null,
    manufacturer_compatible: match.manufacturerCompatible ?? null,
    demand_trace: match.demandTrace ?? null,
    supply_trace: match.supplyTrace ?? null
  };
}

function rejectedRowInsert(row: OpportunityRejectedRow) {
  return {
    job_id: row.jobId,
    file_id: row.fileId,
    side: row.side,
    file_name: row.fileName,
    sheet_name: row.sheetName,
    source_row: row.sourceRow,
    source_row_hidden: row.hidden,
    reason_code: row.reasonCode,
    field_name: row.fieldName,
    source_column: row.sourceColumn,
    safe_raw_value: row.safeRawValue,
    source_trace: {
      fileId: row.fileId,
      fileName: row.fileName,
      sheetName: row.sheetName,
      sourceRow: row.sourceRow,
      hidden: row.hidden,
      columns: row.sourceColumn && row.fieldName
        ? { [row.fieldName]: row.sourceColumn }
        : {}
    }
  };
}

function emptyOutputStageCounts(): Record<OpportunityOutputStageKind, number> {
  return {
    results: 0,
    possible_matches: 0,
    rejected_rows: 0,
    allocations: 0,
    commercials: 0,
    financials: 0
  };
}

async function beginMatchOutputStage(
  supabase: SupabaseClient,
  jobId: string,
  fence: OpportunityWorkerFence
): Promise<OpportunityOutputStage> {
  const commitKey = `opportunity-output-v4:${jobId}:${fence.lockToken}`;
  const { error } = await supabase.rpc("begin_opportunity_finder_output", {
    job_id: jobId,
    worker_id: fence.workerId,
    lock_token: fence.lockToken,
    processing_fence: fence.processingFence,
    commit_key: commitKey
  });
  if (error) throw error;
  return { ...fence, jobId, commitKey, counts: emptyOutputStageCounts() };
}

async function appendMatchOutputItems(
  supabase: SupabaseClient,
  stage: OpportunityOutputStage,
  outputKind: OpportunityOutputStageKind,
  items: unknown[]
) {
  for (let index = 0; index < items.length; index += OUTPUT_STAGE_CHUNK_SIZE) {
    const chunk = items.slice(index, index + OUTPUT_STAGE_CHUNK_SIZE);
    const startIndex = stage.counts[outputKind];
    const { error } = await supabase.rpc("append_opportunity_finder_output", {
      job_id: stage.jobId,
      worker_id: stage.workerId,
      lock_token: stage.lockToken,
      processing_fence: stage.processingFence,
      commit_key: stage.commitKey,
      output_kind: outputKind,
      start_index: startIndex,
      items: chunk
    });
    if (error) throw error;
    stage.counts[outputKind] += chunk.length;
  }
}

async function stageMatchOutput(
  supabase: SupabaseClient,
  stage: OpportunityOutputStage,
  output: ReturnType<typeof matchOpportunityRows>
) {
  const resultRows = output.results.map(resultInsert);
  const commercials = output.results.flatMap((result, index) => {
    const row = commercialInsert(result, resultRows[index].id);
    return row ? [row] : [];
  });
  const financials = output.results.flatMap((result, index) => {
    const row = financialInsert(result, resultRows[index].id);
    return row ? [row] : [];
  });
  const allocations = output.results.flatMap((result, index) =>
    allocationInserts(result, resultRows[index].id)
  );

  await appendMatchOutputItems(supabase, stage, "results", resultRows);
  await appendMatchOutputItems(supabase, stage, "possible_matches", output.possibleMatches.map(possibleMatchInsert));
  await appendMatchOutputItems(supabase, stage, "commercials", commercials);
  await appendMatchOutputItems(supabase, stage, "financials", financials);
  await appendMatchOutputItems(supabase, stage, "allocations", allocations);
}

async function commitMatchOutputStage(
  supabase: SupabaseClient,
  stage: OpportunityOutputStage,
  summary: OpportunitySummary,
  warningCount: number
) {
  const { error } = await supabase.rpc("commit_staged_opportunity_finder_output", {
    job_id: stage.jobId,
    worker_id: stage.workerId,
    lock_token: stage.lockToken,
    processing_fence: stage.processingFence,
    commit_key: stage.commitKey,
    expected_counts: stage.counts,
    summary,
    warning_count: warningCount,
    missing_mpn_rows: summary.missingMpnRows,
    invalid_quantity_rows: summary.invalidQuantityRows
  });
  if (error) throw error;
}

async function parseAndMatch(
  supabase: SupabaseClient,
  job: OpportunityFinderJobRow,
  files: OpportunityFinderFileRow[],
  localFiles: Map<string, string>
) {
  const parseStartedAt = performance.now();
  const roleA = job.file_a_role ?? files.find((file) => file.side === "A")?.selected_role ?? null;
  const roleB = job.file_b_role ?? files.find((file) => file.side === "B")?.selected_role ?? null;
  const compatibility = evaluateOpportunityCompatibility(roleA, roleB);
  if (!compatibility.compatible || !roleA || !roleB) {
    throw new Error(`OPPORTUNITY_ROLES_INCOMPATIBLE_${compatibility.reasonCode}`);
  }
  const fence = jobFence(job);
  await updateHeartbeat(supabase, job.id, fence);
  const { error: resetError } = await supabase.rpc(
    "reset_opportunity_finder_job_attempt",
    {
      job_id: job.id,
      worker_id: fence.workerId,
      lock_token: fence.lockToken,
      processing_fence: fence.processingFence
    }
  );
  if (resetError) throw resetError;
  const outputStage = await beginMatchOutputStage(supabase, job.id, fence);
  await updateJob(supabase, job.id, {
    status: "parsing",
    current_stage: "normalizing_mpn",
    progress_percent: 30,
    processed_rows: 0,
    result_count: 0,
    warning_count: 0
  }, fence);

  const metrics: OpportunityParseMetrics[] = [];
  let processedFiles = 0;
  for (const file of uploadedJobFiles(files)) {
    const role = file.side === "A" ? roleA : roleB;
    await requireNotCancelled(supabase, job.id);
    const { error: parsingStatusError } = await supabase
      .from("opportunity_finder_files")
      .update({ parse_status: "parsing" })
      .eq("id", file.id)
      .eq("job_id", job.id);
    if (parsingStatusError) throw parsingStatusError;
    const fileMetrics = await parseOpportunityWorkbook({
      filePath: localFiles.get(file.id)!,
      fileName: file.original_file_name,
      fileId: file.id,
      jobId: job.id,
      side: file.side,
      role,
      validityOverrideExpiresAt: file.validity_override_expires_at ?? null,
      onBatch: async (rows) => {
        await updateHeartbeat(supabase, job.id, fence);
        await insertCanonicalRows(supabase, rows, fence);
        await requireNotCancelled(supabase, job.id);
      },
      onRejected: async (rows) => {
        await updateHeartbeat(supabase, job.id, fence);
        await appendMatchOutputItems(
          supabase,
          outputStage,
          "rejected_rows",
          rows.map(rejectedRowInsert)
        );
        await requireNotCancelled(supabase, job.id);
      },
      shouldCancel: () => isCancelled(supabase, job.id)
    });
    metrics.push(fileMetrics);
    processedFiles += 1;
    const { error: parsedStatusError } = await supabase
      .from("opportunity_finder_files")
      .update({
        parse_status: "parsed",
        parsed_at: nowIso(),
        row_count: fileMetrics.totalRows,
        hidden_row_count: fileMetrics.hiddenRows
      })
      .eq("id", file.id)
      .eq("job_id", job.id);
    if (parsedStatusError) throw parsedStatusError;
    await updateJob(supabase, job.id, {
      processed_rows: metrics.reduce((sum, item) => sum + item.totalRows, 0),
      current_stage: "grouping_quantities",
      progress_percent: processedFiles === 1 ? 55 : 72
    }, fence);
  }

  const existingEntityCount = await insertSingleFileSnapshotRows(supabase, job, files, fence);
  if (job.comparison_mode === "single_file") {
    await updateJob(supabase, job.id, {
      total_rows_b: existingEntityCount,
      processed_rows: metrics.reduce((sum, item) => sum + item.totalRows, 0) + existingEntityCount
    }, fence);
  }

  await requireNotCancelled(supabase, job.id);
  const { error: materializeError } = await supabase.rpc(
    "materialize_opportunity_finder_entities",
    {
      job_id: job.id,
      worker_id: fence.workerId,
      lock_token: fence.lockToken
    }
  );
  if (materializeError) throw materializeError;
  await updateJob(supabase, job.id, {
    status: "matching",
    current_stage: "finding_matches",
    progress_percent: 78
  }, fence);
  const missingMpnRows = metrics.reduce((sum, item) => sum + item.missingMpnRows, 0);
  const invalidQuantityRows = metrics.reduce((sum, item) => sum + item.invalidQuantityRows, 0);
  const rejectedRows = metrics.reduce((sum, item) => sum + item.rejectedRows, 0);
  const { count: eventRowCount, error: eventCountError } = await supabase
    .from("opportunity_finder_rows")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id)
    .eq("ingestion_lock_token", fence.lockToken)
    .eq("ingestion_fence", fence.processingFence)
    .eq("record_role", "demand")
    .not("demand_event_key", "is", null);
  if (eventCountError) throw eventCountError;
  const matcherInput = {
    supabase,
    jobId: job.id,
    files,
    roleA,
    roleB,
    supplyRole: compatibility.supplySide === "A" ? roleA : roleB,
    missingMpnRows,
    invalidQuantityRows,
    rejectedRows,
    outputStage,
    lockToken: fence.lockToken,
    workerId: fence.workerId,
    processingFence: fence.processingFence,
    customerContext: job.client_context ?? null,
    supplyRoles: job.comparison_mode === "single_file" && roleA === "demand"
      ? ["stock", "excess", "supplier_offer"] as OpportunitySelectedRole[]
      : undefined
  };
  const parseTimeMs = Math.round((performance.now() - parseStartedAt) * 10) / 10;
  const matchingStartedAt = performance.now();
  const output = (eventRowCount ?? 0) > 0
    ? await matchCanonicalRowsByEvent(matcherInput)
    : await matchCanonicalRowsIncrementally(matcherInput);
  await updateJob(supabase, job.id, {
    current_stage: "generating_opportunities",
    progress_percent: 90
  }, fence);
  const matchingTimeMs = Math.round((performance.now() - matchingStartedAt) * 10) / 10;
  const persistenceStartedAt = performance.now();
  await commitMatchOutputStage(supabase, outputStage, output.summary, output.warningCount);
  const persistenceTimeMs = Math.round((performance.now() - persistenceStartedAt) * 10) / 10;
  const { error: performanceError } = await supabase.rpc("record_opportunity_finder_performance", {
    job_id: job.id,
    worker_id: fence.workerId,
    lock_token: fence.lockToken,
    processing_fence: fence.processingFence,
    metrics: {
      parseTimeMs,
      matchingTimeMs,
      assignmentTimeMs: persistenceTimeMs,
      persistenceTimeMs,
      totalWorkerTimeMs: Math.round((performance.now() - parseStartedAt) * 10) / 10
    }
  });
  if (performanceError) {
    await logger.warn({
      traceId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      route: "opportunity-finder-worker",
      method: "WORKER",
      module: "opportunity-finder",
      action: "performance_metrics_persist_failed",
      message: "Opportunity Finder completed, but performance metrics could not be persisted.",
      status: "failed",
      metadata: { jobId: job.id, errorCode: performanceError.code ?? "unknown" }
    });
  }
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
  const fence = jobFence(job);
  if (fence.workerId !== workerId) throw new Error("OPPORTUNITY_WORKER_FENCE_LOST");
  const logContext = {
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "opportunity-finder-worker",
    method: "WORKER",
    userId: job.created_by
  };
  const heartbeat = setInterval(() => {
    void updateHeartbeat(supabase, job.id, fence).catch(() => undefined);
  }, 15_000);
  let tempDirectory: string | null = null;
  try {
    const files = await loadJobFiles(supabase, job.id);
    const uploadedFiles = uploadedJobFiles(files);
    for (const file of uploadedFiles) {
      assertCanonicalOpportunityStorageReference({
        ownerId: job.created_by,
        jobId: job.id,
        fileId: file.id,
        originalFileName: file.original_file_name,
        storageBucket: file.storage_bucket,
        storagePath: file.storage_path
      });
    }
    const downloaded = await downloadJobFiles(supabase, uploadedFiles, job.id);
    tempDirectory = downloaded.tempDirectory;
    const localFiles = new Map(downloaded.downloaded.map((item) => [item.file.id, item.localPath]));
    const hashedFiles: Array<{ side: "A" | "B"; digest: string }> = [];
    for (const item of downloaded.downloaded) {
      await updateHeartbeat(supabase, job.id, fence);
      const hashed = await hashLocalFile(item.localPath);
      if (hashed.actualSizeBytes !== Number(item.file.size_bytes)) {
        await supabase
          .from("opportunity_finder_files")
          .update({
            actual_size_bytes: hashed.actualSizeBytes,
            validation_status: "size_mismatch"
          })
          .eq("id", item.file.id)
          .eq("job_id", job.id);
        throw new Error("OPPORTUNITY_FILE_SIZE_MISMATCH");
      }
      if (item.file.content_sha256 && item.file.content_sha256 !== hashed.contentSha256) {
        await supabase
          .from("opportunity_finder_files")
          .update({
            actual_size_bytes: hashed.actualSizeBytes,
            validation_status: "hash_mismatch"
          })
          .eq("id", item.file.id)
          .eq("job_id", job.id);
        throw new Error("OPPORTUNITY_FILE_HASH_MISMATCH");
      }
      const { error: hashError } = await supabase
        .from("opportunity_finder_files")
        .update({
          content_sha256: hashed.contentSha256,
          actual_size_bytes: hashed.actualSizeBytes,
          validation_status: "verified",
          sha256_verified_at: nowIso()
        })
        .eq("id", item.file.id)
        .eq("job_id", job.id);
      if (hashError) throw hashError;
      hashedFiles.push({ side: item.file.side, digest: hashed.contentSha256 });
    }
    const pairHash = createHash("sha256");
    pairHash.update(`pipeline:${OPPORTUNITY_FINDER_PIPELINE_VERSION}\n`, "utf8");
    for (const item of hashedFiles.sort((left, right) => left.side.localeCompare(right.side))) {
      pairHash.update(`${item.side}:${item.digest}\n`, "utf8");
    }
    await updateJob(
      supabase,
      job.id,
      { content_pair_sha256: pairHash.digest("hex") },
      fence
    );
    await logger.info({
      ...logContext,
      module: "opportunity-finder",
      action: "job_processing_started",
      message: "Opportunity Finder job processing started.",
      status: "started",
      metadata: { jobId: job.id, stage: job.current_stage, fileCount: uploadedFiles.length }
    });
    if (["inspecting_sheets", "detecting_headers"].includes(job.current_stage)) {
      await profileFiles(supabase, job, uploadedFiles, localFiles);
    } else if (job.comparison_mode === "single_file" && job.snapshot_status === "pending") {
      await discoverSingleFileCandidates(supabase, job, files, localFiles);
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
      lock_token: null,
      heartbeat_at: null
    }, fence);
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
