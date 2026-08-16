import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  OpportunityDatasetScope,
  OpportunitySelectedRole
} from "@/lib/opportunity-finder/types";
import { isAdmin } from "@/lib/auth/roles";
import type { UserRole } from "@/lib/types";

export const SINGLE_FILE_HISTORY_ROLES = new Set<OpportunitySelectedRole>([
  "received_history",
  "purchase_history",
  "quote_history",
  "sales_history"
]);

export type OpportunityDatasetManifestEntry = {
  uploadBatchId: string;
  ownerId: string;
  dataVersion: number;
};

export type OpportunityPlatformEntityRow = {
  upload_batch_id: string;
  owner_id: string;
  data_version: number;
  source_record_id: string;
  entity_kind: "demand" | "stock" | "excess" | "supplier_offer" | "historical";
  entity_key: string;
  normalized_mpn: string;
  display_mpn: string;
  customer_name: string | null;
  supplier_name: string | null;
  manufacturer_name: string | null;
  required_qty: number | null;
  available_qty: number | null;
  excess_qty: number | null;
  required_date: string | null;
  lead_time_weeks: number | null;
  moq: number | null;
  spq: number | null;
  date_code: string | null;
  coo: string | null;
  condition: string | null;
  expires_at: string | null;
  unit_of_measure: string | null;
  is_active_demand: boolean;
  is_live_supply: boolean;
  warnings: string[] | null;
};

const PAGE_SIZE = 1000;
const FILTER_CHUNK_SIZE = 150;

export function oppositeDatasetRole(role: OpportunitySelectedRole) {
  if (role === "demand") return "stock" as const;
  if (["stock", "excess", "supplier_offer"].includes(role) || SINGLE_FILE_HISTORY_ROLES.has(role)) {
    return "demand" as const;
  }
  return null;
}

export function datasetScopeForRole(role: UserRole): OpportunityDatasetScope {
  if (isAdmin(role)) return "company";
  if (role === "manager") return "team";
  return "own";
}

export function datasetVersionFromManifest(entries: OpportunityDatasetManifestEntry[]) {
  const canonical = [...entries]
    .sort((left, right) => left.uploadBatchId.localeCompare(right.uploadBatchId))
    .map((entry) => `${entry.uploadBatchId}:${entry.ownerId}:${entry.dataVersion}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function loadAuthorizedDatasetManifest(supabase: SupabaseClient) {
  const uploads: Array<{ id: string; uploaded_by: string }> = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("upload_batches")
      .select("id,uploaded_by")
      .is("archived_at", null)
      .in("status", ["completed", "completed_with_warnings"])
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as Array<{ id: string; uploaded_by: string }>;
    uploads.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const versions = new Map<string, { owner_id: string; data_version: number; summary_version: number | null; opportunity_entity_version: number | null; dirty: boolean }>();
  for (let index = 0; index < uploads.length; index += FILTER_CHUNK_SIZE) {
    const ids = uploads.slice(index, index + FILTER_CHUNK_SIZE).map((upload) => upload.id);
    const { data, error } = await supabase
      .from("business_upload_versions")
      .select("upload_batch_id,owner_id,data_version,summary_version,opportunity_entity_version,dirty")
      .in("upload_batch_id", ids);
    if (error) throw error;
    for (const row of data ?? []) {
      versions.set(String(row.upload_batch_id), {
        owner_id: String(row.owner_id),
        data_version: Number(row.data_version),
        summary_version: row.summary_version === null ? null : Number(row.summary_version),
        opportunity_entity_version: row.opportunity_entity_version === null ? null : Number(row.opportunity_entity_version),
        dirty: Boolean(row.dirty)
      });
    }
  }

  const notReady = uploads.filter((upload) => {
    const version = versions.get(upload.id);
    return !version || version.dirty || version.summary_version !== version.data_version
      || version.opportunity_entity_version !== version.data_version;
  });
  if (notReady.length) throw new Error("OPPORTUNITY_DATASET_SUMMARY_NOT_READY");
  return uploads.map((upload) => {
    const version = versions.get(upload.id)!;
    return {
      uploadBatchId: upload.id,
      ownerId: version.owner_id,
      dataVersion: version.data_version
    } satisfies OpportunityDatasetManifestEntry;
  });
}

export async function loadAuthorizedPlatformCandidates(input: {
  supabase: SupabaseClient;
  manifest: OpportunityDatasetManifestEntry[];
  normalizedMpns: string[];
}) {
  const rows: OpportunityPlatformEntityRow[] = [];
  const uniqueMpns = Array.from(new Set(input.normalizedMpns.filter(Boolean))).sort();
  const manifestsByVersion = new Map<number, OpportunityDatasetManifestEntry[]>();
  for (const entry of input.manifest) {
    manifestsByVersion.set(entry.dataVersion, [...(manifestsByVersion.get(entry.dataVersion) ?? []), entry]);
  }
  for (const [dataVersion, entries] of manifestsByVersion) {
    for (let uploadIndex = 0; uploadIndex < entries.length; uploadIndex += FILTER_CHUNK_SIZE) {
      const uploadIds = entries.slice(uploadIndex, uploadIndex + FILTER_CHUNK_SIZE).map((entry) => entry.uploadBatchId);
      for (let mpnIndex = 0; mpnIndex < uniqueMpns.length; mpnIndex += FILTER_CHUNK_SIZE) {
        const mpns = uniqueMpns.slice(mpnIndex, mpnIndex + FILTER_CHUNK_SIZE);
        let from = 0;
        while (true) {
          const { data, error } = await input.supabase
            .from("business_opportunity_entities")
            .select("upload_batch_id,owner_id,data_version,source_record_id,entity_kind,entity_key,normalized_mpn,display_mpn,customer_name,supplier_name,manufacturer_name,required_qty,available_qty,excess_qty,required_date,lead_time_weeks,unit_of_measure,moq,spq,date_code,coo,condition,expires_at,is_active_demand,is_live_supply,warnings")
            .eq("data_version", dataVersion)
            .in("upload_batch_id", uploadIds)
            .in("normalized_mpn", mpns)
            .order("upload_batch_id", { ascending: true })
            .order("normalized_mpn", { ascending: true })
            .order("source_record_id", { ascending: true })
            .order("entity_kind", { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
          if (error) throw error;
          const page = (data ?? []) as unknown as OpportunityPlatformEntityRow[];
          rows.push(...page);
          if (page.length < PAGE_SIZE) break;
          from += page.length;
        }
      }
    }
  }
  return rows;
}

export type OpportunitySnapshotCandidateRow = {
  role: "demand" | "stock" | "excess" | "supplier_offer";
  source_key: string;
  source_upload_id: string;
  source_data_version: number;
  normalized_mpn: string;
  display_mpn: string;
  manufacturer: string | null;
  customer_context: string | null;
  supplier_context: string | null;
  required_qty: number | null;
  available_qty: number | null;
  excess_qty: number | null;
  required_date: string | null;
  unit_of_measure: string | null;
  lead_time_weeks: number | null;
  moq: number | null;
  spq: number | null;
  date_code: string | null;
  coo: string | null;
  condition: string | null;
  expires_at: string | null;
  is_active_demand: boolean;
  is_live_supply: boolean;
  quality_flags: string[];
};

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeRequiredDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? value.slice(0, 10) : null;
}

function snapshotSourceKey(row: OpportunityPlatformEntityRow, role: string) {
  return createHash("sha256").update([
    row.upload_batch_id,
    String(row.data_version),
    row.entity_key,
    role
  ].join("\u001f"), "utf8").digest("hex");
}

export function buildPlatformSnapshotRows(input: {
  uploadedRole: OpportunitySelectedRole;
  candidates: OpportunityPlatformEntityRow[];
  now?: Date;
}) {
  const rows: OpportunitySnapshotCandidateRow[] = [];
  const demandUpload = input.uploadedRole === "demand";
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  for (const candidate of input.candidates) {
    const base = {
      source_upload_id: candidate.upload_batch_id,
      source_data_version: candidate.data_version,
      normalized_mpn: candidate.normalized_mpn,
      display_mpn: candidate.display_mpn || candidate.normalized_mpn,
      manufacturer: candidate.manufacturer_name,
      customer_context: candidate.customer_name,
      supplier_context: candidate.supplier_name,
      required_date: safeRequiredDate(candidate.required_date),
      unit_of_measure: candidate.unit_of_measure,
      lead_time_weeks: positiveNumber(candidate.lead_time_weeks),
      moq: positiveNumber(candidate.moq),
      spq: positiveNumber(candidate.spq),
      date_code: candidate.date_code,
      coo: candidate.coo,
      condition: candidate.condition,
      expires_at: candidate.expires_at,
      quality_flags: [...(candidate.warnings ?? [])]
    };
    if (demandUpload) {
      const supplyQty = positiveNumber(candidate.entity_kind === "excess" ? candidate.excess_qty : candidate.available_qty);
      const liveOffer = candidate.entity_kind !== "supplier_offer"
        || Boolean(candidate.expires_at && new Date(candidate.expires_at).getTime() > (input.now ?? new Date()).getTime());
      if (["stock", "excess", "supplier_offer"].includes(candidate.entity_kind) && supplyQty !== null && candidate.is_live_supply && liveOffer) rows.push({
        ...base,
        role: candidate.entity_kind as "stock" | "excess" | "supplier_offer",
        source_key: snapshotSourceKey(candidate, candidate.entity_kind),
        required_qty: null,
        available_qty: supplyQty,
        excess_qty: candidate.entity_kind === "excess" ? supplyQty : null,
        is_active_demand: true,
        is_live_supply: true
      });
      continue;
    }
    const demandQty = positiveNumber(candidate.required_qty);
    if (candidate.entity_kind !== "demand" || demandQty === null) continue;
    const activeDate = base.required_date;
    rows.push({
      ...base,
      role: "demand",
      source_key: snapshotSourceKey(candidate, "demand"),
      required_qty: demandQty,
      available_qty: null,
      excess_qty: null,
      is_active_demand: candidate.is_active_demand && activeDate !== null && activeDate >= today,
      is_live_supply: true,
      quality_flags: activeDate
        ? base.quality_flags
        : Array.from(new Set([...base.quality_flags, "ambiguous_date"]))
    });
  }
  return rows;
}
