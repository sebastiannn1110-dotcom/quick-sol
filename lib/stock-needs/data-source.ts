import type { SupabaseClient } from "@supabase/supabase-js";
import { BUSINESS_RECORD_UPLOAD_RELATION } from "@/lib/platform/query-columns";
import type { StockNeedsFilters, StockNeedsImportJob, StockNeedsProfile, StockNeedsRecord } from "@/lib/stock-needs/stock-needs";

const BUSINESS_RECORD_SELECT: string = `id,upload_batch_id,category,raw_data,normalized_data,has_errors,errors,mpn,mpn_quoted,customer,client,supplier,supplier_name,manufacturer,clean_mfg,qty,req_qty,on_hand,earliest_shipping_date,lead_time_weeks,${BUSINESS_RECORD_UPLOAD_RELATION}(original_file_name,detected_category,status,created_at)`;
const AI_SAFE_BUSINESS_RECORD_SELECT: string = `upload_batch_id,category,has_errors,mpn,mpn_quoted,customer,client,supplier,supplier_name,manufacturer,clean_mfg,qty,req_qty,on_hand,earliest_shipping_date,lead_time_weeks,${BUSINESS_RECORD_UPLOAD_RELATION}(detected_category,status,created_at)`;
const PROFILE_SELECT = "upload_batch_id,detected_template,detected_mappings_json,column_count";
const JOB_SELECT = "upload_batch_id,status";

export type LoadStockNeedsInputOptions = {
  filters?: Pick<StockNeedsFilters, "uploadBatchId">;
  uploadIds?: string[];
  ownerId?: string | null;
  maxUploads?: number;
  recordsPerUploadLimit?: number;
  /**
   * Internal assistant reads opt out so raw spreadsheet cells never enter the
   * process. Existing operational callers keep the richer shape by default.
   */
  includeRawData?: boolean;
  /**
   * Uses one bounded records query across the visible uploads. This avoids the
   * former query-per-upload pattern for assistant summaries.
   */
  singleQueryLimit?: number | null;
  mpn?: string | null;
  /** Exact fallback/reconciliation mode: page through every authorized row. */
  complete?: boolean;
};

export type LoadedStockNeedsInput = {
  records: StockNeedsRecord[];
  profiles: StockNeedsProfile[];
  importJobs: StockNeedsImportJob[];
  uploadIds: string[];
};

type UploadIdRow = {
  id?: string | null;
};

const POSTGREST_PAGE_SIZE = 1000;
const UPLOAD_FILTER_CHUNK_SIZE = 100;

function uniqueValues(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

type NormalizedLoadOptions = {
  filters: Pick<StockNeedsFilters, "uploadBatchId">;
  uploadIds: string[] | null;
  ownerId: string | null;
  maxUploads: number;
  recordsPerUploadLimit: number;
  includeRawData: boolean;
  singleQueryLimit: number | null;
  mpn: string | null;
  complete: boolean;
};

async function loadVisibleUploadIds(supabase: SupabaseClient, options: NormalizedLoadOptions) {
  if (options.uploadIds !== null && !options.uploadIds.length) return [];

  let query = supabase
    .from("upload_batches")
    .select("id")
    .neq("status", "archived")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (options.filters.uploadBatchId) query = query.eq("id", options.filters.uploadBatchId);
  if (options.uploadIds !== null) query = query.in("id", options.uploadIds);
  if (options.ownerId) query = query.eq("uploaded_by", options.ownerId);

  if (!options.complete) {
    const { data, error } = await query.limit(options.maxUploads);
    if (error) throw error;
    return uniqueValues(((data ?? []) as UploadIdRow[]).map((row) => row.id));
  }
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query.range(from, from + 999);
    if (error) throw error;
    const page = uniqueValues(((data ?? []) as UploadIdRow[]).map((row) => row.id));
    ids.push(...page);
    if (page.length < 1000) break;
  }
  return uniqueValues(ids);
}

async function loadRecordsForUpload(supabase: SupabaseClient, uploadId: string, options: NormalizedLoadOptions) {
  let query = supabase
    .from("business_records")
    .select(options.includeRawData ? BUSINESS_RECORD_SELECT : AI_SAFE_BUSINESS_RECORD_SELECT)
    .is("archived_at", null)
    .eq("upload_batch_id", uploadId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (options.ownerId) query = query.eq("uploaded_by", options.ownerId);
  if (options.mpn) query = query.or(`mpn.eq.${options.mpn},mpn_quoted.eq.${options.mpn}`);

  if (!options.complete) {
    const { data, error } = await query.limit(options.recordsPerUploadLimit);
    if (error) throw error;
    return (data ?? []) as unknown as StockNeedsRecord[];
  }
  const rows: StockNeedsRecord[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query.range(from, from + 999);
    if (error) throw error;
    const page = (data ?? []) as unknown as StockNeedsRecord[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function compareCompleteRows(
  left: StockNeedsRecord,
  right: StockNeedsRecord,
  uploadRank: Map<string, number>
) {
  const uploadOrder = (uploadRank.get(left.upload_batch_id) ?? Number.MAX_SAFE_INTEGER)
    - (uploadRank.get(right.upload_batch_id) ?? Number.MAX_SAFE_INTEGER);
  if (uploadOrder) return uploadOrder;
  const leftSource = left as unknown as { created_at?: string | null; id?: string | null };
  const rightSource = right as unknown as { created_at?: string | null; id?: string | null };
  const dateOrder = String(rightSource.created_at ?? "").localeCompare(String(leftSource.created_at ?? ""));
  if (dateOrder) return dateOrder;
  return String(rightSource.id ?? "").localeCompare(String(leftSource.id ?? ""));
}

/**
 * Exact compatibility path used while summaries are dirty or the additive RPC
 * migration is pending. It pages by bounded upload-id chunks, not by issuing a
 * separate HTTP query for every upload, and restores the legacy deterministic
 * upload/record ordering before running the canonical calculations.
 */
async function loadCompleteRecords(
  supabase: SupabaseClient,
  uploadIds: string[],
  options: NormalizedLoadOptions
) {
  const rows: StockNeedsRecord[] = [];
  for (let chunkStart = 0; chunkStart < uploadIds.length; chunkStart += UPLOAD_FILTER_CHUNK_SIZE) {
    const uploadChunk = uploadIds.slice(chunkStart, chunkStart + UPLOAD_FILTER_CHUNK_SIZE);
    for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
      let query = supabase
        .from("business_records")
        .select(options.includeRawData ? BUSINESS_RECORD_SELECT : AI_SAFE_BUSINESS_RECORD_SELECT)
        .is("archived_at", null)
        .in("upload_batch_id", uploadChunk)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      if (options.ownerId) query = query.eq("uploaded_by", options.ownerId);
      if (options.mpn) query = query.or(`mpn.eq.${options.mpn},mpn_quoted.eq.${options.mpn}`);
      const { data, error } = await query.range(from, from + POSTGREST_PAGE_SIZE - 1);
      if (error) throw error;
      const page = (data ?? []) as unknown as StockNeedsRecord[];
      rows.push(...page);
      if (page.length < POSTGREST_PAGE_SIZE) break;
    }
  }
  const uploadRank = new Map(uploadIds.map((uploadId, index) => [uploadId, index]));
  return rows.sort((left, right) => compareCompleteRows(left, right, uploadRank));
}

async function loadProfilesInChunks(supabase: SupabaseClient, uploadIds: string[]) {
  const rows: StockNeedsProfile[] = [];
  for (let index = 0; index < uploadIds.length; index += UPLOAD_FILTER_CHUNK_SIZE) {
    const result = await supabase
      .from("file_schema_profiles")
      .select(PROFILE_SELECT)
      .in("upload_batch_id", uploadIds.slice(index, index + UPLOAD_FILTER_CHUNK_SIZE));
    if (result.error) return [];
    rows.push(...(result.data ?? []) as StockNeedsProfile[]);
  }
  return rows;
}

async function loadJobsInChunks(supabase: SupabaseClient, uploadIds: string[]) {
  const rows: StockNeedsImportJob[] = [];
  for (let index = 0; index < uploadIds.length; index += UPLOAD_FILTER_CHUNK_SIZE) {
    const result = await supabase
      .from("import_jobs")
      .select(JOB_SELECT)
      .in("upload_batch_id", uploadIds.slice(index, index + UPLOAD_FILTER_CHUNK_SIZE))
      .order("updated_at", { ascending: false });
    if (result.error) return [];
    rows.push(...(result.data ?? []) as StockNeedsImportJob[]);
  }
  return rows;
}

async function loadRecordsInOneQuery(
  supabase: SupabaseClient,
  uploadIds: string[],
  options: NormalizedLoadOptions
) {
  let query = supabase
    .from("business_records")
    .select(options.includeRawData ? BUSINESS_RECORD_SELECT : AI_SAFE_BUSINESS_RECORD_SELECT)
    .is("archived_at", null)
    .in("upload_batch_id", uploadIds)
    .order("created_at", { ascending: false })
    .limit(options.singleQueryLimit ?? options.recordsPerUploadLimit);
  if (options.ownerId) query = query.eq("uploaded_by", options.ownerId);
  if (options.mpn) query = query.or(`mpn.eq.${options.mpn},mpn_quoted.eq.${options.mpn}`);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as StockNeedsRecord[];
}

export async function loadStockNeedsInput(
  supabase: SupabaseClient,
  options: LoadStockNeedsInputOptions = {}
): Promise<LoadedStockNeedsInput> {
  const safeOptions: NormalizedLoadOptions = {
    filters: options.filters ?? {},
    uploadIds: options.uploadIds === undefined ? null : uniqueValues(options.uploadIds),
    ownerId: options.ownerId ?? null,
    maxUploads: Math.min(Math.max(Number(options.maxUploads ?? 20) || 20, 1), 50),
    recordsPerUploadLimit: Math.min(Math.max(Number(options.recordsPerUploadLimit ?? 5000) || 5000, 100), 10000),
    includeRawData: options.includeRawData !== false,
    singleQueryLimit: options.singleQueryLimit == null
      ? null
      : Math.min(Math.max(Number(options.singleQueryLimit) || 1000, 100), 5000),
    mpn: options.mpn?.trim().replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 80) || null,
    complete: options.complete === true,
  };

  const uploadIds = await loadVisibleUploadIds(supabase, safeOptions);
  if (!uploadIds.length) {
    return { records: [], profiles: [], importJobs: [], uploadIds: [] };
  }

  const [recordsByUpload, profiles, importJobs] = await Promise.all([
    safeOptions.complete
      ? loadCompleteRecords(supabase, uploadIds, safeOptions).then((records) => [records])
      : safeOptions.singleQueryLimit
        ? loadRecordsInOneQuery(supabase, uploadIds, safeOptions).then((records) => [records])
        : Promise.all(uploadIds.map((uploadId) => loadRecordsForUpload(supabase, uploadId, safeOptions))),
    loadProfilesInChunks(supabase, uploadIds),
    loadJobsInChunks(supabase, uploadIds)
  ]);

  return {
    records: recordsByUpload.flat(),
    profiles,
    importJobs,
    uploadIds
  };
}
