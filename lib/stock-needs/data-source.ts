import type { SupabaseClient } from "@supabase/supabase-js";
import type { StockNeedsFilters, StockNeedsImportJob, StockNeedsProfile, StockNeedsRecord } from "@/lib/stock-needs/stock-needs";

const BUSINESS_RECORD_SELECT: string = "id,upload_batch_id,category,raw_data,normalized_data,has_errors,errors,mpn,mpn_quoted,customer,client,supplier,supplier_name,manufacturer,clean_mfg,qty,req_qty,on_hand,earliest_shipping_date,lead_time_weeks,upload_batches(original_file_name,detected_category,status,created_at)";
const AI_SAFE_BUSINESS_RECORD_SELECT: string = "upload_batch_id,category,has_errors,mpn,mpn_quoted,customer,client,supplier,supplier_name,manufacturer,clean_mfg,qty,req_qty,on_hand,earliest_shipping_date,lead_time_weeks,upload_batches(detected_category,status,created_at)";
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
};

async function loadVisibleUploadIds(supabase: SupabaseClient, options: NormalizedLoadOptions) {
  if (options.uploadIds !== null && !options.uploadIds.length) return [];

  let query = supabase
    .from("upload_batches")
    .select("id")
    .neq("status", "archived")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(options.maxUploads);

  if (options.filters.uploadBatchId) query = query.eq("id", options.filters.uploadBatchId);
  if (options.uploadIds !== null) query = query.in("id", options.uploadIds);
  if (options.ownerId) query = query.eq("uploaded_by", options.ownerId);

  const { data, error } = await query;
  if (error) throw error;

  return uniqueValues(((data ?? []) as UploadIdRow[]).map((row) => row.id));
}

async function loadRecordsForUpload(supabase: SupabaseClient, uploadId: string, options: NormalizedLoadOptions) {
  let query = supabase
    .from("business_records")
    .select(options.includeRawData ? BUSINESS_RECORD_SELECT : AI_SAFE_BUSINESS_RECORD_SELECT)
    .is("archived_at", null)
    .eq("upload_batch_id", uploadId)
    .order("created_at", { ascending: false })
    .limit(options.recordsPerUploadLimit);

  if (options.ownerId) query = query.eq("uploaded_by", options.ownerId);
  if (options.mpn) query = query.or(`mpn.eq.${options.mpn},mpn_quoted.eq.${options.mpn}`);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as StockNeedsRecord[];
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
    uploadIds: options.uploadIds === undefined ? null : uniqueValues(options.uploadIds).slice(0, 100),
    ownerId: options.ownerId ?? null,
    maxUploads: Math.min(Math.max(Number(options.maxUploads ?? 20) || 20, 1), 50),
    recordsPerUploadLimit: Math.min(Math.max(Number(options.recordsPerUploadLimit ?? 5000) || 5000, 100), 10000),
    includeRawData: options.includeRawData !== false,
    singleQueryLimit: options.singleQueryLimit == null
      ? null
      : Math.min(Math.max(Number(options.singleQueryLimit) || 1000, 100), 5000),
    mpn: options.mpn?.trim().replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 80) || null
  };

  const uploadIds = await loadVisibleUploadIds(supabase, safeOptions);
  if (!uploadIds.length) {
    return { records: [], profiles: [], importJobs: [], uploadIds: [] };
  }

  const [recordsByUpload, profilesResult, jobsResult] = await Promise.all([
    safeOptions.singleQueryLimit
      ? loadRecordsInOneQuery(supabase, uploadIds, safeOptions).then((records) => [records])
      : Promise.all(uploadIds.map((uploadId) => loadRecordsForUpload(supabase, uploadId, safeOptions))),
    supabase.from("file_schema_profiles").select(PROFILE_SELECT).in("upload_batch_id", uploadIds),
    supabase.from("import_jobs").select(JOB_SELECT).in("upload_batch_id", uploadIds).order("updated_at", { ascending: false })
  ]);

  return {
    records: recordsByUpload.flat(),
    profiles: profilesResult.error ? [] : (profilesResult.data ?? []) as StockNeedsProfile[],
    importJobs: jobsResult.error ? [] : (jobsResult.data ?? []) as StockNeedsImportJob[],
    uploadIds
  };
}
