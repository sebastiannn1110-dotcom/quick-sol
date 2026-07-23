import type { SupabaseClient } from "@supabase/supabase-js";
import type { MpnOffer } from "@/lib/mpn/recommendation";
import { normalizePartNumberForMatch } from "@/lib/stock-needs/stock-needs";

export const MPN_COMPARATOR_LIMIT = 120;
export const MPN_SUGGESTION_MIN_LENGTH = 3;
export const MPN_SUGGESTION_LIMIT = 12;
export const MPN_SUGGESTION_QUERY_LIMIT = 20;

export const MPN_COMPARATOR_SELECT = [
  "id",
  "upload_batch_id",
  "uploaded_by",
  "category",
  "customer",
  "client",
  "supplier",
  "supplier_name",
  "mpn",
  "mpn_quoted",
  "manufacturer",
  "description",
  "price",
  "cost",
  "qty",
  "on_hand",
  "moq",
  "spq",
  "lead_time_weeks",
  "transit_time_weeks",
  "shipping_point_country",
  "earliest_shipping_date",
  "gp",
  "gp_rate",
  "commission",
  "has_errors",
  "created_at",
  "profiles(full_name,department,region,role)",
  "upload_batches(id,original_file_name,detected_category,status,created_at)"
].join(",");

const MPN_SUGGESTION_SELECT = "mpn,mpn_quoted";

export type MpnLookupStage = "mpn_exact" | "mpn_quoted_exact" | "mpn_suggest";

export class MpnLookupError extends Error {
  stage: MpnLookupStage;
  originalError: unknown;
  isTimeout: boolean;

  constructor(stage: MpnLookupStage, originalError: unknown) {
    super("MPN lookup failed.");
    this.name = "MpnLookupError";
    this.stage = stage;
    this.originalError = originalError;
    this.isTimeout = isStatementTimeout(originalError);
  }
}

export function isStatementTimeout(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = [record.code, record.message, record.details, record.hint, String(error ?? "")].filter(Boolean).join(" ");
  return /57014|statement timeout|canceling statement due to statement timeout/i.test(message);
}

function groupedDigits(value: string, separator: "," | ".") {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

export function mpnLookupCandidates(input: string) {
  const raw = input.replace(/\u0000/g, "").trim().slice(0, 120);
  const normalized = normalizePartNumberForMatch(raw);
  const candidates = new Set<string>();
  if (raw) candidates.add(raw);
  if (normalized) candidates.add(normalized);
  if (normalized && /^[0-9]{4,}$/.test(normalized)) {
    candidates.add(groupedDigits(normalized, ","));
    candidates.add(groupedDigits(normalized, "."));
  }
  return Array.from(candidates).filter((value) => value.length <= 120).slice(0, 8);
}

export function normalizedMpnDisplay(input: string) {
  return normalizePartNumberForMatch(input) ?? input.replace(/\u0000/g, "").trim().slice(0, 120);
}

function nextTextPrefix(prefix: string) {
  if (!prefix) return "";
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xffff) return "";
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

function uniqueById<T extends { id?: string | null }>(rows: T[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = row.id ?? "";
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function sortByNewest<T extends { created_at?: string | null }>(rows: T[]) {
  return rows.sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
}

async function queryExactColumn(
  supabase: SupabaseClient,
  column: "mpn" | "mpn_quoted",
  candidates: string[],
  limit: number,
  stage: MpnLookupStage
) {
  const { data, error } = await supabase
    .from("business_records")
    .select(MPN_COMPARATOR_SELECT)
    .is("archived_at", null)
    .in(column, candidates)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new MpnLookupError(stage, error);
  return (data ?? []) as unknown as Array<MpnOffer & { upload_batches?: { original_file_name?: string | null; created_at?: string | null } | null }>;
}

export async function loadMpnComparatorOffers(supabase: SupabaseClient, mpnInput: string, limit = MPN_COMPARATOR_LIMIT) {
  const candidates = mpnLookupCandidates(mpnInput);
  if (!candidates.length) return [];

  const primary = await queryExactColumn(supabase, "mpn", candidates, limit, "mpn_exact");
  if (primary.length > 0) return sortByNewest(uniqueById(primary)).slice(0, limit);

  const quoted = await queryExactColumn(supabase, "mpn_quoted", candidates, Math.min(limit, 50), "mpn_quoted_exact");
  return sortByNewest(uniqueById(quoted)).slice(0, limit);
}

export async function loadMpnSuggestions(supabase: SupabaseClient, input: string) {
  const q = normalizedMpnDisplay(input);
  if (q.length < MPN_SUGGESTION_MIN_LENGTH) return [];
  const upperBound = nextTextPrefix(q);
  if (!upperBound) return [];

  const { data, error } = await supabase
    .from("business_records")
    .select(MPN_SUGGESTION_SELECT)
    .is("archived_at", null)
    .gte("mpn", q)
    .lt("mpn", upperBound)
    .order("mpn", { ascending: true })
    .limit(MPN_SUGGESTION_QUERY_LIMIT);

  if (error) throw new MpnLookupError("mpn_suggest", error);

  const seen = new Set<string>();
  return (data ?? [])
    .flatMap((record) => [record.mpn, record.mpn_quoted])
    .filter(Boolean)
    .map((mpn) => normalizedMpnDisplay(String(mpn)))
    .filter((mpn) => {
      if (!mpn || seen.has(mpn)) return false;
      seen.add(mpn);
      return true;
    })
    .slice(0, MPN_SUGGESTION_LIMIT);
}
