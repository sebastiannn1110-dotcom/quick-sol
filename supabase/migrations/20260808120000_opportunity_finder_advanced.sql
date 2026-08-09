-- Opportunity Finder advanced data model, tenant isolation and fenced commits.
-- Incremental migration: apply after 20260729120000_opportunity_finder_match_indicators.sql.
-- This file is declarative only. It is NOT executed by the application and was NOT
-- applied to any local or remote Supabase project as part of this change.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenant boundary
-- ---------------------------------------------------------------------------

create table public.opportunity_finder_tenants (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(trim(display_name)) between 1 and 160),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.opportunity_finder_tenant_memberships (
  tenant_id uuid not null references public.opportunity_finder_tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  membership_role text not null default 'member'
    check (membership_role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

comment on table public.opportunity_finder_tenants is
  'Security boundary for Opportunity Finder data. Existing users receive a personal tenant during this migration.';
comment on table public.opportunity_finder_tenant_memberships is
  'Tenant membership is managed by the trusted server/service role; clients cannot add themselves to tenants.';

insert into public.opportunity_finder_tenants (id, display_name, created_by)
select profile.id, left(coalesce(nullif(trim(profile.full_name), ''), 'Personal workspace'), 160), profile.id
from public.profiles profile
on conflict (id) do nothing;

insert into public.opportunity_finder_tenant_memberships (tenant_id, user_id, membership_role)
select profile.id, profile.id, 'owner'
from public.profiles profile
on conflict (tenant_id, user_id) do nothing;

create or replace function public.ensure_opportunity_finder_personal_tenant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.opportunity_finder_tenants (id, display_name, created_by)
  values (
    new.id,
    left(coalesce(nullif(trim(new.full_name), ''), 'Personal workspace'), 160),
    new.id
  )
  on conflict (id) do nothing;

  insert into public.opportunity_finder_tenant_memberships (
    tenant_id,
    user_id,
    membership_role
  )
  values (new.id, new.id, 'owner')
  on conflict (tenant_id, user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists profiles_ensure_opportunity_finder_tenant on public.profiles;
create trigger profiles_ensure_opportunity_finder_tenant
after insert on public.profiles
for each row execute function public.ensure_opportunity_finder_personal_tenant();

create or replace function public.is_opportunity_finder_tenant_member(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.opportunity_finder_tenant_memberships membership
    join public.profiles profile on profile.id = membership.user_id
    where membership.tenant_id = target_tenant_id
      and membership.user_id = auth.uid()
      and profile.is_active = true
  );
$$;

create or replace function public.is_opportunity_finder_tenant_admin(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.opportunity_finder_tenant_memberships membership
    join public.profiles profile on profile.id = membership.user_id
    where membership.tenant_id = target_tenant_id
      and membership.user_id = auth.uid()
      and membership.membership_role in ('owner', 'admin')
      and profile.role = 'admin'
      and profile.is_active = true
  );
$$;

revoke all on function public.ensure_opportunity_finder_personal_tenant() from public;
revoke all on function public.is_opportunity_finder_tenant_member(uuid) from public;
revoke all on function public.is_opportunity_finder_tenant_admin(uuid) from public;
grant execute on function public.is_opportunity_finder_tenant_member(uuid) to authenticated;
grant execute on function public.is_opportunity_finder_tenant_admin(uuid) to authenticated;
grant execute on function public.is_opportunity_finder_tenant_member(uuid) to service_role;
grant execute on function public.is_opportunity_finder_tenant_admin(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Evolve legacy job/file/row/result tables without replacing them.
-- ---------------------------------------------------------------------------

alter table public.opportunity_finder_jobs
  add column if not exists tenant_id uuid,
  add column if not exists client_context text,
  add column if not exists content_pair_sha256 text,
  add column if not exists pipeline_version text,
  add column if not exists processing_fence bigint not null default 0,
  add column if not exists lock_token uuid,
  add column if not exists materialized_lock_token uuid,
  add column if not exists materialized_at timestamptz,
  add column if not exists output_commit_key text,
  add column if not exists committed_fence bigint,
  add column if not exists committed_lock_token uuid;

update public.opportunity_finder_jobs
set tenant_id = created_by
where tenant_id is null;

update public.opportunity_finder_jobs
set pipeline_version = coalesce(
  (regexp_match(idempotency_key, '^opportunity-finder:v([^:]+):[0-9a-f]{64}$'))[1],
  '2'
)
where pipeline_version is null;

alter table public.opportunity_finder_jobs
  alter column tenant_id set default auth.uid(),
  alter column tenant_id set not null,
  alter column pipeline_version set default '4',
  alter column pipeline_version set not null,
  drop constraint if exists opportunity_finder_jobs_tenant_fk,
  add constraint opportunity_finder_jobs_tenant_fk
    foreign key (tenant_id) references public.opportunity_finder_tenants(id) on delete restrict,
  drop constraint if exists opportunity_finder_jobs_client_context_length_check,
  add constraint opportunity_finder_jobs_client_context_length_check
    check (client_context is null or length(client_context) <= 500),
  drop constraint if exists opportunity_finder_jobs_content_pair_sha256_check,
  add constraint opportunity_finder_jobs_content_pair_sha256_check
    check (content_pair_sha256 is null or content_pair_sha256 ~ '^[0-9a-f]{64}$'),
  drop constraint if exists opportunity_finder_jobs_processing_fence_check,
  add constraint opportunity_finder_jobs_processing_fence_check
    check (processing_fence >= 0),
  drop constraint if exists opportunity_finder_jobs_commit_key_length_check,
  add constraint opportunity_finder_jobs_commit_key_length_check
    check (output_commit_key is null or length(output_commit_key) between 16 and 240),
  drop constraint if exists opportunity_finder_jobs_id_tenant_key,
  add constraint opportunity_finder_jobs_id_tenant_key unique (id, tenant_id);

comment on column public.opportunity_finder_jobs.tenant_id is
  'Mandatory tenant boundary. RLS additionally requires created_by = auth.uid(), preserving owner isolation.';
comment on column public.opportunity_finder_jobs.client_context is
  'Optional client/account context supplied for this comparison; never used as an authorization key.';
comment on column public.opportunity_finder_jobs.content_pair_sha256 is
  'Order-stable digest of the two verified file hashes plus pipeline version. It is scoped by tenant+owner and is never disclosed across tenants.';
comment on column public.opportunity_finder_jobs.processing_fence is
  'Monotonic claim generation. A stale worker cannot commit after another worker has reclaimed the job.';
comment on column public.opportunity_finder_jobs.lock_token is
  'Random token minted at claim time and required by service-only materialize/allocate/replace RPCs.';
comment on column public.opportunity_finder_jobs.pipeline_version is
  'Explicit parser/matcher/export contract version. Legacy rows are backfilled as v2; new jobs default to v3.';

drop index if exists public.opportunity_finder_jobs_owner_idempotency_uidx;
create unique index opportunity_finder_jobs_tenant_owner_idempotency_uidx
  on public.opportunity_finder_jobs (tenant_id, created_by, idempotency_key)
  where idempotency_key is not null;
create index opportunity_finder_jobs_tenant_owner_created_idx
  on public.opportunity_finder_jobs (tenant_id, created_by, created_at desc);

alter table public.opportunity_finder_files
  drop constraint if exists opportunity_finder_files_detected_type_check,
  drop constraint if exists opportunity_finder_files_selected_role_check;

alter table public.opportunity_finder_files
  add constraint opportunity_finder_files_detected_type_check
    check (detected_type in (
      'demand', 'stock', 'excess', 'supplier_offer', 'received_history',
      'purchase_history', 'quote_history', 'sales_history', 'financial', 'unknown'
    )),
  add constraint opportunity_finder_files_selected_role_check
    check (selected_role is null or selected_role in (
      'demand', 'stock', 'excess', 'supplier_offer', 'received_history',
      'purchase_history', 'quote_history', 'sales_history', 'ignore'
    ));

alter table public.opportunity_finder_files
  add column if not exists tenant_id uuid,
  add column if not exists content_sha256 text,
  add column if not exists actual_size_bytes bigint,
  add column if not exists sha256_verified_at timestamptz,
  add column if not exists validation_status text not null default 'pending',
  add column if not exists template_type text,
  add column if not exists mapping_version text,
  add column if not exists classification_confidence text,
  add column if not exists useful_row_count integer not null default 0,
  add column if not exists hidden_row_count integer not null default 0,
  add column if not exists column_mappings jsonb not null default '[]'::jsonb,
  add column if not exists profile_warnings jsonb not null default '[]'::jsonb,
  add column if not exists profile_errors jsonb not null default '[]'::jsonb,
  add column if not exists profile_json jsonb not null default '{}'::jsonb,
  add column if not exists validity_override_expires_at timestamptz,
  add column if not exists storage_deletion_token uuid,
  add column if not exists storage_deletion_started_at timestamptz;

update public.opportunity_finder_files file
set tenant_id = job.tenant_id
from public.opportunity_finder_jobs job
where job.id = file.job_id
  and file.tenant_id is null;

alter table public.opportunity_finder_files
  alter column tenant_id set not null,
  drop constraint if exists opportunity_finder_files_job_tenant_fk,
  add constraint opportunity_finder_files_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  drop constraint if exists opportunity_finder_files_sha256_check,
  add constraint opportunity_finder_files_sha256_check
    check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  drop constraint if exists opportunity_finder_files_actual_size_check,
  add constraint opportunity_finder_files_actual_size_check
    check (actual_size_bytes is null or actual_size_bytes > 0),
  drop constraint if exists opportunity_finder_files_validation_status_check,
  add constraint opportunity_finder_files_validation_status_check
    check (validation_status in (
      'pending', 'verified', 'size_mismatch', 'hash_mismatch', 'invalid_signature', 'rejected'
    )),
  drop constraint if exists opportunity_finder_files_classification_confidence_check,
  add constraint opportunity_finder_files_classification_confidence_check
    check (classification_confidence is null or classification_confidence in ('high', 'medium', 'low', 'review')),
  drop constraint if exists opportunity_finder_files_profile_counts_check,
  add constraint opportunity_finder_files_profile_counts_check
    check (useful_row_count >= 0 and hidden_row_count >= 0),
  drop constraint if exists opportunity_finder_files_storage_deletion_claim_check,
  add constraint opportunity_finder_files_storage_deletion_claim_check
    check (
      (storage_deletion_token is null and storage_deletion_started_at is null)
      or (storage_deletion_token is not null and storage_deletion_started_at is not null)
    );

comment on column public.opportunity_finder_files.size_bytes is
  'Client-declared upload size. Do not use as the trusted size after download.';
comment on column public.opportunity_finder_files.actual_size_bytes is
  'Trusted byte count measured while the worker streams the stored object.';
comment on column public.opportunity_finder_files.content_sha256 is
  'Lowercase SHA-256 measured from the stored bytes. It is never exposed for cross-tenant deduplication.';
comment on column public.opportunity_finder_files.validation_status is
  'Server-side byte/hash/signature validation state. Only verified files may be materialized.';
comment on column public.opportunity_finder_files.profile_json is
  'Complete safe workbook profile: sheets, header detection, mappings, hidden/useful row counts, warnings and errors; no unrestricted raw workbook data.';
comment on column public.opportunity_finder_files.validity_override_expires_at is
  'Future expiry explicitly attested during role confirmation. Used only for supplier-offer rows whose source has no expiry; it never extends a row-level expiry.';
comment on column public.opportunity_finder_files.storage_deletion_token is
  'Durable two-phase retention claim. Upload/profile/retry transitions reject a file while this token is present.';
comment on column public.opportunity_finder_files.storage_deletion_started_at is
  'Timestamp associated with storage_deletion_token; cleared by retention finalize or abort.';

create index opportunity_finder_files_tenant_job_idx
  on public.opportunity_finder_files (tenant_id, job_id, side);
create index opportunity_finder_files_owner_hash_idx
  on public.opportunity_finder_files (tenant_id, content_sha256)
  where content_sha256 is not null;
create index opportunity_finder_files_retention_claim_idx
  on public.opportunity_finder_files (
    file_expires_at, storage_deletion_started_at, job_id, id
  )
  where storage_deleted_at is null;

alter table public.opportunity_finder_rows
  drop constraint if exists opportunity_finder_rows_record_role_check,
  drop constraint if exists opportunity_finder_rows_file_id_sheet_name_source_row_key;

alter table public.opportunity_finder_rows
  add constraint opportunity_finder_rows_record_role_check
    check (record_role in (
      'demand', 'stock', 'excess', 'supplier_offer', 'received_history',
      'purchase_history', 'quote_history', 'sales_history', 'ignore'
    ));

alter table public.opportunity_finder_rows
  add column if not exists tenant_id uuid,
  add column if not exists record_kind text,
  add column if not exists template_type text,
  add column if not exists mapping_version text,
  add column if not exists header_row integer,
  add column if not exists source_row_hidden boolean not null default false,
  add column if not exists source_columns jsonb not null default '{}'::jsonb,
  add column if not exists source_cell_refs jsonb not null default '{}'::jsonb,
  add column if not exists raw_row jsonb not null default '{}'::jsonb,
  add column if not exists demand_event_key text,
  add column if not exists demand_event_source_id text,
  add column if not exists supply_lot_key text,
  add column if not exists manufacturer_canonical text,
  add column if not exists manufacturer_alias_version text,
  add column if not exists snapshot_key text,
  add column if not exists client_item text,
  add column if not exists plant_facility text,
  add column if not exists end_customer text,
  add column if not exists option_ordinal integer,
  add column if not exists is_primary_option boolean,
  add column if not exists is_approved_alternate boolean,
  add column if not exists is_active_demand boolean not null default true,
  add column if not exists raw_quantity text,
  add column if not exists required_date_quality text,
  add column if not exists target_price numeric,
  add column if not exists target_currency text,
  add column if not exists offer_price numeric,
  add column if not exists unit_cost numeric,
  add column if not exists currency text,
  add column if not exists currency_status text,
  add column if not exists moq numeric,
  add column if not exists spq numeric,
  add column if not exists date_code text,
  add column if not exists coo text,
  add column if not exists lead_time_weeks numeric,
  add column if not exists transit_time_weeks numeric,
  add column if not exists condition text,
  add column if not exists expires_at timestamptz,
  add column if not exists is_live_supply boolean,
  add column if not exists ingestion_lock_token uuid,
  add column if not exists ingestion_fence bigint;

update public.opportunity_finder_rows row_data
set tenant_id = job.tenant_id
from public.opportunity_finder_jobs job
where job.id = row_data.job_id
  and row_data.tenant_id is null;

alter table public.opportunity_finder_rows
  alter column tenant_id set not null,
  drop constraint if exists opportunity_finder_rows_job_tenant_fk,
  add constraint opportunity_finder_rows_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  drop constraint if exists opportunity_finder_rows_record_kind_check,
  add constraint opportunity_finder_rows_record_kind_check
    check (record_kind is null or record_kind in ('demand_option', 'supply_lot', 'historical_signal')),
  drop constraint if exists opportunity_finder_rows_header_row_check,
  add constraint opportunity_finder_rows_header_row_check
    check (header_row is null or header_row > 0),
  drop constraint if exists opportunity_finder_rows_option_ordinal_check,
  add constraint opportunity_finder_rows_option_ordinal_check
    check (option_ordinal is null or option_ordinal > 0),
  drop constraint if exists opportunity_finder_rows_required_date_quality_check,
  add constraint opportunity_finder_rows_required_date_quality_check
    check (required_date_quality is null or required_date_quality in ('valid', 'missing', 'ambiguous', 'not_applicable')),
  drop constraint if exists opportunity_finder_rows_currency_status_check,
  add constraint opportunity_finder_rows_currency_status_check
    check (currency_status is null or currency_status in ('confirmed', 'unconfirmed', 'invalid')),
  drop constraint if exists opportunity_finder_rows_commercial_numbers_check,
  add constraint opportunity_finder_rows_commercial_numbers_check
    check (
      (target_price is null or target_price >= 0)
      and (offer_price is null or offer_price >= 0)
      and (unit_cost is null or unit_cost >= 0)
      and (moq is null or moq > 0)
      and (spq is null or spq > 0)
      and (lead_time_weeks is null or lead_time_weeks >= 0)
      and (transit_time_weeks is null or transit_time_weeks >= 0)
    ),
  drop constraint if exists opportunity_finder_rows_ingestion_fence_check,
  add constraint opportunity_finder_rows_ingestion_fence_check
    check (
      (ingestion_lock_token is null and ingestion_fence is null)
      or (ingestion_lock_token is not null and ingestion_fence is not null and ingestion_fence > 0)
    );

comment on table public.opportunity_finder_rows is
  'Temporary normalized staging. RLS is forced and no authenticated-user policy/grant exists; only the trusted worker may access raw_row, pricing or cost.';
comment on column public.opportunity_finder_rows.normalized_mpn is
  'Exact identity key (exact_norm). Punctuation, leading zeroes and potentially significant suffixes remain preserved.';
comment on column public.opportunity_finder_rows.review_key is
  'Search-only key (search_norm). Equality is never sufficient for automatic allocation.';
comment on column public.opportunity_finder_rows.ingestion_lock_token is
  'Attempt token captured on every new staging write and checked against the currently claimed job.';
comment on column public.opportunity_finder_rows.ingestion_fence is
  'Monotonic claim generation captured with ingestion_lock_token; stale attempts cannot add or mutate staging rows.';

create index opportunity_finder_rows_tenant_job_event_idx
  on public.opportunity_finder_rows (tenant_id, job_id, demand_event_key)
  where demand_event_key is not null;
create unique index opportunity_finder_rows_file_original_idx
  on public.opportunity_finder_rows (file_id, original_index);
create index opportunity_finder_rows_tenant_job_lot_idx
  on public.opportunity_finder_rows (tenant_id, job_id, supply_lot_key)
  where supply_lot_key is not null;

alter table public.opportunity_finder_results
  add column if not exists tenant_id uuid,
  add column if not exists result_key text,
  add column if not exists demand_event_id uuid,
  add column if not exists demand_event_key text,
  add column if not exists candidate_id uuid,
  add column if not exists demand_mpn_original text,
  add column if not exists supply_mpn_original text,
  add column if not exists manufacturer_canonical text,
  add column if not exists exact_mpn_match boolean not null default false,
  add column if not exists match_tier text,
  add column if not exists confidence text,
  add column if not exists match_explanation text,
  add column if not exists review_status text not null default 'not_required',
  add column if not exists remaining_qty numeric,
  add column if not exists moq numeric,
  add column if not exists spq numeric,
  add column if not exists date_code text,
  add column if not exists coo text,
  add column if not exists lead_time_weeks numeric,
  add column if not exists condition text,
  add column if not exists expires_at timestamptz,
  add column if not exists demand_traces jsonb not null default '[]'::jsonb,
  add column if not exists supply_traces jsonb not null default '[]'::jsonb,
  add column if not exists allocations_trace jsonb not null default '[]'::jsonb;

update public.opportunity_finder_results result
set tenant_id = job.tenant_id,
    exact_mpn_match = result.exact_match
from public.opportunity_finder_jobs job
where job.id = result.job_id
  and result.tenant_id is null;

alter table public.opportunity_finder_results
  alter column tenant_id set not null,
  drop constraint if exists opportunity_finder_results_job_tenant_fk,
  add constraint opportunity_finder_results_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  drop constraint if exists opportunity_finder_results_id_job_tenant_key,
  add constraint opportunity_finder_results_id_job_tenant_key unique (id, job_id, tenant_id),
  drop constraint if exists opportunity_finder_results_match_tier_check,
  add constraint opportunity_finder_results_match_tier_check
    check (match_tier is null or match_tier in (
      'exact_mpn_mfg', 'exact_mpn_mfg_missing', 'exact_mpn_approved_alias',
      'search_mpn_mfg', 'exact_mpn_mfg_conflict'
    )),
  drop constraint if exists opportunity_finder_results_confidence_check,
  add constraint opportunity_finder_results_confidence_check
    check (confidence is null or confidence in ('high', 'medium', 'low', 'review')),
  drop constraint if exists opportunity_finder_results_review_status_check,
  add constraint opportunity_finder_results_review_status_check
    check (review_status in ('not_required', 'pending', 'approved', 'rejected')),
  drop constraint if exists opportunity_finder_results_terms_check,
  add constraint opportunity_finder_results_terms_check
    check (
      (remaining_qty is null or remaining_qty >= 0)
      and (moq is null or moq > 0)
      and (spq is null or spq > 0)
      and (lead_time_weeks is null or lead_time_weeks >= 0)
    );

create unique index opportunity_finder_results_job_result_key_uidx
  on public.opportunity_finder_results (job_id, result_key)
  where result_key is not null;
create index opportunity_finder_results_tenant_job_review_idx
  on public.opportunity_finder_results (tenant_id, job_id, review_status, created_at);

comment on table public.opportunity_finder_results is
  'Owner-visible non-financial result projection. Pricing, cost, GP and margin are deliberately stored in service-only companion tables.';

alter table public.opportunity_finder_possible_matches
  add column if not exists tenant_id uuid,
  add column if not exists candidate_key text,
  add column if not exists demand_option_id uuid,
  add column if not exists supply_lot_id uuid,
  add column if not exists match_tier text not null default 'search_mpn_mfg',
  add column if not exists confidence text not null default 'review',
  add column if not exists explanation text,
  add column if not exists manufacturer_compatible boolean,
  add column if not exists review_status text not null default 'pending',
  add column if not exists demand_trace jsonb not null default '{}'::jsonb,
  add column if not exists supply_trace jsonb not null default '{}'::jsonb;

update public.opportunity_finder_possible_matches candidate
set tenant_id = job.tenant_id
from public.opportunity_finder_jobs job
where job.id = candidate.job_id
  and candidate.tenant_id is null;

alter table public.opportunity_finder_possible_matches
  alter column tenant_id set not null,
  drop constraint if exists opportunity_finder_possible_matches_job_tenant_fk,
  add constraint opportunity_finder_possible_matches_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  drop constraint if exists opportunity_finder_possible_matches_match_tier_check,
  add constraint opportunity_finder_possible_matches_match_tier_check
    check (match_tier in (
      'exact_mpn_mfg', 'exact_mpn_mfg_missing', 'exact_mpn_approved_alias',
      'search_mpn_mfg', 'exact_mpn_mfg_conflict'
    )),
  drop constraint if exists opportunity_finder_possible_matches_confidence_check,
  add constraint opportunity_finder_possible_matches_confidence_check
    check (confidence in ('high', 'medium', 'low', 'review')),
  drop constraint if exists opportunity_finder_possible_matches_review_status_check,
  add constraint opportunity_finder_possible_matches_review_status_check
    check (review_status in ('pending', 'approved', 'rejected'));

alter table public.opportunity_finder_possible_matches
  drop constraint if exists opportunity_finder_possible_m_job_id_demand_normalized_mpn__key,
  drop constraint if exists opportunity_finder_possible_matches_job_id_demand_normalized_mpn_supply_normalized_mpn_key;

create unique index opportunity_finder_possible_job_candidate_key_uidx
  on public.opportunity_finder_possible_matches (job_id, candidate_key)
  where candidate_key is not null;
create index opportunity_finder_possible_tenant_job_review_idx
  on public.opportunity_finder_possible_matches (tenant_id, job_id, review_status, created_at);

comment on table public.opportunity_finder_possible_matches is
  'Canonical match_candidates store retained under its legacy name for API compatibility. Search-normalized candidates always require review.';

-- Derive and validate child tenant scope for both legacy and advanced tables.
create or replace function public.set_opportunity_finder_child_tenant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  parent_tenant_id uuid;
begin
  select job.tenant_id
  into parent_tenant_id
  from public.opportunity_finder_jobs job
  where job.id = new.job_id;

  if parent_tenant_id is null then
    raise exception using errcode = '23503', message = 'opportunity_job_not_found';
  end if;

  if new.tenant_id is null then
    new.tenant_id := parent_tenant_id;
  elsif new.tenant_id <> parent_tenant_id then
    raise exception using errcode = '23514', message = 'opportunity_tenant_mismatch';
  end if;

  return new;
end;
$$;

revoke all on function public.set_opportunity_finder_child_tenant() from public;

-- Storage locators are derived server-side. Callers may not choose either the
-- bucket or object path, and only the supported ingestion formats are accepted.
create or replace function public.canonicalize_opportunity_finder_file_storage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  parent_created_by uuid;
  canonical_extension text;
begin
  select job.created_by
  into parent_created_by
  from public.opportunity_finder_jobs job
  where job.id = new.job_id;

  if parent_created_by is null then
    raise exception using errcode = '23503', message = 'opportunity_job_not_found';
  end if;

  if new.id is null then
    raise exception using errcode = '23514', message = 'opportunity_file_id_required';
  end if;

  canonical_extension := case
    when lower(new.original_file_name) ~ '\.csv$' then '.csv'
    when lower(new.original_file_name) ~ '\.xlsx$' then '.xlsx'
    else null
  end;

  if canonical_extension is null then
    raise exception using errcode = '23514', message = 'opportunity_file_extension_invalid';
  end if;

  new.storage_bucket := 'opportunity-finder';
  new.storage_path := parent_created_by::text
    || '/' || new.job_id::text
    || '/' || new.id::text
    || canonical_extension;

  return new;
end;
$$;

revoke all on function public.canonicalize_opportunity_finder_file_storage()
  from public, anon, authenticated, service_role;

drop trigger if exists opportunity_finder_files_canonical_storage
  on public.opportunity_finder_files;
create trigger opportunity_finder_files_canonical_storage
before insert or update of job_id, id, original_file_name, storage_bucket, storage_path
on public.opportunity_finder_files
for each row execute function public.canonicalize_opportunity_finder_file_storage();

drop trigger if exists opportunity_finder_files_set_tenant on public.opportunity_finder_files;
create trigger opportunity_finder_files_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_files
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_rows_set_tenant on public.opportunity_finder_rows;
create trigger opportunity_finder_rows_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_rows
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_results_set_tenant on public.opportunity_finder_results;
create trigger opportunity_finder_results_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_results
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_possible_set_tenant on public.opportunity_finder_possible_matches;
create trigger opportunity_finder_possible_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_possible_matches
for each row execute function public.set_opportunity_finder_child_tenant();

-- ---------------------------------------------------------------------------
-- Event, option, supply, history and allocation model.
-- ---------------------------------------------------------------------------

create table public.opportunity_finder_demand_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  file_id uuid not null references public.opportunity_finder_files(id) on delete cascade,
  event_key text not null,
  snapshot_key text,
  source_event_id text,
  template_type text,
  client_context text,
  client_item text,
  plant_facility text,
  end_customer text,
  required_qty numeric not null check (required_qty > 0),
  allocated_qty numeric not null default 0 check (allocated_qty >= 0),
  remaining_qty numeric not null check (remaining_qty >= 0),
  required_date date,
  required_date_quality text not null default 'missing'
    check (required_date_quality in ('valid', 'missing', 'ambiguous', 'not_applicable')),
  unit_of_measure text,
  target_price numeric check (target_price is null or target_price >= 0),
  target_currency text,
  is_active boolean not null default true,
  deterministic_order bigint not null,
  source_trace jsonb not null default '[]'::jsonb,
  quality_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_finder_demand_events_quantities_check
    check (
      allocated_qty <= required_qty
      and remaining_qty <= required_qty
      and allocated_qty + remaining_qty = required_qty
    ),
  constraint opportunity_finder_demand_events_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  unique (job_id, event_key),
  unique (id, job_id, tenant_id)
);

create table public.opportunity_finder_demand_part_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  demand_event_id uuid not null references public.opportunity_finder_demand_events(id) on delete cascade,
  file_id uuid not null references public.opportunity_finder_files(id) on delete cascade,
  raw_mpn text not null,
  display_mpn text not null,
  exact_norm text not null,
  search_norm text not null,
  manufacturer_original text,
  manufacturer_canonical text,
  manufacturer_alias_version text,
  unit_of_measure text,
  option_ordinal integer not null check (option_ordinal > 0),
  is_primary_option boolean not null default false,
  is_approved_alternate boolean not null default false,
  source_trace jsonb not null default '{}'::jsonb,
  quality_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint opportunity_finder_demand_options_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  unique (demand_event_id, option_ordinal),
  unique (id, job_id, tenant_id)
);

comment on table public.opportunity_finder_demand_events is
  'One demand quantity per business event. Sanmina groups snapshot+ORDDD; Flex groups snapshot+Comp ID+Item+Escalation Number.';
comment on table public.opportunity_finder_demand_part_options is
  'Alternative MPNs for one event, including option-specific UOM. This table intentionally has no demand quantity column, preventing quantity multiplication across alternatives.';

create table public.opportunity_finder_supply_lots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  file_id uuid not null references public.opportunity_finder_files(id) on delete cascade,
  lot_key text not null,
  supply_role text not null check (supply_role in ('stock', 'excess', 'supplier_offer')),
  raw_mpn text not null,
  display_mpn text not null,
  exact_norm text not null,
  search_norm text not null,
  manufacturer_original text,
  manufacturer_canonical text,
  manufacturer_alias_version text,
  supplier_context text,
  available_qty numeric not null check (available_qty > 0),
  allocated_qty numeric not null default 0 check (allocated_qty >= 0),
  remaining_qty numeric not null check (remaining_qty >= 0),
  unit_of_measure text,
  offer_price numeric check (offer_price is null or offer_price >= 0),
  unit_cost numeric check (unit_cost is null or unit_cost >= 0),
  currency text,
  currency_status text check (currency_status is null or currency_status in ('confirmed', 'unconfirmed', 'invalid')),
  moq numeric check (moq is null or moq > 0),
  spq numeric check (spq is null or spq > 0),
  date_code text,
  coo text,
  lead_time_weeks numeric check (lead_time_weeks is null or lead_time_weeks >= 0),
  transit_time_weeks numeric check (transit_time_weeks is null or transit_time_weeks >= 0),
  condition text,
  expires_at timestamptz,
  is_live_supply boolean not null default false,
  deterministic_order bigint not null,
  source_trace jsonb not null default '{}'::jsonb,
  quality_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_finder_supply_lots_quantities_check
    check (
      allocated_qty <= available_qty
      and remaining_qty <= available_qty
      and allocated_qty + remaining_qty = available_qty
    ),
  constraint opportunity_finder_supply_lots_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  unique (job_id, lot_key),
  unique (id, job_id, tenant_id)
);

create table public.opportunity_finder_historical_signals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  file_id uuid not null references public.opportunity_finder_files(id) on delete cascade,
  signal_key text not null,
  signal_role text not null
    check (signal_role in ('received_history', 'purchase_history', 'quote_history', 'sales_history')),
  raw_mpn text not null,
  display_mpn text not null,
  exact_norm text not null,
  search_norm text not null,
  manufacturer_original text,
  manufacturer_canonical text,
  observed_qty numeric,
  observed_price numeric check (observed_price is null or observed_price >= 0),
  currency text,
  observed_at date,
  source_trace jsonb not null default '{}'::jsonb,
  quality_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint opportunity_finder_historical_signals_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  unique (job_id, signal_key),
  unique (id, job_id, tenant_id)
);

comment on table public.opportunity_finder_supply_lots is
  'Service-only current supply staging. Historical roles are forbidden here and cannot become allocatable inventory.';
comment on table public.opportunity_finder_historical_signals is
  'Non-allocatable history. Received, purchase, quote and sales history can only produce historical signals.';

alter table public.opportunity_finder_possible_matches
  drop constraint if exists opportunity_finder_possible_demand_option_fk,
  add constraint opportunity_finder_possible_demand_option_fk
    foreign key (demand_option_id, job_id, tenant_id)
    references public.opportunity_finder_demand_part_options(id, job_id, tenant_id) on delete cascade,
  drop constraint if exists opportunity_finder_possible_supply_lot_fk,
  add constraint opportunity_finder_possible_supply_lot_fk
    foreign key (supply_lot_id, job_id, tenant_id)
    references public.opportunity_finder_supply_lots(id, job_id, tenant_id) on delete cascade;

alter table public.opportunity_finder_results
  drop constraint if exists opportunity_finder_results_demand_event_fk,
  add constraint opportunity_finder_results_demand_event_fk
    foreign key (demand_event_id)
    references public.opportunity_finder_demand_events(id) on delete set null,
  drop constraint if exists opportunity_finder_results_candidate_fk,
  add constraint opportunity_finder_results_candidate_fk
    foreign key (candidate_id) references public.opportunity_finder_possible_matches(id) on delete set null;

create table public.opportunity_finder_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  allocation_key text not null,
  result_id uuid not null,
  demand_event_id uuid not null,
  demand_part_option_id uuid not null,
  supply_lot_id uuid not null,
  supply_lot_key text not null,
  allocated_qty numeric not null check (allocated_qty > 0),
  reserved_qty numeric check (reserved_qty is null or reserved_qty > 0),
  available_before numeric not null check (available_before > 0),
  demand_remaining_before numeric check (demand_remaining_before is null or demand_remaining_before > 0),
  supply_remaining_after numeric check (supply_remaining_after is null or supply_remaining_after >= 0),
  demand_remaining_after numeric check (demand_remaining_after is null or demand_remaining_after >= 0),
  remaining_qty numeric check (remaining_qty is null or remaining_qty >= 0),
  deterministic_rank bigint not null default 0 check (deterministic_rank >= 0),
  commit_fence bigint not null check (commit_fence >= 0),
  decision_trace jsonb not null default '{}'::jsonb,
  supply_trace jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint opportunity_finder_allocations_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  constraint opportunity_finder_allocations_result_fk
    foreign key (result_id, job_id, tenant_id)
    references public.opportunity_finder_results(id, job_id, tenant_id) on delete cascade,
  constraint opportunity_finder_allocations_event_fk
    foreign key (demand_event_id, job_id, tenant_id)
    references public.opportunity_finder_demand_events(id, job_id, tenant_id) on delete cascade,
  constraint opportunity_finder_allocations_option_fk
    foreign key (demand_part_option_id, job_id, tenant_id)
    references public.opportunity_finder_demand_part_options(id, job_id, tenant_id) on delete restrict,
  constraint opportunity_finder_allocations_lot_fk
    foreign key (supply_lot_id, job_id, tenant_id)
    references public.opportunity_finder_supply_lots(id, job_id, tenant_id) on delete restrict,
  constraint opportunity_finder_allocations_lot_identity_check
    check (supply_lot_id is not null or nullif(trim(supply_lot_key), '') is not null),
  unique (job_id, allocation_key)
);

create unique index opportunity_finder_allocations_result_lot_key_uidx
  on public.opportunity_finder_allocations (result_id, supply_lot_key)
  where supply_lot_key is not null;

comment on table public.opportunity_finder_allocations is
  'A lot may be split deterministically across demands, but each reservation is row-locked and SUM(allocated_qty) can never exceed supply_lots.available_qty. The same quantity is never reused.';

create index opportunity_finder_demand_events_match_idx
  on public.opportunity_finder_demand_events (tenant_id, job_id, deterministic_order);
create index opportunity_finder_demand_options_exact_idx
  on public.opportunity_finder_demand_part_options (tenant_id, job_id, exact_norm, manufacturer_canonical);
create index opportunity_finder_demand_options_search_idx
  on public.opportunity_finder_demand_part_options (tenant_id, job_id, search_norm);
create index opportunity_finder_supply_lots_exact_remaining_idx
  on public.opportunity_finder_supply_lots (
    tenant_id, job_id, exact_norm, manufacturer_canonical, deterministic_order
  ) where remaining_qty > 0 and is_live_supply = true;
create index opportunity_finder_supply_lots_search_idx
  on public.opportunity_finder_supply_lots (tenant_id, job_id, search_norm);
create index opportunity_finder_historical_signals_exact_idx
  on public.opportunity_finder_historical_signals (tenant_id, job_id, exact_norm);
create index opportunity_finder_allocations_job_result_idx
  on public.opportunity_finder_allocations (tenant_id, job_id, result_id, deterministic_rank);
create index opportunity_finder_allocations_job_supply_lot_idx
  on public.opportunity_finder_allocations (job_id, supply_lot_id);
create index opportunity_finder_allocations_job_event_idx
  on public.opportunity_finder_allocations (job_id, demand_event_id);

-- ---------------------------------------------------------------------------
-- Protected result pricing and finance.
-- ---------------------------------------------------------------------------

create table public.opportunity_finder_result_commercials (
  result_id uuid primary key,
  tenant_id uuid not null,
  job_id uuid not null,
  target_price numeric check (target_price is null or target_price >= 0),
  offer_price numeric check (offer_price is null or offer_price >= 0),
  target_gap_percent numeric,
  currency text,
  revenue_potential numeric check (revenue_potential is null or revenue_potential >= 0),
  pricing_quality text not null default 'unconfirmed'
    check (pricing_quality in ('confirmed', 'unconfirmed', 'invalid', 'missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_finder_result_commercials_result_fk
    foreign key (result_id, job_id, tenant_id)
    references public.opportunity_finder_results(id, job_id, tenant_id) on delete cascade,
  constraint opportunity_finder_result_commercials_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade
);

create table public.opportunity_finder_result_financials (
  result_id uuid primary key,
  tenant_id uuid not null,
  job_id uuid not null,
  unit_cost numeric check (unit_cost is null or unit_cost >= 0),
  cost_currency text,
  gross_profit numeric,
  gross_margin_percent numeric check (gross_margin_percent is null or gross_margin_percent <= 100),
  cost_quality text not null default 'missing'
    check (cost_quality in ('valid', 'missing', 'invalid', 'untrusted')),
  cost_source_trace jsonb not null default '{}'::jsonb,
  computed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_finder_result_financials_result_fk
    foreign key (result_id, job_id, tenant_id)
    references public.opportunity_finder_results(id, job_id, tenant_id) on delete cascade,
  constraint opportunity_finder_result_financials_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  constraint opportunity_finder_result_financials_valid_cost_check
    check (
      cost_quality <> 'valid'
      or unit_cost is not null
    ),
  constraint opportunity_finder_result_financials_gp_requires_cost_check
    check (
      (gross_profit is null and gross_margin_percent is null)
      or unit_cost is not null
    )
);

create index opportunity_finder_result_commercials_job_idx
  on public.opportunity_finder_result_commercials (tenant_id, job_id, result_id);
create index opportunity_finder_result_financials_job_idx
  on public.opportunity_finder_result_financials (tenant_id, job_id, result_id);

comment on table public.opportunity_finder_result_commercials is
  'SERVICE-ONLY PRICING. The server API may return these fields only after verifying job ownership, tenant membership and an authorized admin pricing permission. Never expose this table through a client Supabase query.';
comment on table public.opportunity_finder_result_financials is
  'SERVICE-ONLY FINANCE. The server API may return unit cost, GP and margin only after verifying job ownership, tenant membership and public.is_opportunity_finder_tenant_admin(tenant_id) in the caller session. Never log these values.';

create or replace function public.normalize_opportunity_finder_protected_result()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'opportunity_finder_result_commercials' then
    if new.target_price is null
       and new.offer_price is null
       and new.revenue_potential is null then
      new.pricing_quality := 'missing';
    end if;
  elsif tg_table_name = 'opportunity_finder_result_financials' then
    if new.unit_cost is null then
      new.cost_quality := 'missing';
      new.gross_profit := null;
      new.gross_margin_percent := null;
    elsif nullif(trim(new.cost_currency), '') is null then
      new.cost_quality := 'untrusted';
      new.gross_profit := null;
      new.gross_margin_percent := null;
    elsif new.cost_quality = 'missing' then
      -- This trigger is reachable only by the trusted service role. A supplied
      -- unit_cost therefore represents the worker's validated cost decision.
      new.cost_quality := 'valid';
    end if;

    if new.gross_profit is not null or new.gross_margin_percent is not null then
      new.computed_at := coalesce(new.computed_at, now());
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.normalize_opportunity_finder_protected_result() from public;

drop trigger if exists opportunity_finder_commercials_normalize on public.opportunity_finder_result_commercials;
create trigger opportunity_finder_commercials_normalize
before insert or update on public.opportunity_finder_result_commercials
for each row execute function public.normalize_opportunity_finder_protected_result();

drop trigger if exists opportunity_finder_financials_normalize on public.opportunity_finder_result_financials;
create trigger opportunity_finder_financials_normalize
before insert or update on public.opportunity_finder_result_financials
for each row execute function public.normalize_opportunity_finder_protected_result();

-- ---------------------------------------------------------------------------
-- Rejections, reviews, versioned manufacturer data and audit.
-- ---------------------------------------------------------------------------

create table public.opportunity_finder_rejected_rows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  file_id uuid not null references public.opportunity_finder_files(id) on delete cascade,
  side text not null check (side in ('A', 'B')),
  file_name text not null,
  sheet_name text not null,
  source_row integer not null check (source_row > 0),
  source_row_hidden boolean not null default false,
  reason_code text not null,
  field_name text,
  source_column text,
  safe_raw_value text,
  source_trace jsonb not null default '{}'::jsonb,
  ingestion_lock_token uuid,
  ingestion_fence bigint,
  created_at timestamptz not null default now(),
  constraint opportunity_finder_rejected_rows_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  constraint opportunity_finder_rejected_rows_ingestion_fence_check
    check (
      (ingestion_lock_token is null and ingestion_fence is null)
      or (ingestion_lock_token is not null and ingestion_fence is not null and ingestion_fence > 0)
    ),
  unique (job_id, file_id, sheet_name, source_row, reason_code, field_name)
);

comment on column public.opportunity_finder_rejected_rows.ingestion_lock_token is
  'Attempt token captured on direct and atomic rejected-row writes.';
comment on column public.opportunity_finder_rejected_rows.ingestion_fence is
  'Monotonic claim generation captured with ingestion_lock_token.';

create table public.opportunity_finder_manufacturer_registry_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.opportunity_finder_tenants(id) on delete cascade,
  version_tag text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  notes text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  approved_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  unique (tenant_id, version_tag),
  unique (id, tenant_id)
);

create unique index opportunity_finder_manufacturer_one_active_version_uidx
  on public.opportunity_finder_manufacturer_registry_versions (tenant_id)
  where status = 'active';

alter table public.opportunity_finder_manufacturer_registry_versions
  add constraint opportunity_finder_manufacturer_active_version_approval_check
  check (status <> 'active' or (approved_by is not null and approved_at is not null));

create table public.opportunity_finder_manufacturers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  version_id uuid not null,
  canonical_name text not null,
  normalized_name text not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint opportunity_finder_manufacturers_version_fk
    foreign key (version_id, tenant_id)
    references public.opportunity_finder_manufacturer_registry_versions(id, tenant_id) on delete cascade,
  unique (version_id, normalized_name),
  unique (id, version_id, tenant_id)
);

create table public.opportunity_finder_manufacturer_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  version_id uuid not null,
  manufacturer_id uuid not null,
  alias_original text not null,
  alias_normalized text not null,
  approval_status text not null default 'suggested'
    check (approval_status in ('suggested', 'approved', 'rejected')),
  evidence jsonb not null default '{}'::jsonb,
  suggested_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  suggested_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint opportunity_finder_manufacturer_aliases_version_fk
    foreign key (version_id, tenant_id)
    references public.opportunity_finder_manufacturer_registry_versions(id, tenant_id) on delete cascade,
  constraint opportunity_finder_manufacturer_aliases_manufacturer_fk
    foreign key (manufacturer_id, version_id, tenant_id)
    references public.opportunity_finder_manufacturers(id, version_id, tenant_id) on delete cascade,
  constraint opportunity_finder_manufacturer_aliases_approval_check
    check (
      (approval_status = 'suggested' and approved_by is null and decided_at is null)
      or (approval_status in ('approved', 'rejected') and approved_by is not null and decided_at is not null)
    ),
  unique (version_id, alias_normalized),
  unique (id, tenant_id)
);

comment on table public.opportunity_finder_manufacturer_aliases is
  'Suggestions remain suggested until an authorized human records an explicit decision. No trigger or matcher may auto-promote an alias to approved.';

create table public.opportunity_finder_part_equivalence_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.opportunity_finder_tenants(id) on delete cascade,
  version_tag text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  approved_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  unique (tenant_id, version_tag),
  unique (id, tenant_id)
);

create unique index opportunity_finder_equivalence_one_active_version_uidx
  on public.opportunity_finder_part_equivalence_versions (tenant_id)
  where status = 'active';

alter table public.opportunity_finder_part_equivalence_versions
  add constraint opportunity_finder_equivalence_active_version_approval_check
  check (status <> 'active' or (approved_by is not null and approved_at is not null));

create table public.opportunity_finder_part_equivalences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  version_id uuid not null,
  from_exact_norm text not null,
  from_manufacturer_normalized text,
  to_exact_norm text not null,
  to_manufacturer_normalized text,
  equivalence_kind text not null
    check (equivalence_kind in ('approved_alternate', 'packaging_variant', 'engineering_substitute')),
  approval_status text not null default 'suggested'
    check (approval_status in ('suggested', 'approved', 'rejected')),
  requires_review boolean not null default true check (requires_review = true),
  evidence jsonb not null default '{}'::jsonb,
  suggested_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  suggested_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint opportunity_finder_part_equivalences_version_fk
    foreign key (version_id, tenant_id)
    references public.opportunity_finder_part_equivalence_versions(id, tenant_id) on delete cascade,
  constraint opportunity_finder_part_equivalences_distinct_check
    check (
      (from_exact_norm, coalesce(from_manufacturer_normalized, ''))
      <> (to_exact_norm, coalesce(to_manufacturer_normalized, ''))
    ),
  constraint opportunity_finder_part_equivalences_approval_check
    check (
      (approval_status = 'suggested' and approved_by is null and decided_at is null)
      or (approval_status in ('approved', 'rejected') and approved_by is not null and decided_at is not null)
    ),
  unique (
    version_id,
    from_exact_norm,
    from_manufacturer_normalized,
    to_exact_norm,
    to_manufacturer_normalized
  ),
  unique (id, tenant_id)
);

comment on table public.opportunity_finder_part_equivalences is
  'Versioned human-reviewed knowledge. Even approved equivalences retain requires_review=true and cannot become an automatic exact MPN match.';

create table public.opportunity_finder_review_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.opportunity_finder_tenants(id) on delete cascade,
  job_id uuid not null references public.opportunity_finder_jobs(id) on delete cascade,
  entity_type text not null check (entity_type in ('result', 'possible_match')),
  entity_id uuid not null,
  decision text not null check (decision in ('approved', 'rejected')),
  reviewer_id uuid not null references public.profiles(id) on delete restrict,
  review_note text,
  decided_at timestamptz not null default now(),
  decision_context jsonb not null default '{}'::jsonb,
  constraint opportunity_finder_review_decisions_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  constraint opportunity_finder_review_entity_uidx
    unique (job_id, entity_type, entity_id)
);

create table public.opportunity_finder_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.opportunity_finder_tenants(id) on delete cascade,
  job_id uuid references public.opportunity_finder_jobs(id) on delete set null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  request_id uuid,
  trace_id uuid,
  safe_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

comment on table public.opportunity_finder_audit_events is
  'Append-only audit trail for upload, classification, confirmation, processing, matching, review, export and deletion. safe_metadata must never contain MPNs, client names, prices, costs or raw rows.';

create index opportunity_finder_rejected_rows_job_idx
  on public.opportunity_finder_rejected_rows (tenant_id, job_id, file_id, source_row);
create index opportunity_finder_manufacturers_lookup_idx
  on public.opportunity_finder_manufacturers (tenant_id, normalized_name);
create index opportunity_finder_manufacturer_aliases_lookup_idx
  on public.opportunity_finder_manufacturer_aliases (tenant_id, alias_normalized, approval_status);
create index opportunity_finder_equivalences_from_idx
  on public.opportunity_finder_part_equivalences (
    tenant_id, from_exact_norm, from_manufacturer_normalized, approval_status
  );
create index opportunity_finder_review_decisions_job_idx
  on public.opportunity_finder_review_decisions (tenant_id, job_id, decided_at desc);
create index opportunity_finder_audit_events_job_time_idx
  on public.opportunity_finder_audit_events (tenant_id, job_id, occurred_at desc);

-- Apply scope trigger to every new job child that permits service-side inserts.
drop trigger if exists opportunity_finder_demand_events_set_tenant on public.opportunity_finder_demand_events;
create trigger opportunity_finder_demand_events_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_demand_events
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_demand_options_set_tenant on public.opportunity_finder_demand_part_options;
create trigger opportunity_finder_demand_options_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_demand_part_options
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_supply_lots_set_tenant on public.opportunity_finder_supply_lots;
create trigger opportunity_finder_supply_lots_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_supply_lots
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_historical_signals_set_tenant on public.opportunity_finder_historical_signals;
create trigger opportunity_finder_historical_signals_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_historical_signals
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_allocations_set_tenant on public.opportunity_finder_allocations;
create trigger opportunity_finder_allocations_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_allocations
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_commercials_set_tenant on public.opportunity_finder_result_commercials;
create trigger opportunity_finder_commercials_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_result_commercials
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_financials_set_tenant on public.opportunity_finder_result_financials;
create trigger opportunity_finder_financials_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_result_financials
for each row execute function public.set_opportunity_finder_child_tenant();

drop trigger if exists opportunity_finder_rejected_set_tenant on public.opportunity_finder_rejected_rows;
create trigger opportunity_finder_rejected_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_rejected_rows
for each row execute function public.set_opportunity_finder_child_tenant();

-- A heartbeat checked by the application before an INSERT is not a fence: a
-- reclaim can rotate the token between that check and the write. Lock the
-- parent job row in the same database transaction as every staging mutation
-- and compare both the random token and monotonic generation.
create or replace function public.assert_opportunity_finder_ingestion_fence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  active_worker_id text;
  active_lock_token uuid;
  active_fence bigint;
  active_status text;
  active_cancel_requested boolean;
begin
  select
    job.locked_by,
    job.lock_token,
    job.processing_fence,
    job.status,
    job.cancel_requested
  into
    active_worker_id,
    active_lock_token,
    active_fence,
    active_status,
    active_cancel_requested
  from public.opportunity_finder_jobs job
  where job.id = new.job_id
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if active_worker_id is null
     or new.ingestion_lock_token is distinct from active_lock_token
     or new.ingestion_fence is distinct from active_fence then
    raise exception using errcode = '40001', message = 'stale_opportunity_ingestion_fence';
  end if;

  if active_status not in ('parsing', 'matching')
     or active_cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_ingestible';
  end if;

  return new;
end;
$$;

revoke all on function public.assert_opportunity_finder_ingestion_fence()
from public, anon, authenticated, service_role;

drop trigger if exists opportunity_finder_rows_assert_ingestion_fence
on public.opportunity_finder_rows;
create trigger opportunity_finder_rows_assert_ingestion_fence
before insert or update on public.opportunity_finder_rows
for each row execute function public.assert_opportunity_finder_ingestion_fence();

drop trigger if exists opportunity_finder_rejected_assert_ingestion_fence
on public.opportunity_finder_rejected_rows;
create trigger opportunity_finder_rejected_assert_ingestion_fence
before insert or update on public.opportunity_finder_rejected_rows
for each row execute function public.assert_opportunity_finder_ingestion_fence();

drop trigger if exists opportunity_finder_review_decisions_set_tenant on public.opportunity_finder_review_decisions;
create trigger opportunity_finder_review_decisions_set_tenant
before insert or update of job_id, tenant_id on public.opportunity_finder_review_decisions
for each row execute function public.set_opportunity_finder_child_tenant();

create or replace function public.validate_opportunity_finder_review_target()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.entity_type = 'result' and not exists (
    select 1
    from public.opportunity_finder_results result
    where result.id = new.entity_id
      and result.job_id = new.job_id
      and result.tenant_id = new.tenant_id
  ) then
    raise exception using errcode = '23503', message = 'review_result_not_found';
  end if;

  if new.entity_type = 'possible_match' and not exists (
    select 1
    from public.opportunity_finder_possible_matches candidate
    where candidate.id = new.entity_id
      and candidate.job_id = new.job_id
      and candidate.tenant_id = new.tenant_id
  ) then
    raise exception using errcode = '23503', message = 'review_candidate_not_found';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_opportunity_finder_review_target() from public;

drop trigger if exists opportunity_finder_review_decisions_validate_target on public.opportunity_finder_review_decisions;
create trigger opportunity_finder_review_decisions_validate_target
before insert or update of job_id, tenant_id, entity_type, entity_id
on public.opportunity_finder_review_decisions
for each row execute function public.validate_opportunity_finder_review_target();

-- Updated-at triggers use the platform's existing public.set_updated_at().
drop trigger if exists opportunity_finder_tenants_set_updated_at on public.opportunity_finder_tenants;
create trigger opportunity_finder_tenants_set_updated_at
before update on public.opportunity_finder_tenants
for each row execute function public.set_updated_at();

drop trigger if exists opportunity_finder_demand_events_set_updated_at on public.opportunity_finder_demand_events;
create trigger opportunity_finder_demand_events_set_updated_at
before update on public.opportunity_finder_demand_events
for each row execute function public.set_updated_at();

drop trigger if exists opportunity_finder_supply_lots_set_updated_at on public.opportunity_finder_supply_lots;
create trigger opportunity_finder_supply_lots_set_updated_at
before update on public.opportunity_finder_supply_lots
for each row execute function public.set_updated_at();

drop trigger if exists opportunity_finder_commercials_set_updated_at on public.opportunity_finder_result_commercials;
create trigger opportunity_finder_commercials_set_updated_at
before update on public.opportunity_finder_result_commercials
for each row execute function public.set_updated_at();

drop trigger if exists opportunity_finder_financials_set_updated_at on public.opportunity_finder_result_financials;
create trigger opportunity_finder_financials_set_updated_at
before update on public.opportunity_finder_result_financials
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: every object is tenant scoped; job data additionally remains owner-only.
-- ---------------------------------------------------------------------------

create or replace function public.can_access_opportunity_finder_job(
  target_job_id uuid,
  target_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.opportunity_finder_jobs job
    join public.opportunity_finder_tenant_memberships membership
      on membership.tenant_id = job.tenant_id
     and membership.user_id = auth.uid()
    join public.profiles profile
      on profile.id = membership.user_id
    where job.id = target_job_id
      and job.tenant_id = target_tenant_id
      and job.created_by = auth.uid()
      and profile.is_active = true
  );
$$;

revoke all on function public.can_access_opportunity_finder_job(uuid, uuid) from public;
grant execute on function public.can_access_opportunity_finder_job(uuid, uuid) to authenticated;
grant execute on function public.can_access_opportunity_finder_job(uuid, uuid) to service_role;

alter table public.opportunity_finder_tenants enable row level security;
alter table public.opportunity_finder_tenants force row level security;
alter table public.opportunity_finder_tenant_memberships enable row level security;
alter table public.opportunity_finder_tenant_memberships force row level security;
alter table public.opportunity_finder_jobs enable row level security;
alter table public.opportunity_finder_jobs force row level security;
alter table public.opportunity_finder_files enable row level security;
alter table public.opportunity_finder_files force row level security;
alter table public.opportunity_finder_rows enable row level security;
alter table public.opportunity_finder_rows force row level security;
alter table public.opportunity_finder_results enable row level security;
alter table public.opportunity_finder_results force row level security;
alter table public.opportunity_finder_possible_matches enable row level security;
alter table public.opportunity_finder_possible_matches force row level security;
alter table public.opportunity_finder_demand_events enable row level security;
alter table public.opportunity_finder_demand_events force row level security;
alter table public.opportunity_finder_demand_part_options enable row level security;
alter table public.opportunity_finder_demand_part_options force row level security;
alter table public.opportunity_finder_supply_lots enable row level security;
alter table public.opportunity_finder_supply_lots force row level security;
alter table public.opportunity_finder_historical_signals enable row level security;
alter table public.opportunity_finder_historical_signals force row level security;
alter table public.opportunity_finder_allocations enable row level security;
alter table public.opportunity_finder_allocations force row level security;
alter table public.opportunity_finder_result_commercials enable row level security;
alter table public.opportunity_finder_result_commercials force row level security;
alter table public.opportunity_finder_result_financials enable row level security;
alter table public.opportunity_finder_result_financials force row level security;
alter table public.opportunity_finder_rejected_rows enable row level security;
alter table public.opportunity_finder_rejected_rows force row level security;
alter table public.opportunity_finder_manufacturer_registry_versions enable row level security;
alter table public.opportunity_finder_manufacturer_registry_versions force row level security;
alter table public.opportunity_finder_manufacturers enable row level security;
alter table public.opportunity_finder_manufacturers force row level security;
alter table public.opportunity_finder_manufacturer_aliases enable row level security;
alter table public.opportunity_finder_manufacturer_aliases force row level security;
alter table public.opportunity_finder_part_equivalence_versions enable row level security;
alter table public.opportunity_finder_part_equivalence_versions force row level security;
alter table public.opportunity_finder_part_equivalences enable row level security;
alter table public.opportunity_finder_part_equivalences force row level security;
alter table public.opportunity_finder_review_decisions enable row level security;
alter table public.opportunity_finder_review_decisions force row level security;
alter table public.opportunity_finder_audit_events enable row level security;
alter table public.opportunity_finder_audit_events force row level security;

drop policy if exists opportunity_finder_tenants_select_member on public.opportunity_finder_tenants;
create policy opportunity_finder_tenants_select_member
on public.opportunity_finder_tenants
for select to authenticated
using (public.is_opportunity_finder_tenant_member(id));

drop policy if exists opportunity_finder_memberships_select_self on public.opportunity_finder_tenant_memberships;
create policy opportunity_finder_memberships_select_self
on public.opportunity_finder_tenant_memberships
for select to authenticated
using (user_id = auth.uid() and public.is_active_profile());

drop policy if exists opportunity_finder_jobs_select_own on public.opportunity_finder_jobs;
create policy opportunity_finder_jobs_select_own
on public.opportunity_finder_jobs
for select to authenticated
using (public.can_access_opportunity_finder_job(id, tenant_id));

drop policy if exists opportunity_finder_jobs_insert_own on public.opportunity_finder_jobs;
drop policy if exists opportunity_finder_jobs_update_own on public.opportunity_finder_jobs;
drop policy if exists opportunity_finder_jobs_delete_own on public.opportunity_finder_jobs;

drop policy if exists opportunity_finder_files_select_own on public.opportunity_finder_files;
create policy opportunity_finder_files_select_own
on public.opportunity_finder_files
for select to authenticated
using (public.can_access_opportunity_finder_job(job_id, tenant_id));

drop policy if exists opportunity_finder_files_insert_own on public.opportunity_finder_files;
drop policy if exists opportunity_finder_files_update_own on public.opportunity_finder_files;
drop policy if exists opportunity_finder_files_delete_own on public.opportunity_finder_files;

-- Job/file mutations are trusted-server operations. Authenticated users retain
-- visibility through the ownership policies above but receive no table DML.

-- Normalized rows, demand entities, supply lots and historical rows are
-- staging data. They deliberately have no authenticated policies.

drop policy if exists opportunity_finder_results_select_own on public.opportunity_finder_results;
create policy opportunity_finder_results_select_own
on public.opportunity_finder_results
for select to authenticated
using (public.can_access_opportunity_finder_job(job_id, tenant_id));

drop policy if exists opportunity_finder_possible_select_own on public.opportunity_finder_possible_matches;
create policy opportunity_finder_possible_select_own
on public.opportunity_finder_possible_matches
for select to authenticated
using (public.can_access_opportunity_finder_job(job_id, tenant_id));

drop policy if exists opportunity_finder_allocations_select_own on public.opportunity_finder_allocations;
create policy opportunity_finder_allocations_select_own
on public.opportunity_finder_allocations
for select to authenticated
using (public.can_access_opportunity_finder_job(job_id, tenant_id));

-- No authenticated policy is defined on result_commercials or
-- result_financials. Pricing/cost is fetched only by a trusted server route
-- after owner+tenant+admin authorization; service_role remains the DB writer.

drop policy if exists opportunity_finder_rejected_select_own on public.opportunity_finder_rejected_rows;
create policy opportunity_finder_rejected_select_own
on public.opportunity_finder_rejected_rows
for select to authenticated
using (public.can_access_opportunity_finder_job(job_id, tenant_id));

drop policy if exists opportunity_finder_registry_versions_select_member on public.opportunity_finder_manufacturer_registry_versions;
create policy opportunity_finder_registry_versions_select_member
on public.opportunity_finder_manufacturer_registry_versions
for select to authenticated
using (
  status = 'active'
  and approved_by is not null
  and approved_at is not null
  and public.is_opportunity_finder_tenant_member(tenant_id)
);

drop policy if exists opportunity_finder_manufacturers_select_member on public.opportunity_finder_manufacturers;
create policy opportunity_finder_manufacturers_select_member
on public.opportunity_finder_manufacturers
for select to authenticated
using (
  status = 'active'
  and public.is_opportunity_finder_tenant_member(tenant_id)
  and exists (
    select 1
    from public.opportunity_finder_manufacturer_registry_versions version
    where version.id = version_id
      and version.tenant_id = opportunity_finder_manufacturers.tenant_id
      and version.status = 'active'
      and version.approved_by is not null
      and version.approved_at is not null
  )
);

drop policy if exists opportunity_finder_aliases_select_approved on public.opportunity_finder_manufacturer_aliases;
create policy opportunity_finder_aliases_select_approved
on public.opportunity_finder_manufacturer_aliases
for select to authenticated
using (
  approval_status = 'approved'
  and public.is_opportunity_finder_tenant_member(tenant_id)
  and exists (
    select 1
    from public.opportunity_finder_manufacturer_registry_versions version
    where version.id = version_id
      and version.tenant_id = opportunity_finder_manufacturer_aliases.tenant_id
      and version.status = 'active'
      and version.approved_by is not null
      and version.approved_at is not null
  )
);

drop policy if exists opportunity_finder_equivalence_versions_select_member on public.opportunity_finder_part_equivalence_versions;
create policy opportunity_finder_equivalence_versions_select_member
on public.opportunity_finder_part_equivalence_versions
for select to authenticated
using (
  status = 'active'
  and approved_by is not null
  and approved_at is not null
  and public.is_opportunity_finder_tenant_member(tenant_id)
);

drop policy if exists opportunity_finder_equivalences_select_approved on public.opportunity_finder_part_equivalences;
create policy opportunity_finder_equivalences_select_approved
on public.opportunity_finder_part_equivalences
for select to authenticated
using (
  approval_status = 'approved'
  and public.is_opportunity_finder_tenant_member(tenant_id)
  and exists (
    select 1
    from public.opportunity_finder_part_equivalence_versions version
    where version.id = version_id
      and version.tenant_id = opportunity_finder_part_equivalences.tenant_id
      and version.status = 'active'
      and version.approved_by is not null
      and version.approved_at is not null
  )
);

drop policy if exists opportunity_finder_review_decisions_select_own on public.opportunity_finder_review_decisions;
create policy opportunity_finder_review_decisions_select_own
on public.opportunity_finder_review_decisions
for select to authenticated
using (
  reviewer_id = auth.uid()
  and public.is_opportunity_finder_tenant_member(tenant_id)
  and public.can_access_opportunity_finder_job(job_id, tenant_id)
);

drop policy if exists opportunity_finder_review_decisions_insert_own on public.opportunity_finder_review_decisions;
create policy opportunity_finder_review_decisions_insert_own
on public.opportunity_finder_review_decisions
for insert to authenticated
with check (
  reviewer_id = auth.uid()
  and public.is_opportunity_finder_tenant_member(tenant_id)
  and public.can_access_opportunity_finder_job(job_id, tenant_id)
);

drop policy if exists opportunity_finder_audit_events_select_own on public.opportunity_finder_audit_events;
create policy opportunity_finder_audit_events_select_own
on public.opportunity_finder_audit_events
for select to authenticated
using (
  job_id is not null
  and public.can_access_opportunity_finder_job(job_id, tenant_id)
);

-- Explicit grants complement RLS. The service role is the only writer for
-- staging, matches, results, protected pricing/finance and audit records.
revoke all on public.opportunity_finder_tenants from anon, authenticated;
revoke all on public.opportunity_finder_tenant_memberships from anon, authenticated;
revoke all on public.opportunity_finder_jobs from anon, authenticated;
revoke all on public.opportunity_finder_files from anon, authenticated;
revoke all on public.opportunity_finder_rows from anon, authenticated;
revoke all on public.opportunity_finder_results from anon, authenticated;
revoke all on public.opportunity_finder_possible_matches from anon, authenticated;
revoke all on public.opportunity_finder_demand_events from anon, authenticated;
revoke all on public.opportunity_finder_demand_part_options from anon, authenticated;
revoke all on public.opportunity_finder_supply_lots from anon, authenticated;
revoke all on public.opportunity_finder_historical_signals from anon, authenticated;
revoke all on public.opportunity_finder_allocations from anon, authenticated;
revoke all on public.opportunity_finder_result_commercials from anon, authenticated;
revoke all on public.opportunity_finder_result_financials from anon, authenticated;
revoke all on public.opportunity_finder_rejected_rows from anon, authenticated;
revoke all on public.opportunity_finder_manufacturer_registry_versions from anon, authenticated;
revoke all on public.opportunity_finder_manufacturers from anon, authenticated;
revoke all on public.opportunity_finder_manufacturer_aliases from anon, authenticated;
revoke all on public.opportunity_finder_part_equivalence_versions from anon, authenticated;
revoke all on public.opportunity_finder_part_equivalences from anon, authenticated;
revoke all on public.opportunity_finder_review_decisions from anon, authenticated;
revoke all on public.opportunity_finder_audit_events from anon, authenticated;

grant select on public.opportunity_finder_tenants to authenticated;
grant select on public.opportunity_finder_tenant_memberships to authenticated;
grant select on public.opportunity_finder_jobs to authenticated;
grant select on public.opportunity_finder_files to authenticated;
grant select on public.opportunity_finder_results to authenticated;
grant select on public.opportunity_finder_possible_matches to authenticated;
grant select on public.opportunity_finder_allocations to authenticated;
grant select on public.opportunity_finder_rejected_rows to authenticated;
grant select on public.opportunity_finder_manufacturer_registry_versions to authenticated;
grant select on public.opportunity_finder_manufacturers to authenticated;
grant select on public.opportunity_finder_manufacturer_aliases to authenticated;
grant select on public.opportunity_finder_part_equivalence_versions to authenticated;
grant select on public.opportunity_finder_part_equivalences to authenticated;
grant select, insert on public.opportunity_finder_review_decisions to authenticated;
grant select on public.opportunity_finder_audit_events to authenticated;

grant all on public.opportunity_finder_tenants to service_role;
grant all on public.opportunity_finder_tenant_memberships to service_role;
grant all on public.opportunity_finder_jobs to service_role;
grant all on public.opportunity_finder_files to service_role;
grant all on public.opportunity_finder_rows to service_role;
grant all on public.opportunity_finder_results to service_role;
grant all on public.opportunity_finder_possible_matches to service_role;
grant all on public.opportunity_finder_demand_events to service_role;
grant all on public.opportunity_finder_demand_part_options to service_role;
grant all on public.opportunity_finder_supply_lots to service_role;
grant all on public.opportunity_finder_historical_signals to service_role;
grant all on public.opportunity_finder_allocations to service_role;
grant all on public.opportunity_finder_result_commercials to service_role;
grant all on public.opportunity_finder_result_financials to service_role;
grant all on public.opportunity_finder_rejected_rows to service_role;
grant all on public.opportunity_finder_manufacturer_registry_versions to service_role;
grant all on public.opportunity_finder_manufacturers to service_role;
grant all on public.opportunity_finder_manufacturer_aliases to service_role;
grant all on public.opportunity_finder_part_equivalence_versions to service_role;
grant all on public.opportunity_finder_part_equivalences to service_role;
grant all on public.opportunity_finder_review_decisions to service_role;
revoke all on public.opportunity_finder_audit_events from service_role;
grant select, insert on public.opportunity_finder_audit_events to service_role;

-- Direct service-role mutations are limited to canonical-row ingestion. Every
-- materialized entity and output table is changed only through a fenced
-- SECURITY DEFINER RPC, so a stale service client cannot publish partial data.
revoke all on public.opportunity_finder_rows from service_role;
grant select, insert on public.opportunity_finder_rows to service_role;

revoke all on public.opportunity_finder_results from service_role;
grant select on public.opportunity_finder_results to service_role;
revoke all on public.opportunity_finder_possible_matches from service_role;
grant select on public.opportunity_finder_possible_matches to service_role;
revoke all on public.opportunity_finder_demand_events from service_role;
grant select on public.opportunity_finder_demand_events to service_role;
revoke all on public.opportunity_finder_demand_part_options from service_role;
grant select on public.opportunity_finder_demand_part_options to service_role;
revoke all on public.opportunity_finder_supply_lots from service_role;
grant select on public.opportunity_finder_supply_lots to service_role;
revoke all on public.opportunity_finder_historical_signals from service_role;
grant select on public.opportunity_finder_historical_signals to service_role;
revoke all on public.opportunity_finder_allocations from service_role;
grant select on public.opportunity_finder_allocations to service_role;
revoke all on public.opportunity_finder_result_commercials from service_role;
grant select on public.opportunity_finder_result_commercials to service_role;
revoke all on public.opportunity_finder_result_financials from service_role;
grant select on public.opportunity_finder_result_financials to service_role;
revoke all on public.opportunity_finder_rejected_rows from service_role;
grant select on public.opportunity_finder_rejected_rows to service_role;
revoke all on public.opportunity_finder_review_decisions from service_role;
grant select on public.opportunity_finder_review_decisions to service_role;

-- These tables are now RPC-only for mutations and every row carries a
-- composite (job_id, tenant_id) FK. Removing their per-row tenant lookup avoids
-- tens of thousands of redundant job reads during set-based materialization
-- and output commit. Files and canonical rows keep their tenant triggers
-- because the service client still writes those tables directly.
drop trigger if exists opportunity_finder_results_set_tenant
  on public.opportunity_finder_results;
drop trigger if exists opportunity_finder_possible_set_tenant
  on public.opportunity_finder_possible_matches;
drop trigger if exists opportunity_finder_demand_events_set_tenant
  on public.opportunity_finder_demand_events;
drop trigger if exists opportunity_finder_demand_options_set_tenant
  on public.opportunity_finder_demand_part_options;
drop trigger if exists opportunity_finder_supply_lots_set_tenant
  on public.opportunity_finder_supply_lots;
drop trigger if exists opportunity_finder_historical_signals_set_tenant
  on public.opportunity_finder_historical_signals;
drop trigger if exists opportunity_finder_allocations_set_tenant
  on public.opportunity_finder_allocations;
drop trigger if exists opportunity_finder_commercials_set_tenant
  on public.opportunity_finder_result_commercials;
drop trigger if exists opportunity_finder_financials_set_tenant
  on public.opportunity_finder_result_financials;
drop trigger if exists opportunity_finder_rejected_set_tenant
  on public.opportunity_finder_rejected_rows;
drop trigger if exists opportunity_finder_review_decisions_set_tenant
  on public.opportunity_finder_review_decisions;

-- Reassert private storage. The application obtains short-lived signed URLs
-- through a trusted server; there is intentionally no direct client SELECT.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'opportunity-finder',
  'opportunity-finder',
  false,
  67108864,
  array[
    'text/csv',
    'application/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists opportunity_finder_storage_insert_own on storage.objects;
create policy opportunity_finder_storage_insert_own
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'opportunity-finder'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_active_profile()
);

drop policy if exists opportunity_finder_storage_delete_own on storage.objects;
create policy opportunity_finder_storage_delete_own
on storage.objects
for delete to authenticated
using (
  bucket_id = 'opportunity-finder'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1
    from public.opportunity_finder_files file
    where file.storage_bucket = bucket_id
      and file.storage_path = name
      and public.can_access_opportunity_finder_job(file.job_id, file.tenant_id)
  )
);

-- ---------------------------------------------------------------------------
-- Fenced worker claim and deterministic entity materialization.
-- ---------------------------------------------------------------------------

create or replace function public.claim_opportunity_finder_job(
  worker_id_input text,
  stale_after interval default interval '30 minutes'
)
returns setof public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if nullif(trim(worker_id_input), '') is null or length(worker_id_input) > 200 then
    raise exception using errcode = '22023', message = 'invalid_worker_id';
  end if;

  if stale_after < interval '1 minute' or stale_after > interval '24 hours' then
    raise exception using errcode = '22023', message = 'invalid_stale_after';
  end if;

  return query
  with recovered as (
    update public.opportunity_finder_jobs stale_job
    set
      status = case
        when stale_job.cancel_requested then 'cancelled'
        when stale_job.attempts >= stale_job.max_attempts then 'failed'
        else 'queued'
      end,
      error_code = case
        when stale_job.cancel_requested then 'JOB_CANCELLED'
        when stale_job.attempts >= stale_job.max_attempts then 'WORKER_HEARTBEAT_EXPIRED'
        else null
      end,
      cancelled_at = case
        when stale_job.cancel_requested then coalesce(stale_job.cancelled_at, now())
        else stale_job.cancelled_at
      end,
      locked_at = null,
      locked_by = null,
      lock_token = null,
      heartbeat_at = null,
      next_retry_at = case
        when stale_job.cancel_requested or stale_job.attempts >= stale_job.max_attempts then null
        else now()
      end,
      updated_at = now()
    where stale_job.status in ('profiling', 'parsing', 'matching')
      and coalesce(stale_job.heartbeat_at, stale_job.locked_at, stale_job.updated_at)
          < now() - stale_after
    returning
      stale_job.id,
      stale_job.tenant_id,
      stale_job.created_by,
      stale_job.status,
      stale_job.processing_fence
  ),
  recovery_audit as (
    insert into public.opportunity_finder_audit_events (
      tenant_id,
      job_id,
      actor_user_id,
      event_type,
      entity_type,
      entity_id,
      safe_metadata
    )
    select
      recovered.tenant_id,
      recovered.id,
      recovered.created_by,
      case
        when recovered.status = 'cancelled' then 'job_cancelled_after_worker_expiry'
        else 'worker_heartbeat_expired'
      end,
      'opportunity_finder_job',
      recovered.id,
      jsonb_build_object(
        'recoveredStatus', recovered.status,
        'processingFence', recovered.processing_fence
      )
    from recovered
    returning job_id
  ),
  next_job as (
    select queued_job.id
    from public.opportunity_finder_jobs queued_job
    where queued_job.status = 'queued'
      and queued_job.attempts < queued_job.max_attempts
      and queued_job.cancel_requested = false
      and (queued_job.next_retry_at is null or queued_job.next_retry_at <= now())
    order by queued_job.created_at asc, queued_job.id asc
    for update skip locked
    limit 1
  )
  update public.opportunity_finder_jobs claimed_job
  set
    status = case
      when claimed_job.current_stage in ('inspecting_sheets', 'detecting_headers') then 'profiling'
      else 'parsing'
    end,
    attempts = claimed_job.attempts + 1,
    processing_fence = claimed_job.processing_fence + 1,
    lock_token = gen_random_uuid(),
    locked_at = now(),
    locked_by = worker_id_input,
    heartbeat_at = now(),
    started_at = coalesce(claimed_job.started_at, now()),
    error_code = null,
    updated_at = now()
  from next_job
  where claimed_job.id = next_job.id
  returning claimed_job.*;
end;
$$;

revoke all on function public.claim_opportunity_finder_job(text, interval) from public, anon, authenticated;
grant execute on function public.claim_opportunity_finder_job(text, interval) to service_role;

create or replace function public.reset_opportunity_finder_job_attempt(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  processing_fence bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_processing_fence alias for $4;
  locked_job public.opportunity_finder_jobs%rowtype;
begin
  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.processing_fence is distinct from input_processing_fence then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_resettable';
  end if;

  -- One lock and one transaction cover every retry cleanup. This closes the
  -- check/delete race that exists when a worker heartbeats and then issues
  -- independent table DELETE statements through PostgREST.
  delete from public.opportunity_finder_allocations allocation
  where allocation.job_id = input_job_id;
  delete from public.opportunity_finder_result_commercials commercial
  where commercial.job_id = input_job_id;
  delete from public.opportunity_finder_result_financials financial
  where financial.job_id = input_job_id;
  delete from public.opportunity_finder_results result
  where result.job_id = input_job_id;
  delete from public.opportunity_finder_possible_matches candidate
  where candidate.job_id = input_job_id;
  delete from public.opportunity_finder_rejected_rows rejected
  where rejected.job_id = input_job_id;
  delete from public.opportunity_finder_historical_signals signal
  where signal.job_id = input_job_id;
  delete from public.opportunity_finder_demand_part_options option_row
  where option_row.job_id = input_job_id;
  delete from public.opportunity_finder_demand_events event_row
  where event_row.job_id = input_job_id;
  delete from public.opportunity_finder_supply_lots lot
  where lot.job_id = input_job_id;
  delete from public.opportunity_finder_rows row_data
  where row_data.job_id = input_job_id;

  update public.opportunity_finder_jobs job
  set processed_rows = 0,
      matched_mpns = 0,
      result_count = 0,
      warning_count = 0,
      missing_mpn_rows = 0,
      invalid_quantity_rows = 0,
      summary_json = '{}'::jsonb,
      materialized_lock_token = null,
      materialized_at = null,
      output_commit_key = null,
      committed_fence = null,
      committed_lock_token = null,
      heartbeat_at = now(),
      updated_at = now()
  where job.id = input_job_id;

  insert into public.opportunity_finder_audit_events (
    tenant_id,
    job_id,
    actor_user_id,
    event_type,
    entity_type,
    entity_id,
    safe_metadata
  )
  values (
    locked_job.tenant_id,
    locked_job.id,
    locked_job.created_by,
    'job_attempt_reset',
    'opportunity_finder_job',
    locked_job.id,
    jsonb_build_object('processingFence', input_processing_fence)
  );
end;
$$;

revoke all on function public.reset_opportunity_finder_job_attempt(
  uuid, text, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.reset_opportunity_finder_job_attempt(
  uuid, text, uuid, bigint
) to service_role;

create or replace function public.materialize_opportunity_finder_entities(
  job_id uuid,
  worker_id text,
  lock_token uuid
)
returns table (
  demand_event_count integer,
  demand_part_option_count integer,
  supply_lot_count integer,
  historical_signal_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  locked_job public.opportunity_finder_jobs%rowtype;
begin
  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_materializable';
  end if;

  if (select count(*) from public.opportunity_finder_files file where file.job_id = input_job_id) <> 2 then
    raise exception using errcode = '23514', message = 'opportunity_requires_exactly_two_files';
  end if;

  if exists (
    select 1
    from public.opportunity_finder_files file
    where file.job_id = input_job_id
      and (
        file.validation_status <> 'verified'
        or file.content_sha256 is null
        or file.actual_size_bytes is null
      )
  ) then
    raise exception using errcode = '23514', message = 'opportunity_file_not_verified';
  end if;

  -- An attempt owns one complete derived snapshot. Clearing and rebuilding is
  -- atomic inside this RPC, so retries cannot mix rows from two attempts.
  delete from public.opportunity_finder_results result
  where result.job_id = input_job_id;
  delete from public.opportunity_finder_possible_matches candidate
  where candidate.job_id = input_job_id;
  delete from public.opportunity_finder_historical_signals signal
  where signal.job_id = input_job_id;
  delete from public.opportunity_finder_demand_part_options option_row
  where option_row.job_id = input_job_id;
  delete from public.opportunity_finder_demand_events event_row
  where event_row.job_id = input_job_id;
  delete from public.opportunity_finder_supply_lots lot
  where lot.job_id = input_job_id;

  with demand_source as (
    select
      row_data.*,
      coalesce(
        nullif(trim(row_data.demand_event_key), ''),
        concat_ws(
          chr(31),
          row_data.normalized_mpn,
          coalesce(
            nullif(btrim(regexp_replace(row_data.customer_context, '[[:space:]]+', ' ', 'g')), ''),
            nullif(btrim(regexp_replace(locked_job.client_context, '[[:space:]]+', ' ', 'g')), ''),
            ''
          ),
          coalesce(row_data.required_date::text, ''),
          coalesce(row_data.unit_of_measure, '')
        )
      ) as materialized_event_key
    from public.opportunity_finder_rows row_data
    where row_data.job_id = input_job_id
      and row_data.ingestion_lock_token = input_lock_token
      and row_data.ingestion_fence = locked_job.processing_fence
      and row_data.record_role = 'demand'
      and row_data.is_active_demand = true
  ),
  grouped_demand as (
    select
      source.materialized_event_key,
      min(source.file_id::text)::uuid as file_id,
      max(source.snapshot_key) as snapshot_key,
      max(source.demand_event_source_id) as source_event_id,
      max(source.template_type) as template_type,
      coalesce(
        max(nullif(btrim(regexp_replace(source.customer_context, '[[:space:]]+', ' ', 'g')), '')),
        nullif(btrim(regexp_replace(locked_job.client_context, '[[:space:]]+', ' ', 'g')), '')
      ) as client_context,
      max(source.client_item) as client_item,
      max(source.plant_facility) as plant_facility,
      max(source.end_customer) as end_customer,
      case
        when bool_or(nullif(trim(source.demand_event_key), '') is not null)
          then max(abs(source.required_qty))
        else sum(abs(source.required_qty))
      end as required_qty,
      min(source.required_date) as required_date,
      case
        when bool_or(source.required_date_quality = 'ambiguous') then 'ambiguous'
        when bool_or(source.required_date_quality = 'valid') then 'valid'
        when bool_or(source.required_date_quality = 'not_applicable') then 'not_applicable'
        else 'missing'
      end as required_date_quality,
      max(source.unit_of_measure) as unit_of_measure,
      max(source.target_price) as target_price,
      max(source.target_currency) as target_currency,
      min(source.original_index)::bigint as deterministic_order,
      jsonb_agg(
        jsonb_build_object(
          'fileId', source.file_id,
          'sheetName', source.sheet_name,
          'sourceRow', source.source_row,
          'hidden', source.source_row_hidden,
          'headerRow', source.header_row,
          'columns', source.source_columns,
          'cellRefs', source.source_cell_refs
        )
        order by source.original_index, source.source_row
      ) as source_trace,
      jsonb_agg(source.quality_flags order by source.original_index) as quality_flags
    from demand_source source
    group by source.materialized_event_key
    having max(abs(source.required_qty)) > 0
  )
  insert into public.opportunity_finder_demand_events (
    tenant_id,
    job_id,
    file_id,
    event_key,
    snapshot_key,
    source_event_id,
    template_type,
    client_context,
    client_item,
    plant_facility,
    end_customer,
    required_qty,
    allocated_qty,
    remaining_qty,
    required_date,
    required_date_quality,
    unit_of_measure,
    target_price,
    target_currency,
    is_active,
    deterministic_order,
    source_trace,
    quality_flags
  )
  select
    locked_job.tenant_id,
    input_job_id,
    grouped.file_id,
    grouped.materialized_event_key,
    grouped.snapshot_key,
    grouped.source_event_id,
    grouped.template_type,
    grouped.client_context,
    grouped.client_item,
    grouped.plant_facility,
    grouped.end_customer,
    grouped.required_qty,
    0,
    grouped.required_qty,
    grouped.required_date,
    grouped.required_date_quality,
    grouped.unit_of_measure,
    grouped.target_price,
    grouped.target_currency,
    true,
    grouped.deterministic_order,
    grouped.source_trace,
    grouped.quality_flags
  from grouped_demand grouped
  order by grouped.deterministic_order, grouped.materialized_event_key;

  with demand_source as (
    select
      row_data.*,
      coalesce(
        nullif(trim(row_data.demand_event_key), ''),
        concat_ws(
          chr(31),
          row_data.normalized_mpn,
          coalesce(
            nullif(btrim(regexp_replace(row_data.customer_context, '[[:space:]]+', ' ', 'g')), ''),
            nullif(btrim(regexp_replace(locked_job.client_context, '[[:space:]]+', ' ', 'g')), ''),
            ''
          ),
          coalesce(row_data.required_date::text, ''),
          coalesce(row_data.unit_of_measure, '')
        )
      ) as materialized_event_key
    from public.opportunity_finder_rows row_data
    where row_data.job_id = input_job_id
      and row_data.ingestion_lock_token = input_lock_token
      and row_data.ingestion_fence = locked_job.processing_fence
      and row_data.record_role = 'demand'
      and row_data.is_active_demand = true
      and nullif(trim(row_data.normalized_mpn), '') is not null
  ),
  numbered_options as (
    select
      source.*,
      row_number() over (
        partition by source.materialized_event_key
        order by
          coalesce(source.option_ordinal, 2147483647),
          source.original_index,
          source.source_row,
          source.id
      )::integer as materialized_ordinal
    from demand_source source
  )
  insert into public.opportunity_finder_demand_part_options (
    tenant_id,
    job_id,
    demand_event_id,
    file_id,
    raw_mpn,
    display_mpn,
    exact_norm,
    search_norm,
    manufacturer_original,
    manufacturer_canonical,
    manufacturer_alias_version,
    unit_of_measure,
    option_ordinal,
    is_primary_option,
    is_approved_alternate,
    source_trace,
    quality_flags
  )
  select
    locked_job.tenant_id,
    input_job_id,
    event_row.id,
    option_row.file_id,
    option_row.raw_mpn,
    option_row.display_mpn,
    option_row.normalized_mpn,
    option_row.review_key,
    option_row.manufacturer,
    option_row.manufacturer_canonical,
    option_row.manufacturer_alias_version,
    option_row.unit_of_measure,
    option_row.materialized_ordinal,
    coalesce(option_row.is_primary_option, option_row.materialized_ordinal = 1),
    coalesce(option_row.is_approved_alternate, false),
    jsonb_build_object(
      'fileId', option_row.file_id,
      'sheetName', option_row.sheet_name,
      'sourceRow', option_row.source_row,
      'originalIndex', option_row.original_index,
      'optionOrdinal', option_row.materialized_ordinal,
      'hidden', option_row.source_row_hidden,
      'headerRow', option_row.header_row,
      'columns', option_row.source_columns,
      'cellRefs', option_row.source_cell_refs
    ),
    option_row.quality_flags
  from numbered_options option_row
  join public.opportunity_finder_demand_events event_row
    on event_row.job_id = input_job_id
   and event_row.event_key = option_row.materialized_event_key
  order by event_row.deterministic_order, option_row.materialized_ordinal;

  with supply_source as (
    select
      row_data.*,
      coalesce(
        nullif(trim(row_data.supply_lot_key), ''),
        encode(
          digest(
            concat_ws(
              '|',
              row_data.file_id::text,
              row_data.sheet_name,
              row_data.source_row::text,
              row_data.original_index::text,
              row_data.normalized_mpn
            ),
            'sha256'
          ),
          'hex'
        )
      ) as materialized_lot_key,
      coalesce(row_data.available_qty, row_data.excess_qty) as materialized_available_qty,
      row_number() over (
        partition by coalesce(
          nullif(trim(row_data.supply_lot_key), ''),
          encode(
            digest(
              concat_ws(
                '|',
                row_data.file_id::text,
                row_data.sheet_name,
                row_data.source_row::text,
                row_data.original_index::text,
                row_data.normalized_mpn
              ),
              'sha256'
            ),
            'hex'
          )
        )
        order by row_data.original_index, row_data.source_row, row_data.id
      ) as lot_duplicate_rank
    from public.opportunity_finder_rows row_data
    where row_data.job_id = input_job_id
      and row_data.ingestion_lock_token = input_lock_token
      and row_data.ingestion_fence = locked_job.processing_fence
      and row_data.record_role in ('stock', 'excess', 'supplier_offer')
      and coalesce(row_data.available_qty, row_data.excess_qty) > 0
      and nullif(trim(row_data.normalized_mpn), '') is not null
  )
  insert into public.opportunity_finder_supply_lots (
    tenant_id,
    job_id,
    file_id,
    lot_key,
    supply_role,
    raw_mpn,
    display_mpn,
    exact_norm,
    search_norm,
    manufacturer_original,
    manufacturer_canonical,
    manufacturer_alias_version,
    supplier_context,
    available_qty,
    allocated_qty,
    remaining_qty,
    unit_of_measure,
    offer_price,
    unit_cost,
    currency,
    currency_status,
    moq,
    spq,
    date_code,
    coo,
    lead_time_weeks,
    transit_time_weeks,
    condition,
    expires_at,
    is_live_supply,
    deterministic_order,
    source_trace,
    quality_flags
  )
  select
    locked_job.tenant_id,
    input_job_id,
    supply.file_id,
    supply.materialized_lot_key,
    supply.record_role,
    supply.raw_mpn,
    supply.display_mpn,
    supply.normalized_mpn,
    supply.review_key,
    supply.manufacturer,
    supply.manufacturer_canonical,
    supply.manufacturer_alias_version,
    supply.supplier_context,
    supply.materialized_available_qty,
    0,
    supply.materialized_available_qty,
    supply.unit_of_measure,
    supply.offer_price,
    supply.unit_cost,
    supply.currency,
    supply.currency_status,
    supply.moq,
    supply.spq,
    supply.date_code,
    supply.coo,
    supply.lead_time_weeks,
    supply.transit_time_weeks,
    supply.condition,
    supply.expires_at,
    case
      when supply.record_role = 'supplier_offer' then
        supply.expires_at is not null
        and supply.expires_at > now()
        and coalesce(supply.is_live_supply, true)
      else coalesce(
        supply.is_live_supply,
        supply.record_role in ('stock', 'excess'),
        false
      )
    end,
    supply.original_index::bigint,
    jsonb_build_object(
      'fileId', supply.file_id,
      'sheetName', supply.sheet_name,
      'sourceRow', supply.source_row,
      'originalIndex', supply.original_index,
      'hidden', supply.source_row_hidden,
      'headerRow', supply.header_row,
      'columns', supply.source_columns,
      'cellRefs', supply.source_cell_refs
    ),
    supply.quality_flags
  from supply_source supply
  where supply.lot_duplicate_rank = 1
  order by supply.original_index, supply.materialized_lot_key;

  with historical_source as (
    select
      row_data.*,
      encode(
        digest(
          concat_ws(
            '|',
            row_data.file_id::text,
            row_data.sheet_name,
            row_data.source_row::text,
            row_data.original_index::text,
            row_data.normalized_mpn,
            row_data.record_role
          ),
          'sha256'
        ),
        'hex'
      ) as materialized_signal_key
    from public.opportunity_finder_rows row_data
    where row_data.job_id = input_job_id
      and row_data.ingestion_lock_token = input_lock_token
      and row_data.ingestion_fence = locked_job.processing_fence
      and row_data.record_role in (
        'received_history', 'purchase_history', 'quote_history', 'sales_history'
      )
      and nullif(trim(row_data.normalized_mpn), '') is not null
  )
  insert into public.opportunity_finder_historical_signals (
    tenant_id,
    job_id,
    file_id,
    signal_key,
    signal_role,
    raw_mpn,
    display_mpn,
    exact_norm,
    search_norm,
    manufacturer_original,
    manufacturer_canonical,
    observed_qty,
    observed_price,
    currency,
    observed_at,
    source_trace,
    quality_flags
  )
  select
    locked_job.tenant_id,
    input_job_id,
    signal.file_id,
    signal.materialized_signal_key,
    signal.record_role,
    signal.raw_mpn,
    signal.display_mpn,
    signal.normalized_mpn,
    signal.review_key,
    signal.manufacturer,
    signal.manufacturer_canonical,
    coalesce(signal.available_qty, signal.required_qty, signal.excess_qty),
    coalesce(signal.offer_price, signal.target_price, signal.unit_cost),
    coalesce(signal.currency, signal.target_currency),
    signal.required_date,
    jsonb_build_object(
      'fileId', signal.file_id,
      'sheetName', signal.sheet_name,
      'sourceRow', signal.source_row,
      'hidden', signal.source_row_hidden,
      'headerRow', signal.header_row,
      'columns', signal.source_columns,
      'cellRefs', signal.source_cell_refs
    ),
    signal.quality_flags
  from historical_source signal
  order by signal.original_index, signal.materialized_signal_key;

  update public.opportunity_finder_jobs job
  set
    materialized_lock_token = input_lock_token,
    materialized_at = now(),
    output_commit_key = null,
    committed_fence = null,
    committed_lock_token = null,
    updated_at = now()
  where job.id = input_job_id;

  insert into public.opportunity_finder_audit_events (
    tenant_id,
    job_id,
    actor_user_id,
    event_type,
    entity_type,
    entity_id,
    safe_metadata
  )
  values (
    locked_job.tenant_id,
    input_job_id,
    locked_job.created_by,
    'entities_materialized',
    'opportunity_finder_job',
    input_job_id,
    jsonb_build_object(
      'processingFence', locked_job.processing_fence,
      'attempt', locked_job.attempts
    )
  );

  return query
  select
    (select count(*)::integer from public.opportunity_finder_demand_events event_row where event_row.job_id = input_job_id),
    (select count(*)::integer from public.opportunity_finder_demand_part_options option_row where option_row.job_id = input_job_id),
    (select count(*)::integer from public.opportunity_finder_supply_lots lot where lot.job_id = input_job_id),
    (select count(*)::integer from public.opportunity_finder_historical_signals signal where signal.job_id = input_job_id);
end;
$$;

revoke all on function public.materialize_opportunity_finder_entities(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.materialize_opportunity_finder_entities(uuid, text, uuid)
  to service_role;

-- Resolve the actual option/lot identity at the database boundary. Neither a
-- client-provided match_tier nor review_status participates in this decision.
-- Catalog aliases/equivalences count only when both the entry and its human-
-- approved version are currently active.
create or replace function public.normalize_opportunity_manufacturer_exact(input_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select nullif(
    btrim(regexp_replace(upper(normalize(coalesce(input_value, ''), NFKC)), '[[:space:]]+', ' ', 'g')),
    ''
  );
$$;

revoke all on function public.normalize_opportunity_manufacturer_exact(text)
  from public, anon, authenticated;
grant execute on function public.normalize_opportunity_manufacturer_exact(text)
  to service_role;

create or replace function public.normalize_opportunity_unit_of_measure(input_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select nullif(
    btrim(regexp_replace(
      upper(normalize(coalesce(input_value, ''), NFKC)),
      '[[:space:]]+', ' ', 'g'
    )),
    ''
  );
$$;

revoke all on function public.normalize_opportunity_unit_of_measure(text)
  from public, anon, authenticated;
grant execute on function public.normalize_opportunity_unit_of_measure(text)
  to service_role;

-- candidate_key is a SHA-256 hex digest in the worker. Convert its first
-- 128 bits exactly like deterministicUuidFromHex(): force version 5 and the
-- RFC 4122 variant while preserving every other bit. Non-hex legacy keys are
-- hashed once so replacements still receive a stable durable identity.
create or replace function public.opportunity_finder_candidate_uuid(candidate_key text)
returns uuid
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  with normalized as (
    select nullif(lower(btrim($1)), '') as key_value
  ),
  identity_hex as (
    select case
      when key_value ~ '^[0-9a-f]{64}$' then key_value
      when key_value is not null then encode(digest(key_value, 'sha256'), 'hex')
      else null
    end as value
    from normalized
  )
  select case when value is null then null else concat(
    substr(value, 1, 8), '-',
    substr(value, 9, 4), '-',
    '5', substr(value, 14, 3), '-',
    lpad(to_hex((get_byte(decode(substr(value, 17, 2), 'hex'), 0) & 63) | 128), 2, '0'),
    substr(value, 19, 2), '-',
    substr(value, 21, 12)
  )::uuid end
  from identity_hex;
$$;

revoke all on function public.opportunity_finder_candidate_uuid(text)
  from public, anon, authenticated;
grant execute on function public.opportunity_finder_candidate_uuid(text)
  to service_role;

create or replace function public.opportunity_finder_allocation_identity_kind(
  tenant_id uuid,
  job_id uuid,
  demand_part_option_id uuid,
  supply_lot_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with pair as (
    select
      option_row.exact_norm as option_exact_norm,
      lot.exact_norm as lot_exact_norm,
      public.normalize_opportunity_manufacturer_exact(
        coalesce(option_row.manufacturer_original, option_row.manufacturer_canonical)
      ) as option_manufacturer_norm,
      public.normalize_opportunity_manufacturer_exact(
        coalesce(lot.manufacturer_original, lot.manufacturer_canonical)
      ) as lot_manufacturer_norm,
      public.normalize_opportunity_unit_of_measure(
        coalesce(option_row.unit_of_measure, event_row.unit_of_measure)
      ) as option_unit_norm,
      public.normalize_opportunity_unit_of_measure(lot.unit_of_measure) as lot_unit_norm
    from public.opportunity_finder_demand_part_options option_row
    join public.opportunity_finder_demand_events event_row
      on event_row.id = option_row.demand_event_id
     and event_row.job_id = option_row.job_id
     and event_row.tenant_id = option_row.tenant_id
    join public.opportunity_finder_supply_lots lot
      on lot.id = $4
     and lot.job_id = $2
     and lot.tenant_id = $1
    where option_row.id = $3
      and option_row.job_id = $2
      and option_row.tenant_id = $1
  ),
  approved_manufacturer_alias as (
    select true as matched
    from pair identity_pair
    join public.opportunity_finder_manufacturer_registry_versions version_row
      on version_row.tenant_id = $1
     and version_row.status = 'active'
     and version_row.approved_by is not null
     and version_row.approved_at is not null
    join public.opportunity_finder_manufacturers manufacturer
      on manufacturer.version_id = version_row.id
     and manufacturer.tenant_id = version_row.tenant_id
     and manufacturer.status = 'active'
    where (
      identity_pair.option_manufacturer_norm =
        public.normalize_opportunity_manufacturer_exact(manufacturer.normalized_name)
      or exists (
        select 1
        from public.opportunity_finder_manufacturer_aliases alias_row
        where alias_row.version_id = version_row.id
          and alias_row.tenant_id = version_row.tenant_id
          and alias_row.manufacturer_id = manufacturer.id
          and alias_row.approval_status = 'approved'
          and alias_row.approved_by is not null
          and alias_row.decided_at is not null
          and public.normalize_opportunity_manufacturer_exact(alias_row.alias_normalized) =
            identity_pair.option_manufacturer_norm
      )
    )
      and (
        identity_pair.lot_manufacturer_norm =
          public.normalize_opportunity_manufacturer_exact(manufacturer.normalized_name)
        or exists (
          select 1
          from public.opportunity_finder_manufacturer_aliases alias_row
          where alias_row.version_id = version_row.id
            and alias_row.tenant_id = version_row.tenant_id
            and alias_row.manufacturer_id = manufacturer.id
            and alias_row.approval_status = 'approved'
            and alias_row.approved_by is not null
            and alias_row.decided_at is not null
            and public.normalize_opportunity_manufacturer_exact(alias_row.alias_normalized) =
              identity_pair.lot_manufacturer_norm
        )
      )
    limit 1
  ),
  approved_part_equivalence as (
    select true as matched
    from pair identity_pair
    join public.opportunity_finder_part_equivalence_versions version_row
      on version_row.tenant_id = $1
     and version_row.status = 'active'
     and version_row.approved_by is not null
     and version_row.approved_at is not null
    join public.opportunity_finder_part_equivalences equivalence
      on equivalence.version_id = version_row.id
     and equivalence.tenant_id = version_row.tenant_id
     and equivalence.approval_status = 'approved'
     and equivalence.approved_by is not null
     and equivalence.decided_at is not null
     and equivalence.requires_review = true
    where (
      equivalence.from_exact_norm = identity_pair.option_exact_norm
      and equivalence.to_exact_norm = identity_pair.lot_exact_norm
      and (
        equivalence.from_manufacturer_normalized is null
        or public.normalize_opportunity_manufacturer_exact(
          equivalence.from_manufacturer_normalized
        ) = identity_pair.option_manufacturer_norm
      )
      and (
        equivalence.to_manufacturer_normalized is null
        or public.normalize_opportunity_manufacturer_exact(
          equivalence.to_manufacturer_normalized
        ) = identity_pair.lot_manufacturer_norm
      )
    ) or (
      equivalence.to_exact_norm = identity_pair.option_exact_norm
      and equivalence.from_exact_norm = identity_pair.lot_exact_norm
      and (
        equivalence.to_manufacturer_normalized is null
        or public.normalize_opportunity_manufacturer_exact(
          equivalence.to_manufacturer_normalized
        ) = identity_pair.option_manufacturer_norm
      )
      and (
        equivalence.from_manufacturer_normalized is null
        or public.normalize_opportunity_manufacturer_exact(
          equivalence.from_manufacturer_normalized
        ) = identity_pair.lot_manufacturer_norm
      )
    )
    limit 1
  )
  select case
    when identity_pair.option_unit_norm is not null
      and identity_pair.lot_unit_norm is not null
      and identity_pair.option_unit_norm <> identity_pair.lot_unit_norm
      then null
    when identity_pair.option_exact_norm = identity_pair.lot_exact_norm
      and identity_pair.option_manufacturer_norm is not null
      and identity_pair.option_manufacturer_norm = identity_pair.lot_manufacturer_norm
      then 'exact_mpn_mfg'
    when identity_pair.option_exact_norm = identity_pair.lot_exact_norm
      and (
        identity_pair.option_manufacturer_norm is null
        or identity_pair.lot_manufacturer_norm is null
      )
      then 'exact_mpn_mfg_missing'
    when identity_pair.option_exact_norm = identity_pair.lot_exact_norm
      and exists (select 1 from approved_manufacturer_alias)
      then 'exact_mpn_approved_alias'
    when exists (select 1 from approved_part_equivalence)
      then 'approved_part_equivalence'
    else null
  end
  from pair identity_pair;
$$;

revoke all on function public.opportunity_finder_allocation_identity_kind(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.opportunity_finder_allocation_identity_kind(
  uuid, uuid, uuid, uuid
) to service_role;

create or replace function public.has_approved_opportunity_finder_allocation_review(
  job_id uuid,
  result_id uuid,
  demand_part_option_id uuid,
  supply_lot_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.opportunity_finder_results result
    join public.opportunity_finder_review_decisions decision
      on decision.job_id = result.job_id
     and decision.tenant_id = result.tenant_id
     and decision.decision = 'approved'
     and decision.reviewer_id is not null
     and decision.decided_at is not null
    where result.id = $2
      and result.job_id = $1
      and (
        (
          decision.entity_type = 'result'
          and decision.entity_id = result.id
        )
        or (
          decision.entity_type = 'possible_match'
          and result.candidate_id is not null
          and decision.entity_id = result.candidate_id
          and exists (
            select 1
            from public.opportunity_finder_possible_matches candidate
            where candidate.id = result.candidate_id
              and candidate.job_id = result.job_id
              and candidate.tenant_id = result.tenant_id
              and candidate.demand_option_id = $3
              and candidate.supply_lot_id = $4
          )
        )
      )
  );
$$;

revoke all on function public.has_approved_opportunity_finder_allocation_review(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.has_approved_opportunity_finder_allocation_review(
  uuid, uuid, uuid, uuid
) to service_role;

create or replace function public.commit_opportunity_finder_allocations(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  allocations jsonb
)
returns table (
  allocation_count integer,
  allocated_qty numeric
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_allocations alias for $4;
  locked_job public.opportunity_finder_jobs%rowtype;
  allocation_input record;
  existing_allocation public.opportunity_finder_allocations%rowtype;
  target_result public.opportunity_finder_results%rowtype;
  target_event public.opportunity_finder_demand_events%rowtype;
  target_option public.opportunity_finder_demand_part_options%rowtype;
  target_lot public.opportunity_finder_supply_lots%rowtype;
  allocation_identity_kind text;
  allocation_requires_review boolean;
  requested_qty numeric;
  quantity_to_reserve numeric;
  committed_count integer := 0;
  committed_qty numeric := 0;
begin
  if input_allocations is null or jsonb_typeof(input_allocations) <> 'array' then
    raise exception using errcode = '22023', message = 'allocations_must_be_json_array';
  end if;

  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.materialized_lock_token is distinct from input_lock_token then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_allocatable';
  end if;

  for allocation_input in
    select parsed.*
    from jsonb_to_recordset(input_allocations) as parsed(
      allocation_key text,
      result_id uuid,
      demand_event_id uuid,
      demand_event_key text,
      demand_part_option_id uuid,
      supply_lot_id uuid,
      supply_lot_key text,
      allocated_qty numeric,
      reserved_qty numeric,
      deterministic_rank bigint,
      decision_trace jsonb,
      supply_trace jsonb
    )
    order by
      coalesce(parsed.deterministic_rank, 0),
      coalesce(parsed.supply_lot_key, parsed.supply_lot_id::text),
      parsed.allocation_key
  loop
    if nullif(trim(allocation_input.allocation_key), '') is null
       or length(allocation_input.allocation_key) > 240 then
      raise exception using errcode = '22023', message = 'invalid_allocation_key';
    end if;

    if allocation_input.result_id is null then
      raise exception using errcode = '22023', message = 'allocation_result_required';
    end if;

    if allocation_input.demand_part_option_id is null then
      raise exception using errcode = '22023', message = 'allocation_demand_option_required';
    end if;

    requested_qty := allocation_input.allocated_qty;
    quantity_to_reserve := coalesce(allocation_input.reserved_qty, requested_qty);

    if requested_qty is null or requested_qty <= 0
       or quantity_to_reserve < requested_qty then
      raise exception using errcode = '22023', message = 'invalid_allocation_quantity';
    end if;

    select existing.*
    into existing_allocation
    from public.opportunity_finder_allocations existing
    where existing.job_id = input_job_id
      and existing.allocation_key = allocation_input.allocation_key;

    if found then
      if existing_allocation.result_id is distinct from allocation_input.result_id
         or existing_allocation.allocated_qty is distinct from requested_qty
         or existing_allocation.demand_part_option_id is distinct from allocation_input.demand_part_option_id
         or (
           allocation_input.supply_lot_id is not null
           and existing_allocation.supply_lot_id is distinct from allocation_input.supply_lot_id
         )
         or (
           nullif(trim(allocation_input.supply_lot_key), '') is not null
           and existing_allocation.supply_lot_key is distinct from allocation_input.supply_lot_key
         ) then
        raise exception using errcode = '23505', message = 'allocation_idempotency_conflict';
      end if;

      committed_count := committed_count + 1;
      committed_qty := committed_qty + existing_allocation.allocated_qty;
      continue;
    end if;

    select result.*
    into target_result
    from public.opportunity_finder_results result
    where result.id = allocation_input.result_id
      and result.job_id = input_job_id
      and result.tenant_id = locked_job.tenant_id
    for update;

    if not found then
      raise exception using errcode = '23503', message = 'allocation_result_not_found';
    end if;

    if target_result.opportunity_type not in (
      'full_sale', 'partial_sale', 'excess_resale', 'supplier_offer_match'
    ) then
      raise exception using errcode = '23514', message = 'result_type_not_allocatable';
    end if;

    if allocation_input.demand_event_id is not null then
      select event_row.*
      into target_event
      from public.opportunity_finder_demand_events event_row
      where event_row.id = allocation_input.demand_event_id
        and event_row.job_id = input_job_id
        and event_row.tenant_id = locked_job.tenant_id
      for update;
    elsif nullif(trim(allocation_input.demand_event_key), '') is not null then
      select event_row.*
      into target_event
      from public.opportunity_finder_demand_events event_row
      where event_row.job_id = input_job_id
        and event_row.tenant_id = locked_job.tenant_id
        and event_row.event_key = allocation_input.demand_event_key
      for update;
    else
      raise exception using errcode = '22023', message = 'demand_event_identity_required';
    end if;

    if not found then
      raise exception using errcode = '23503', message = 'demand_event_not_found';
    end if;

    select option_row.*
    into target_option
    from public.opportunity_finder_demand_part_options option_row
    where option_row.id = allocation_input.demand_part_option_id
      and option_row.job_id = input_job_id
      and option_row.tenant_id = locked_job.tenant_id;

    if not found or target_option.demand_event_id <> target_event.id then
      raise exception using errcode = '23503', message = 'demand_option_event_mismatch';
    end if;

    if allocation_input.supply_lot_id is not null then
      select lot.*
      into target_lot
      from public.opportunity_finder_supply_lots lot
      where lot.id = allocation_input.supply_lot_id
        and lot.job_id = input_job_id
        and lot.tenant_id = locked_job.tenant_id
      for update;
    elsif nullif(trim(allocation_input.supply_lot_key), '') is not null then
      select lot.*
      into target_lot
      from public.opportunity_finder_supply_lots lot
      where lot.job_id = input_job_id
        and lot.tenant_id = locked_job.tenant_id
        and lot.lot_key = allocation_input.supply_lot_key
      for update;
    else
      raise exception using errcode = '22023', message = 'supply_lot_identity_required';
    end if;

    if not found then
      raise exception using errcode = '23503', message = 'supply_lot_not_found';
    end if;

    if public.normalize_opportunity_unit_of_measure(
         coalesce(target_option.unit_of_measure, target_event.unit_of_measure)
       ) is not null
       and public.normalize_opportunity_unit_of_measure(target_lot.unit_of_measure) is not null
       and public.normalize_opportunity_unit_of_measure(
         coalesce(target_option.unit_of_measure, target_event.unit_of_measure)
       ) <> public.normalize_opportunity_unit_of_measure(target_lot.unit_of_measure) then
      raise exception using errcode = '23514', message = 'allocation_unit_of_measure_mismatch';
    end if;

    allocation_identity_kind := public.opportunity_finder_allocation_identity_kind(
      locked_job.tenant_id,
      input_job_id,
      target_option.id,
      target_lot.id
    );

    if allocation_identity_kind is null then
      raise exception using errcode = '23514', message = 'allocation_option_lot_identity_mismatch';
    end if;

    -- Missing-manufacturer exact matches retain the explicitly configurable
    -- automatic policy. Aliases, approved part equivalences, search matches and
    -- manufacturer conflicts always require the durable human decision row.
    allocation_requires_review :=
      allocation_identity_kind in ('exact_mpn_approved_alias', 'approved_part_equivalence')
      or target_result.match_tier in (
        'exact_mpn_approved_alias', 'search_mpn_mfg', 'exact_mpn_mfg_conflict'
      );

    if allocation_requires_review
       and not public.has_approved_opportunity_finder_allocation_review(
         input_job_id,
         target_result.id,
         target_option.id,
         target_lot.id
       ) then
      raise exception using errcode = '23514', message = 'durable_review_required_before_allocation';
    end if;

    if not target_lot.is_live_supply
       or (target_lot.expires_at is not null and target_lot.expires_at <= now()) then
      raise exception using errcode = '23514', message = 'supply_lot_not_live';
    end if;

    if requested_qty > target_event.remaining_qty
       or quantity_to_reserve > target_lot.remaining_qty then
      raise exception using errcode = '23514', message = 'allocation_exceeds_remaining_quantity';
    end if;

    if target_lot.moq is not null and quantity_to_reserve < target_lot.moq then
      raise exception using errcode = '23514', message = 'allocation_below_moq';
    end if;

    if target_lot.spq is not null and mod(quantity_to_reserve, target_lot.spq) <> 0 then
      raise exception using errcode = '23514', message = 'allocation_not_spq_multiple';
    end if;

    update public.opportunity_finder_supply_lots lot
    set
      allocated_qty = lot.allocated_qty + quantity_to_reserve,
      remaining_qty = lot.remaining_qty - quantity_to_reserve,
      updated_at = now()
    where lot.id = target_lot.id;

    update public.opportunity_finder_demand_events event_row
    set
      allocated_qty = event_row.allocated_qty + requested_qty,
      remaining_qty = event_row.remaining_qty - requested_qty,
      updated_at = now()
    where event_row.id = target_event.id;

    if target_result.demand_event_id is null then
      update public.opportunity_finder_results result
      set
        demand_event_id = target_event.id,
        demand_event_key = target_event.event_key
      where result.id = target_result.id;
    elsif target_result.demand_event_id <> target_event.id then
      raise exception using errcode = '23514', message = 'result_demand_event_mismatch';
    end if;

    insert into public.opportunity_finder_allocations (
      tenant_id,
      job_id,
      allocation_key,
      result_id,
      demand_event_id,
      demand_part_option_id,
      supply_lot_id,
      supply_lot_key,
      allocated_qty,
      reserved_qty,
      available_before,
      demand_remaining_before,
      supply_remaining_after,
      demand_remaining_after,
      remaining_qty,
      deterministic_rank,
      commit_fence,
      decision_trace,
      supply_trace
    )
    values (
      locked_job.tenant_id,
      input_job_id,
      allocation_input.allocation_key,
      target_result.id,
      target_event.id,
      target_option.id,
      target_lot.id,
      target_lot.lot_key,
      requested_qty,
      quantity_to_reserve,
      target_lot.remaining_qty,
      target_event.remaining_qty,
      target_lot.remaining_qty - quantity_to_reserve,
      target_event.remaining_qty - requested_qty,
      target_lot.remaining_qty - quantity_to_reserve,
      coalesce(allocation_input.deterministic_rank, 0),
      locked_job.processing_fence,
      coalesce(allocation_input.decision_trace, '{}'::jsonb),
      coalesce(allocation_input.supply_trace, target_lot.source_trace)
    );

    committed_count := committed_count + 1;
    committed_qty := committed_qty + requested_qty;
  end loop;

  if exists (
    select 1
    from (
      select distinct parsed.result_id
      from jsonb_to_recordset(input_allocations) as parsed(result_id uuid)
      where parsed.result_id is not null
    ) affected
    join public.opportunity_finder_results result on result.id = affected.result_id
    left join lateral (
      select coalesce(sum(allocation.allocated_qty), 0) as allocated_qty
      from public.opportunity_finder_allocations allocation
      where allocation.result_id = affected.result_id
    ) committed on true
    where result.job_id = input_job_id
      and coalesce(result.allocated_qty, 0) <> committed.allocated_qty
  ) then
    raise exception using errcode = '23514', message = 'result_allocation_total_mismatch';
  end if;

  return query select committed_count, committed_qty;
end;
$$;

revoke all on function public.commit_opportunity_finder_allocations(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.commit_opportunity_finder_allocations(uuid, text, uuid, jsonb)
  to service_role;

-- Final performance-hardened allocation commit. The job row serializes one
-- writer per job; entity rows are additionally locked in deterministic order.
-- The input is resolved and validated as a set, then allocations and aggregate
-- quantity deltas are committed in one PostgreSQL transaction. This supersedes
-- the row-oriented definition above while preserving its public signature.
create or replace function public.commit_opportunity_finder_allocations(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  allocations jsonb
)
returns table (
  allocation_count integer,
  allocated_qty numeric
)
language plpgsql
security definer
set search_path = pg_catalog, public
set work_mem = '32MB'
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_allocations alias for $4;
  locked_job public.opportunity_finder_jobs%rowtype;
  committed_count integer := 0;
  committed_qty numeric := 0;
begin
  if input_allocations is null or jsonb_typeof(input_allocations) <> 'array' then
    raise exception using errcode = '22023', message = 'allocations_must_be_json_array';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(input_allocations) item(payload)
    where jsonb_typeof(item.payload) <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'allocation_item_must_be_json_object';
  end if;

  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.materialized_lock_token is distinct from input_lock_token then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_allocatable';
  end if;

  -- Always recreate the session-local relation. This avoids trusting a temp
  -- object supplied by the caller of this SECURITY DEFINER function and keeps
  -- repeated calls in the same transaction deterministic.
  drop table if exists pg_temp.opportunity_finder_allocation_input;
  create temporary table opportunity_finder_allocation_input (
    input_ordinal bigint primary key,
    allocation_key text,
    result_id uuid,
    input_demand_event_id uuid,
    demand_event_key text,
    demand_part_option_id uuid,
    input_supply_lot_id uuid,
    supply_lot_key text,
    allocated_qty numeric,
    reserved_qty numeric,
    deterministic_rank bigint,
    decision_trace jsonb,
    supply_trace jsonb,
    resolved_event_id uuid,
    resolved_lot_id uuid,
    identity_kind text,
    requires_review boolean not null default false,
    is_existing boolean not null default false
  ) on commit drop;

  insert into opportunity_finder_allocation_input (
    input_ordinal,
    allocation_key,
    result_id,
    input_demand_event_id,
    demand_event_key,
    demand_part_option_id,
    input_supply_lot_id,
    supply_lot_key,
    allocated_qty,
    reserved_qty,
    deterministic_rank,
    decision_trace,
    supply_trace
  )
  select
    item.ordinal,
    parsed.allocation_key,
    parsed.result_id,
    parsed.demand_event_id,
    parsed.demand_event_key,
    parsed.demand_part_option_id,
    parsed.supply_lot_id,
    parsed.supply_lot_key,
    parsed.allocated_qty,
    coalesce(parsed.reserved_qty, parsed.allocated_qty),
    coalesce(parsed.deterministic_rank, 0),
    coalesce(parsed.decision_trace, '{}'::jsonb),
    parsed.supply_trace
  from jsonb_array_elements(input_allocations) with ordinality item(payload, ordinal)
  cross join lateral jsonb_to_record(item.payload) as parsed(
    allocation_key text,
    result_id uuid,
    demand_event_id uuid,
    demand_event_key text,
    demand_part_option_id uuid,
    supply_lot_id uuid,
    supply_lot_key text,
    allocated_qty numeric,
    reserved_qty numeric,
    deterministic_rank bigint,
    decision_trace jsonb,
    supply_trace jsonb
  );

  analyze opportunity_finder_allocation_input;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    where nullif(trim(input_row.allocation_key), '') is null
       or length(input_row.allocation_key) > 240
  ) then
    raise exception using errcode = '22023', message = 'invalid_allocation_key';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    group by input_row.allocation_key
    having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'duplicate_allocation_key_in_payload';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    where input_row.result_id is null
  ) then
    raise exception using errcode = '22023', message = 'allocation_result_required';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    where input_row.demand_part_option_id is null
  ) then
    raise exception using errcode = '22023', message = 'allocation_demand_option_required';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    where input_row.allocated_qty is null
       or input_row.allocated_qty <= 0
       or input_row.reserved_qty is null
       or input_row.reserved_qty < input_row.allocated_qty
       or input_row.deterministic_rank < 0
       or jsonb_typeof(input_row.decision_trace) <> 'object'
       or (
         input_row.supply_trace is not null
         and jsonb_typeof(input_row.supply_trace) <> 'object'
       )
  ) then
    raise exception using errcode = '22023', message = 'invalid_allocation_quantity_or_trace';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    where input_row.input_demand_event_id is null
      and nullif(trim(input_row.demand_event_key), '') is null
  ) then
    raise exception using errcode = '22023', message = 'demand_event_identity_required';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    where input_row.input_supply_lot_id is null
      and nullif(trim(input_row.supply_lot_key), '') is null
  ) then
    raise exception using errcode = '22023', message = 'supply_lot_identity_required';
  end if;

  -- Split UUID and natural-key resolution so the planner can use the matching
  -- unique index for each path. UUIDs can be copied after an indexed ownership
  -- probe; natural keys use their job-scoped unique indexes. This fixes the
  -- target temp table as the outer relation and rules out an O(n^2) loop.
  update opportunity_finder_allocation_input input_row
  set resolved_event_id = input_row.input_demand_event_id
  where input_row.input_demand_event_id is not null
    and exists (
      select 1
      from public.opportunity_finder_demand_events event_row
      where event_row.id = input_row.input_demand_event_id
        and event_row.job_id = input_job_id
        and event_row.tenant_id = locked_job.tenant_id
    );

  update opportunity_finder_allocation_input input_row
  set resolved_event_id = (
    select event_row.id
    from public.opportunity_finder_demand_events event_row
    where event_row.job_id = input_job_id
      and event_row.tenant_id = locked_job.tenant_id
      and event_row.event_key = input_row.demand_event_key
  )
  where input_row.input_demand_event_id is null
    and input_row.demand_event_key is not null;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    where input_row.resolved_event_id is null
  ) then
    raise exception using errcode = '23503', message = 'demand_event_not_found';
  end if;

  update opportunity_finder_allocation_input input_row
  set resolved_lot_id = input_row.input_supply_lot_id
  where input_row.input_supply_lot_id is not null
    and exists (
      select 1
      from public.opportunity_finder_supply_lots lot
      where lot.id = input_row.input_supply_lot_id
        and lot.job_id = input_job_id
        and lot.tenant_id = locked_job.tenant_id
    );

  update opportunity_finder_allocation_input input_row
  set resolved_lot_id = (
    select lot.id
    from public.opportunity_finder_supply_lots lot
    where lot.job_id = input_job_id
      and lot.tenant_id = locked_job.tenant_id
      and lot.lot_key = input_row.supply_lot_key
  )
  where input_row.input_supply_lot_id is null
    and input_row.supply_lot_key is not null;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    where input_row.resolved_lot_id is null
  ) then
    raise exception using errcode = '23503', message = 'supply_lot_not_found';
  end if;

  -- Build indexes only after the resolved columns are populated. Maintaining
  -- empty-column indexes through the bulk UPDATEs creates avoidable dead temp
  -- tuples; fresh statistics also keep all following joins set-based.
  create index opportunity_finder_allocation_input_key_idx
    on opportunity_finder_allocation_input (allocation_key);
  create index opportunity_finder_allocation_input_event_idx
    on opportunity_finder_allocation_input (resolved_event_id);
  create index opportunity_finder_allocation_input_lot_idx
    on opportunity_finder_allocation_input (resolved_lot_id);
  analyze opportunity_finder_allocation_input;

  -- Job lock serializes commits; these ordered row locks also make the lock
  -- order explicit for maintenance functions operating on the same entities.
  perform result.id
  from public.opportunity_finder_results result
  join (
    select distinct input_row.result_id
    from opportunity_finder_allocation_input input_row
  ) target on target.result_id = result.id
  where result.job_id = input_job_id
    and result.tenant_id = locked_job.tenant_id
  order by result.id
  for update of result;

  perform event_row.id
  from public.opportunity_finder_demand_events event_row
  join (
    select distinct input_row.resolved_event_id
    from opportunity_finder_allocation_input input_row
  ) target on target.resolved_event_id = event_row.id
  order by event_row.deterministic_order, event_row.id
  for update of event_row;

  perform lot.id
  from public.opportunity_finder_supply_lots lot
  join (
    select distinct input_row.resolved_lot_id
    from opportunity_finder_allocation_input input_row
  ) target on target.resolved_lot_id = lot.id
  order by lot.deterministic_order, lot.id
  for update of lot;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    left join public.opportunity_finder_results result
      on result.id = input_row.result_id
     and result.job_id = input_job_id
     and result.tenant_id = locked_job.tenant_id
    where result.id is null
  ) then
    raise exception using errcode = '23503', message = 'allocation_result_not_found';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_results result on result.id = input_row.result_id
    where result.opportunity_type not in (
      'full_sale', 'partial_sale', 'excess_resale', 'supplier_offer_match'
    )
  ) then
    raise exception using errcode = '23514', message = 'result_type_not_allocatable';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    left join public.opportunity_finder_demand_part_options option_row
      on option_row.id = input_row.demand_part_option_id
     and option_row.job_id = input_job_id
     and option_row.tenant_id = locked_job.tenant_id
     and option_row.demand_event_id = input_row.resolved_event_id
    where option_row.id is null
  ) then
    raise exception using errcode = '23503', message = 'demand_option_event_mismatch';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_demand_events event_row
      on event_row.id = input_row.resolved_event_id
    where nullif(trim(input_row.demand_event_key), '') is not null
      and input_row.demand_event_key <> event_row.event_key
  ) then
    raise exception using errcode = '23514', message = 'demand_event_identity_conflict';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_supply_lots lot
      on lot.id = input_row.resolved_lot_id
    where nullif(trim(input_row.supply_lot_key), '') is not null
      and input_row.supply_lot_key <> lot.lot_key
  ) then
    raise exception using errcode = '23514', message = 'supply_lot_identity_conflict';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_allocations existing
      on existing.job_id = input_job_id
     and existing.allocation_key = input_row.allocation_key
    where existing.result_id is distinct from input_row.result_id
       or existing.allocated_qty is distinct from input_row.allocated_qty
       or coalesce(existing.reserved_qty, existing.allocated_qty)
          is distinct from input_row.reserved_qty
       or existing.demand_event_id is distinct from input_row.resolved_event_id
       or existing.demand_part_option_id is distinct from input_row.demand_part_option_id
       or existing.supply_lot_id is distinct from input_row.resolved_lot_id
  ) then
    raise exception using errcode = '23505', message = 'allocation_idempotency_conflict';
  end if;

  update opportunity_finder_allocation_input input_row
  set is_existing = true
  from public.opportunity_finder_allocations existing
  where existing.job_id = input_job_id
    and existing.allocation_key = input_row.allocation_key;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_results result on result.id = input_row.result_id
    where result.demand_event_id is not null
      and result.demand_event_id <> input_row.resolved_event_id
  ) or exists (
    select 1
    from opportunity_finder_allocation_input input_row
    group by input_row.result_id
    having count(distinct input_row.resolved_event_id) > 1
  ) then
    raise exception using errcode = '23514', message = 'result_demand_event_mismatch';
  end if;

  update public.opportunity_finder_results result
  set demand_event_id = resolved.event_id,
      demand_event_key = event_row.event_key
  from (
    select input_row.result_id, min(input_row.resolved_event_id::text)::uuid as event_id
    from opportunity_finder_allocation_input input_row
    group by input_row.result_id
  ) resolved
  join public.opportunity_finder_demand_events event_row
    on event_row.id = resolved.event_id
  where result.id = resolved.result_id
    and result.job_id = input_job_id
    and result.demand_event_id is null;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_demand_part_options option_row
      on option_row.id = input_row.demand_part_option_id
     and option_row.demand_event_id = input_row.resolved_event_id
    join public.opportunity_finder_demand_events event_row
      on event_row.id = input_row.resolved_event_id
    join public.opportunity_finder_supply_lots lot
      on lot.id = input_row.resolved_lot_id
    where not input_row.is_existing
      and public.normalize_opportunity_unit_of_measure(
        coalesce(option_row.unit_of_measure, event_row.unit_of_measure)
      ) is not null
      and public.normalize_opportunity_unit_of_measure(lot.unit_of_measure) is not null
      and public.normalize_opportunity_unit_of_measure(
        coalesce(option_row.unit_of_measure, event_row.unit_of_measure)
      ) <> public.normalize_opportunity_unit_of_measure(lot.unit_of_measure)
  ) then
    raise exception using errcode = '23514', message = 'allocation_unit_of_measure_mismatch';
  end if;

  update opportunity_finder_allocation_input input_row
  set identity_kind = case
    when option_row.exact_norm = lot.exact_norm
      and public.normalize_opportunity_manufacturer_exact(
        coalesce(option_row.manufacturer_original, option_row.manufacturer_canonical)
      ) is not null
      and public.normalize_opportunity_manufacturer_exact(
        coalesce(option_row.manufacturer_original, option_row.manufacturer_canonical)
      ) = public.normalize_opportunity_manufacturer_exact(
        coalesce(lot.manufacturer_original, lot.manufacturer_canonical)
      )
      then 'exact_mpn_mfg'
    when option_row.exact_norm = lot.exact_norm
      and (
        public.normalize_opportunity_manufacturer_exact(
          coalesce(option_row.manufacturer_original, option_row.manufacturer_canonical)
        ) is null
        or public.normalize_opportunity_manufacturer_exact(
          coalesce(lot.manufacturer_original, lot.manufacturer_canonical)
        ) is null
      )
      then 'exact_mpn_mfg_missing'
    else public.opportunity_finder_allocation_identity_kind(
      locked_job.tenant_id,
      input_job_id,
      input_row.demand_part_option_id,
      input_row.resolved_lot_id
    )
  end
  from public.opportunity_finder_demand_part_options option_row,
       public.opportunity_finder_supply_lots lot
  where not input_row.is_existing
    and option_row.id = input_row.demand_part_option_id
    and lot.id = input_row.resolved_lot_id;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    where not input_row.is_existing
      and input_row.identity_kind is null
  ) then
    raise exception using errcode = '23514', message = 'allocation_option_lot_identity_mismatch';
  end if;

  update opportunity_finder_allocation_input input_row
  set requires_review = (
    input_row.identity_kind in ('exact_mpn_approved_alias', 'approved_part_equivalence')
    or result.match_tier in (
      'exact_mpn_approved_alias', 'search_mpn_mfg', 'exact_mpn_mfg_conflict'
    )
  )
  from public.opportunity_finder_results result
  where not input_row.is_existing
    and result.id = input_row.result_id;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_results result on result.id = input_row.result_id
    where not input_row.is_existing
      and input_row.requires_review
      and not exists (
        select 1
        from public.opportunity_finder_review_decisions decision
        where decision.job_id = input_job_id
          and decision.tenant_id = locked_job.tenant_id
          and decision.decision = 'approved'
          and decision.reviewer_id is not null
          and decision.decided_at is not null
          and (
            (
              decision.entity_type = 'result'
              and decision.entity_id = result.id
            )
            or (
              decision.entity_type = 'possible_match'
              and result.candidate_id is not null
              and decision.entity_id = result.candidate_id
              and exists (
                select 1
                from public.opportunity_finder_possible_matches candidate
                where candidate.id = result.candidate_id
                  and candidate.job_id = input_job_id
                  and candidate.tenant_id = locked_job.tenant_id
                  and candidate.demand_option_id = input_row.demand_part_option_id
                  and candidate.supply_lot_id = input_row.resolved_lot_id
              )
            )
          )
      )
  ) then
    raise exception using errcode = '23514', message = 'durable_review_required_before_allocation';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_supply_lots lot
      on lot.id = input_row.resolved_lot_id
    where not input_row.is_existing
      and (
        not lot.is_live_supply
        or (lot.expires_at is not null and lot.expires_at <= now())
      )
  ) then
    raise exception using errcode = '23514', message = 'supply_lot_not_live';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_supply_lots lot
      on lot.id = input_row.resolved_lot_id
    where not input_row.is_existing
      and lot.moq is not null
      and input_row.reserved_qty < lot.moq
  ) then
    raise exception using errcode = '23514', message = 'allocation_below_moq';
  end if;

  if exists (
    select 1
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_supply_lots lot
      on lot.id = input_row.resolved_lot_id
    where not input_row.is_existing
      and lot.spq is not null
      and mod(input_row.reserved_qty, lot.spq) <> 0
  ) then
    raise exception using errcode = '23514', message = 'allocation_not_spq_multiple';
  end if;

  if exists (
    select 1
    from (
      select input_row.resolved_event_id, sum(input_row.allocated_qty) as requested_qty
      from opportunity_finder_allocation_input input_row
      where not input_row.is_existing
      group by input_row.resolved_event_id
    ) requested
    join public.opportunity_finder_demand_events event_row
      on event_row.id = requested.resolved_event_id
    where requested.requested_qty > event_row.remaining_qty
  ) or exists (
    select 1
    from (
      select input_row.resolved_lot_id, sum(input_row.reserved_qty) as reserved_qty
      from opportunity_finder_allocation_input input_row
      where not input_row.is_existing
      group by input_row.resolved_lot_id
    ) reserved
    join public.opportunity_finder_supply_lots lot
      on lot.id = reserved.resolved_lot_id
    where reserved.reserved_qty > lot.remaining_qty
  ) then
    raise exception using errcode = '23514', message = 'allocation_exceeds_remaining_quantity';
  end if;

  with ordered as (
    select
      input_row.*,
      lot.lot_key as canonical_lot_key,
      lot.remaining_qty as lot_remaining_before_batch,
      event_row.remaining_qty as event_remaining_before_batch,
      lot.source_trace as canonical_supply_trace,
      sum(input_row.reserved_qty) over (
        partition by input_row.resolved_lot_id
        order by input_row.deterministic_rank, input_row.allocation_key, input_row.input_ordinal
        rows between unbounded preceding and current row
      ) as lot_reserved_through,
      sum(input_row.allocated_qty) over (
        partition by input_row.resolved_event_id
        order by input_row.deterministic_rank, input_row.allocation_key, input_row.input_ordinal
        rows between unbounded preceding and current row
      ) as event_allocated_through
    from opportunity_finder_allocation_input input_row
    join public.opportunity_finder_supply_lots lot
      on lot.id = input_row.resolved_lot_id
    join public.opportunity_finder_demand_events event_row
      on event_row.id = input_row.resolved_event_id
    where not input_row.is_existing
  )
  insert into public.opportunity_finder_allocations (
    tenant_id,
    job_id,
    allocation_key,
    result_id,
    demand_event_id,
    demand_part_option_id,
    supply_lot_id,
    supply_lot_key,
    allocated_qty,
    reserved_qty,
    available_before,
    demand_remaining_before,
    supply_remaining_after,
    demand_remaining_after,
    remaining_qty,
    deterministic_rank,
    commit_fence,
    decision_trace,
    supply_trace
  )
  select
    locked_job.tenant_id,
    input_job_id,
    ordered.allocation_key,
    ordered.result_id,
    ordered.resolved_event_id,
    ordered.demand_part_option_id,
    ordered.resolved_lot_id,
    ordered.canonical_lot_key,
    ordered.allocated_qty,
    ordered.reserved_qty,
    ordered.lot_remaining_before_batch - ordered.lot_reserved_through + ordered.reserved_qty,
    ordered.event_remaining_before_batch - ordered.event_allocated_through + ordered.allocated_qty,
    ordered.lot_remaining_before_batch - ordered.lot_reserved_through,
    ordered.event_remaining_before_batch - ordered.event_allocated_through,
    ordered.lot_remaining_before_batch - ordered.lot_reserved_through,
    ordered.deterministic_rank,
    locked_job.processing_fence,
    ordered.decision_trace || jsonb_build_object(
      'identityKind', ordered.identity_kind,
      'reviewRequired', ordered.requires_review,
      'durableReviewValidated', true
    ),
    coalesce(ordered.supply_trace, ordered.canonical_supply_trace)
  from ordered
  order by ordered.deterministic_rank, ordered.allocation_key, ordered.input_ordinal;

  with totals as (
    select input_row.resolved_lot_id, sum(input_row.reserved_qty) as reserved_qty
    from opportunity_finder_allocation_input input_row
    where not input_row.is_existing
    group by input_row.resolved_lot_id
  )
  update public.opportunity_finder_supply_lots lot
  set allocated_qty = lot.allocated_qty + totals.reserved_qty,
      remaining_qty = lot.remaining_qty - totals.reserved_qty,
      updated_at = now()
  from totals
  where lot.id = totals.resolved_lot_id;

  with totals as (
    select input_row.resolved_event_id, sum(input_row.allocated_qty) as allocated_qty
    from opportunity_finder_allocation_input input_row
    where not input_row.is_existing
    group by input_row.resolved_event_id
  )
  update public.opportunity_finder_demand_events event_row
  set allocated_qty = event_row.allocated_qty + totals.allocated_qty,
      remaining_qty = event_row.remaining_qty - totals.allocated_qty,
      updated_at = now()
  from totals
  where event_row.id = totals.resolved_event_id;

  if exists (
    select 1
    from (
      select distinct input_row.result_id
      from opportunity_finder_allocation_input input_row
    ) affected
    join public.opportunity_finder_results result on result.id = affected.result_id
    left join lateral (
      select coalesce(sum(allocation.allocated_qty), 0) as allocated_qty
      from public.opportunity_finder_allocations allocation
      where allocation.result_id = affected.result_id
    ) committed on true
    where result.job_id = input_job_id
      and coalesce(result.allocated_qty, 0) <> committed.allocated_qty
  ) then
    raise exception using errcode = '23514', message = 'result_allocation_total_mismatch';
  end if;

  select count(*)::integer, coalesce(sum(input_row.allocated_qty), 0)
  into committed_count, committed_qty
  from opportunity_finder_allocation_input input_row;

  return query select committed_count, committed_qty;
end;
$$;

revoke all on function public.commit_opportunity_finder_allocations(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.commit_opportunity_finder_allocations(uuid, text, uuid, jsonb)
  to service_role;

create or replace function public.finalize_opportunity_finder_job(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  commit_key text,
  summary jsonb default '{}'::jsonb,
  warning_count integer default 0,
  missing_mpn_rows integer default 0,
  invalid_quantity_rows integer default 0
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_commit_key alias for $4;
  input_summary alias for $5;
  input_warning_count alias for $6;
  input_missing_mpn_rows alias for $7;
  input_invalid_quantity_rows alias for $8;
  locked_job public.opportunity_finder_jobs%rowtype;
  finalized_job public.opportunity_finder_jobs%rowtype;
  database_result_count integer;
  database_possible_count integer;
begin
  if nullif(trim(input_commit_key), '') is null
     or length(input_commit_key) not between 16 and 240 then
    raise exception using errcode = '22023', message = 'invalid_output_commit_key';
  end if;

  if input_summary is null or jsonb_typeof(input_summary) <> 'object' then
    raise exception using errcode = '22023', message = 'summary_must_be_json_object';
  end if;

  if input_warning_count < 0
     or input_missing_mpn_rows < 0
     or input_invalid_quantity_rows < 0 then
    raise exception using errcode = '22023', message = 'invalid_job_counters';
  end if;

  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  -- Exact replay is a no-op even though the successful commit cleared its lock.
  if locked_job.output_commit_key = input_commit_key
     and locked_job.status in ('completed', 'completed_with_warnings') then
    return locked_job;
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.materialized_lock_token is distinct from input_lock_token then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_finalizable';
  end if;

  -- These checks are deliberately recalculated under the job row lock. They
  -- fence finalization and prove that no allocation reused unavailable units.
  if exists (
    with job_lots as materialized (
      select
        lot.id,
        lot.available_qty,
        lot.allocated_qty,
        lot.remaining_qty
      from public.opportunity_finder_supply_lots lot
      where lot.job_id = input_job_id
    ),
    committed as materialized (
      select
        allocation.supply_lot_id,
        sum(coalesce(allocation.reserved_qty, allocation.allocated_qty)) as reserved_qty
      from public.opportunity_finder_allocations allocation
      where allocation.job_id = input_job_id
      group by allocation.supply_lot_id
    )
    select 1
    from job_lots lot
    full join committed on committed.supply_lot_id = lot.id
    where lot.id is null
       or lot.allocated_qty < 0
       or lot.remaining_qty < 0
       or lot.allocated_qty + lot.remaining_qty <> lot.available_qty
       or lot.allocated_qty <> coalesce(committed.reserved_qty, 0)
  ) then
    raise exception using errcode = '23514', message = 'supply_allocation_invariant_failed';
  end if;

  if exists (
    with job_events as materialized (
      select
        event_row.id,
        event_row.required_qty,
        event_row.allocated_qty,
        event_row.remaining_qty
      from public.opportunity_finder_demand_events event_row
      where event_row.job_id = input_job_id
    ),
    committed as materialized (
      select allocation.demand_event_id, sum(allocation.allocated_qty) as allocated_qty
      from public.opportunity_finder_allocations allocation
      where allocation.job_id = input_job_id
      group by allocation.demand_event_id
    )
    select 1
    from job_events event_row
    full join committed on committed.demand_event_id = event_row.id
    where event_row.id is null
       or event_row.allocated_qty < 0
       or event_row.remaining_qty < 0
       or event_row.allocated_qty + event_row.remaining_qty <> event_row.required_qty
       or event_row.allocated_qty <> coalesce(committed.allocated_qty, 0)
  ) then
    raise exception using errcode = '23514', message = 'demand_allocation_invariant_failed';
  end if;

  if exists (
    with job_results as materialized (
      select result.id, result.allocated_qty
      from public.opportunity_finder_results result
      where result.job_id = input_job_id
    ),
    committed as materialized (
      select allocation.result_id, sum(allocation.allocated_qty) as allocated_qty
      from public.opportunity_finder_allocations allocation
      where allocation.job_id = input_job_id
      group by allocation.result_id
    )
    select 1
    from job_results result
    full join committed on committed.result_id = result.id
    where result.id is null
       or coalesce(result.allocated_qty, 0) <> coalesce(committed.allocated_qty, 0)
  ) then
    raise exception using errcode = '23514', message = 'result_allocation_invariant_failed';
  end if;

  if exists (
    select 1
    from public.opportunity_finder_allocations allocation
    join public.opportunity_finder_results result
      on result.id = allocation.result_id
     and result.job_id = allocation.job_id
     and result.tenant_id = allocation.tenant_id
    where allocation.job_id = input_job_id
      and (
        coalesce(allocation.decision_trace ->> 'identityKind', '') not in (
          'exact_mpn_mfg',
          'exact_mpn_mfg_missing',
          'exact_mpn_approved_alias',
          'approved_part_equivalence'
        )
        or (
          (
            allocation.decision_trace ->> 'identityKind' in (
              'exact_mpn_approved_alias', 'approved_part_equivalence'
            )
            or result.match_tier in (
              'exact_mpn_approved_alias', 'search_mpn_mfg', 'exact_mpn_mfg_conflict'
            )
          )
          and not exists (
            select 1
            from public.opportunity_finder_review_decisions decision
            where decision.job_id = allocation.job_id
              and decision.tenant_id = allocation.tenant_id
              and decision.decision = 'approved'
              and decision.reviewer_id is not null
              and decision.decided_at is not null
              and (
                (
                  decision.entity_type = 'result'
                  and decision.entity_id = result.id
                )
                or (
                  decision.entity_type = 'possible_match'
                  and result.candidate_id is not null
                  and decision.entity_id = result.candidate_id
                  and exists (
                    select 1
                    from public.opportunity_finder_possible_matches candidate
                    where candidate.id = result.candidate_id
                      and candidate.job_id = allocation.job_id
                      and candidate.tenant_id = allocation.tenant_id
                      and candidate.demand_option_id = allocation.demand_part_option_id
                      and candidate.supply_lot_id = allocation.supply_lot_id
                  )
                )
              )
          )
        )
      )
  ) then
    raise exception using errcode = '23514', message = 'allocation_identity_or_review_invariant_failed';
  end if;

  select count(*)::integer
  into database_result_count
  from public.opportunity_finder_results result
  where result.job_id = input_job_id;

  select count(*)::integer
  into database_possible_count
  from public.opportunity_finder_possible_matches candidate
  where candidate.job_id = input_job_id;

  update public.opportunity_finder_jobs job
  set
    status = case
      when input_warning_count > 0
        or input_missing_mpn_rows > 0
        or input_invalid_quantity_rows > 0
        or (
          jsonb_typeof(input_summary -> 'rejectedRows') = 'number'
          and (input_summary ->> 'rejectedRows')::numeric > 0
        )
        then 'completed_with_warnings'
      else 'completed'
    end,
    current_stage = 'completed',
    progress_percent = 100,
    result_count = database_result_count,
    warning_count = input_warning_count,
    missing_mpn_rows = input_missing_mpn_rows,
    invalid_quantity_rows = input_invalid_quantity_rows,
    matched_mpns = coalesce((input_summary ->> 'exactMatches')::integer, job.matched_mpns),
    summary_json = input_summary || jsonb_build_object(
      'possibleMatches', database_possible_count,
      'resultCount', database_result_count
    ),
    output_commit_key = input_commit_key,
    committed_fence = job.processing_fence,
    committed_lock_token = input_lock_token,
    completed_at = now(),
    locked_at = null,
    locked_by = null,
    lock_token = null,
    heartbeat_at = null,
    next_retry_at = null,
    error_code = null,
    updated_at = now()
  where job.id = input_job_id
  returning job.* into finalized_job;

  insert into public.opportunity_finder_audit_events (
    tenant_id,
    job_id,
    actor_user_id,
    event_type,
    entity_type,
    entity_id,
    safe_metadata
  )
  values (
    finalized_job.tenant_id,
    finalized_job.id,
    finalized_job.created_by,
    'job_output_committed',
    'opportunity_finder_job',
    finalized_job.id,
    jsonb_build_object(
      'processingFence', finalized_job.committed_fence,
      'resultCount', finalized_job.result_count,
      'warningCount', finalized_job.warning_count
    )
  );

  return finalized_job;
end;
$$;

revoke all on function public.finalize_opportunity_finder_job(
  uuid, text, uuid, text, jsonb, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.finalize_opportunity_finder_job(
  uuid, text, uuid, text, jsonb, integer, integer, integer
) to service_role;

create or replace function public.replace_opportunity_finder_job_output(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  commit_key text,
  results jsonb,
  possible_matches jsonb default '[]'::jsonb,
  rejected_rows jsonb default '[]'::jsonb,
  allocations jsonb default '[]'::jsonb,
  commercials jsonb default '[]'::jsonb,
  financials jsonb default '[]'::jsonb,
  summary jsonb default '{}'::jsonb,
  warning_count integer default 0,
  missing_mpn_rows integer default 0,
  invalid_quantity_rows integer default 0
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_commit_key alias for $4;
  input_results alias for $5;
  input_possible_matches alias for $6;
  input_rejected_rows alias for $7;
  input_allocations alias for $8;
  input_commercials alias for $9;
  input_financials alias for $10;
  input_summary alias for $11;
  input_warning_count alias for $12;
  input_missing_mpn_rows alias for $13;
  input_invalid_quantity_rows alias for $14;
  locked_job public.opportunity_finder_jobs%rowtype;
  replaced_job public.opportunity_finder_jobs%rowtype;
begin
  if input_results is null or jsonb_typeof(input_results) <> 'array'
     or input_possible_matches is null or jsonb_typeof(input_possible_matches) <> 'array'
     or input_rejected_rows is null or jsonb_typeof(input_rejected_rows) <> 'array'
     or input_allocations is null or jsonb_typeof(input_allocations) <> 'array'
     or input_commercials is null or jsonb_typeof(input_commercials) <> 'array'
     or input_financials is null or jsonb_typeof(input_financials) <> 'array' then
    raise exception using errcode = '22023', message = 'output_payloads_must_be_json_arrays';
  end if;

  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.output_commit_key = input_commit_key
     and locked_job.status in ('completed', 'completed_with_warnings') then
    return locked_job;
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.materialized_lock_token is distinct from input_lock_token then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_replaceable';
  end if;

  -- This delete/reset/insert/allocation/finalize sequence is one PostgreSQL
  -- transaction because it executes inside a single RPC call.
  delete from public.opportunity_finder_results result
  where result.job_id = input_job_id;
  delete from public.opportunity_finder_possible_matches candidate
  where candidate.job_id = input_job_id;
  delete from public.opportunity_finder_rejected_rows rejected
  where rejected.job_id = input_job_id;

  update public.opportunity_finder_supply_lots lot
  set allocated_qty = 0,
      remaining_qty = lot.available_qty,
      updated_at = now()
  where lot.job_id = input_job_id;

  update public.opportunity_finder_demand_events event_row
  set allocated_qty = 0,
      remaining_qty = event_row.required_qty,
      updated_at = now()
  where event_row.job_id = input_job_id;

  if exists (
    select 1
    from jsonb_to_recordset(input_possible_matches) as candidate(
      id uuid,
      candidate_key text,
      demand_normalized_mpn text,
      supply_normalized_mpn text,
      demand_option_id uuid,
      supply_lot_id uuid,
      demand_file_id uuid,
      supply_file_id uuid,
      reason_code text
    )
    cross join lateral (
      select coalesce(
        nullif(trim(candidate.candidate_key), ''),
        encode(
          digest(
            concat_ws(
              '|',
              input_job_id::text,
              candidate.demand_normalized_mpn,
              candidate.supply_normalized_mpn,
              coalesce(candidate.demand_option_id::text, candidate.demand_file_id::text),
              coalesce(candidate.supply_lot_id::text, candidate.supply_file_id::text),
              coalesce(candidate.reason_code, 'symbol_variant')
            ),
            'sha256'
          ),
          'hex'
        )
      ) as value
    ) candidate_key
    where candidate.id is not null
      and candidate.id is distinct from
        public.opportunity_finder_candidate_uuid(candidate_key.value)
  ) then
    raise exception using errcode = '23514', message = 'candidate_id_key_mismatch';
  end if;

  insert into public.opportunity_finder_possible_matches (
    id,
    tenant_id,
    job_id,
    candidate_key,
    demand_option_id,
    supply_lot_id,
    demand_display_mpn,
    supply_display_mpn,
    demand_normalized_mpn,
    supply_normalized_mpn,
    review_key,
    demand_file_id,
    supply_file_id,
    reason_code,
    match_tier,
    confidence,
    explanation,
    manufacturer_compatible,
    review_status,
    demand_trace,
    supply_trace
  )
  select
    candidate_identity.id,
    locked_job.tenant_id,
    input_job_id,
    candidate_key.value,
    candidate.demand_option_id,
    candidate.supply_lot_id,
    candidate.demand_display_mpn,
    candidate.supply_display_mpn,
    candidate.demand_normalized_mpn,
    candidate.supply_normalized_mpn,
    candidate.review_key,
    candidate.demand_file_id,
    candidate.supply_file_id,
    coalesce(candidate.reason_code, 'symbol_variant'),
    coalesce(candidate.match_tier, 'search_mpn_mfg'),
    coalesce(candidate.confidence, 'review'),
    candidate.explanation,
    candidate.manufacturer_compatible,
    coalesce(durable_review.decision, candidate.review_status, 'pending'),
    coalesce(candidate.demand_trace, '{}'::jsonb),
    coalesce(candidate.supply_trace, '{}'::jsonb)
  from jsonb_to_recordset(input_possible_matches) as candidate(
    id uuid,
    candidate_key text,
    demand_option_id uuid,
    supply_lot_id uuid,
    demand_display_mpn text,
    supply_display_mpn text,
    demand_normalized_mpn text,
    supply_normalized_mpn text,
    review_key text,
    demand_file_id uuid,
    supply_file_id uuid,
    reason_code text,
    match_tier text,
    confidence text,
    explanation text,
    manufacturer_compatible boolean,
    review_status text,
    demand_trace jsonb,
    supply_trace jsonb
  )
  cross join lateral (
    select coalesce(
      nullif(trim(candidate.candidate_key), ''),
      encode(
        digest(
          concat_ws(
            '|',
            input_job_id::text,
            candidate.demand_normalized_mpn,
            candidate.supply_normalized_mpn,
            coalesce(candidate.demand_option_id::text, candidate.demand_file_id::text),
            coalesce(candidate.supply_lot_id::text, candidate.supply_file_id::text),
            coalesce(candidate.reason_code, 'symbol_variant')
          ),
          'sha256'
        ),
        'hex'
      )
    ) as value
  ) candidate_key
  cross join lateral (
    select public.opportunity_finder_candidate_uuid(candidate_key.value) as id
  ) candidate_identity
  left join public.opportunity_finder_review_decisions durable_review
    on durable_review.job_id = input_job_id
   and durable_review.tenant_id = locked_job.tenant_id
   and durable_review.entity_type = 'possible_match'
   and durable_review.entity_id = candidate_identity.id;

  if exists (
    select 1
    from jsonb_to_recordset(input_results) as result(candidate_id uuid)
    left join public.opportunity_finder_possible_matches candidate
      on candidate.id = result.candidate_id
     and candidate.job_id = input_job_id
     and candidate.tenant_id = locked_job.tenant_id
    where result.candidate_id is not null
      and candidate.id is null
  ) then
    raise exception using errcode = '23503', message = 'result_candidate_not_found_for_job';
  end if;

  insert into public.opportunity_finder_results (
    id,
    tenant_id,
    job_id,
    result_key,
    opportunity_type,
    exact_match,
    exact_mpn_match,
    usable_availability_match,
    exact_quantity_match,
    match_tier,
    confidence,
    match_explanation,
    review_status,
    demand_event_id,
    demand_event_key,
    candidate_id,
    demand_mpn_original,
    supply_mpn_original,
    display_mpn,
    normalized_mpn,
    manufacturer,
    manufacturer_canonical,
    customer_context,
    supplier_context,
    required_qty,
    available_qty,
    allocated_qty,
    remaining_qty,
    shortage_qty,
    coverage_percent,
    required_date,
    unit_of_measure,
    moq,
    spq,
    date_code,
    coo,
    lead_time_weeks,
    condition,
    expires_at,
    demand_file_id,
    demand_file_name,
    demand_sheet_name,
    supply_file_id,
    supply_file_name,
    supply_sheet_name,
    demand_source_rows,
    supply_source_rows,
    demand_traces,
    supply_traces,
    allocations_trace,
    reason_code,
    action_code,
    warnings
  )
  select
    result.id,
    locked_job.tenant_id,
    input_job_id,
    coalesce(nullif(trim(result.result_key), ''), result.id::text),
    result.opportunity_type,
    coalesce(result.exact_match, result.exact_mpn_match, false),
    coalesce(result.exact_mpn_match, result.exact_match, false),
    coalesce(result.usable_availability_match, false),
    coalesce(result.exact_quantity_match, false),
    result.match_tier,
    result.confidence,
    result.match_explanation,
    coalesce(result.review_status, 'not_required'),
    result.demand_event_id,
    result.demand_event_key,
    result.candidate_id,
    result.demand_mpn_original,
    result.supply_mpn_original,
    result.display_mpn,
    result.normalized_mpn,
    result.manufacturer,
    result.manufacturer_canonical,
    result.customer_context,
    result.supplier_context,
    result.required_qty,
    result.available_qty,
    result.allocated_qty,
    result.remaining_qty,
    result.shortage_qty,
    result.coverage_percent,
    result.required_date,
    result.unit_of_measure,
    result.moq,
    result.spq,
    result.date_code,
    result.coo,
    result.lead_time_weeks,
    result.condition,
    result.expires_at,
    result.demand_file_id,
    result.demand_file_name,
    result.demand_sheet_name,
    result.supply_file_id,
    result.supply_file_name,
    result.supply_sheet_name,
    coalesce(result.demand_source_rows, 0),
    coalesce(result.supply_source_rows, 0),
    coalesce(result.demand_traces, '[]'::jsonb),
    coalesce(result.supply_traces, '[]'::jsonb),
    coalesce(result.allocations_trace, '[]'::jsonb),
    result.reason_code,
    result.action_code,
    coalesce(result.warnings, '[]'::jsonb)
  from jsonb_to_recordset(input_results) as result(
    id uuid,
    result_key text,
    opportunity_type text,
    exact_match boolean,
    exact_mpn_match boolean,
    usable_availability_match boolean,
    exact_quantity_match boolean,
    match_tier text,
    confidence text,
    match_explanation text,
    review_status text,
    demand_event_id uuid,
    demand_event_key text,
    candidate_id uuid,
    demand_mpn_original text,
    supply_mpn_original text,
    display_mpn text,
    normalized_mpn text,
    manufacturer text,
    manufacturer_canonical text,
    customer_context text,
    supplier_context text,
    required_qty numeric,
    available_qty numeric,
    allocated_qty numeric,
    remaining_qty numeric,
    shortage_qty numeric,
    coverage_percent numeric,
    required_date date,
    unit_of_measure text,
    moq numeric,
    spq numeric,
    date_code text,
    coo text,
    lead_time_weeks numeric,
    condition text,
    expires_at timestamptz,
    demand_file_id uuid,
    demand_file_name text,
    demand_sheet_name text,
    supply_file_id uuid,
    supply_file_name text,
    supply_sheet_name text,
    demand_source_rows integer,
    supply_source_rows integer,
    demand_traces jsonb,
    supply_traces jsonb,
    allocations_trace jsonb,
    reason_code text,
    action_code text,
    warnings jsonb
  )
  where result.id is not null;

  if (select count(*) from public.opportunity_finder_results result where result.job_id = input_job_id)
     <> jsonb_array_length(input_results) then
    raise exception using errcode = '23514', message = 'every_result_requires_unique_id';
  end if;

  insert into public.opportunity_finder_result_commercials (
    result_id,
    tenant_id,
    job_id,
    target_price,
    offer_price,
    target_gap_percent,
    currency,
    revenue_potential,
    pricing_quality
  )
  select
    commercial.result_id,
    locked_job.tenant_id,
    input_job_id,
    commercial.target_price,
    commercial.offer_price,
    commercial.target_gap_percent,
    commercial.currency,
    commercial.revenue_potential,
    coalesce(commercial.pricing_quality, 'unconfirmed')
  from jsonb_to_recordset(input_commercials) as commercial(
    result_id uuid,
    target_price numeric,
    offer_price numeric,
    target_gap_percent numeric,
    currency text,
    revenue_potential numeric,
    pricing_quality text
  );

  insert into public.opportunity_finder_result_financials (
    result_id,
    tenant_id,
    job_id,
    unit_cost,
    cost_currency,
    gross_profit,
    gross_margin_percent,
    cost_quality,
    cost_source_trace,
    computed_at
  )
  select
    financial.result_id,
    locked_job.tenant_id,
    input_job_id,
    financial.unit_cost,
    financial.cost_currency,
    financial.gross_profit,
    financial.gross_margin_percent,
    coalesce(financial.cost_quality, 'missing'),
    coalesce(financial.cost_source_trace, '{}'::jsonb),
    financial.computed_at
  from jsonb_to_recordset(input_financials) as financial(
    result_id uuid,
    unit_cost numeric,
    cost_currency text,
    gross_profit numeric,
    gross_margin_percent numeric,
    cost_quality text,
    cost_source_trace jsonb,
    computed_at timestamptz
  );

  insert into public.opportunity_finder_rejected_rows (
    id,
    tenant_id,
    job_id,
    file_id,
    side,
    file_name,
    sheet_name,
    source_row,
    source_row_hidden,
    reason_code,
    field_name,
    source_column,
    safe_raw_value,
    source_trace,
    ingestion_lock_token,
    ingestion_fence
  )
  select
    coalesce(rejected.id, gen_random_uuid()),
    locked_job.tenant_id,
    input_job_id,
    rejected.file_id,
    rejected.side,
    rejected.file_name,
    rejected.sheet_name,
    rejected.source_row,
    coalesce(rejected.source_row_hidden, rejected.hidden, false),
    rejected.reason_code,
    rejected.field_name,
    rejected.source_column,
    rejected.safe_raw_value,
    coalesce(rejected.source_trace, '{}'::jsonb),
    input_lock_token,
    locked_job.processing_fence
  from jsonb_to_recordset(input_rejected_rows) as rejected(
    id uuid,
    file_id uuid,
    side text,
    file_name text,
    sheet_name text,
    source_row integer,
    source_row_hidden boolean,
    hidden boolean,
    reason_code text,
    field_name text,
    source_column text,
    safe_raw_value text,
    source_trace jsonb
  );

  perform 1
  from public.commit_opportunity_finder_allocations(
    input_job_id,
    input_worker_id,
    input_lock_token,
    input_allocations
  );

  select finalized.*
  into replaced_job
  from public.finalize_opportunity_finder_job(
    input_job_id,
    input_worker_id,
    input_lock_token,
    input_commit_key,
    input_summary || jsonb_build_object(
      'rejectedRows', jsonb_array_length(input_rejected_rows)
    ),
    input_warning_count,
    input_missing_mpn_rows,
    input_invalid_quantity_rows
  ) finalized;

  return replaced_job;
end;
$$;

revoke all on function public.replace_opportunity_finder_job_output(
  uuid, text, uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb,
  jsonb, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.replace_opportunity_finder_job_output(
  uuid, text, uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb,
  jsonb, integer, integer, integer
) to service_role;

create or replace function public.decide_opportunity_finder_review(
  job_id uuid,
  entity_type text,
  entity_id uuid,
  decision text,
  review_note text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_entity_type alias for $2;
  input_entity_id alias for $3;
  input_decision alias for $4;
  input_review_note alias for $5;
  caller_id uuid := auth.uid();
  target_job public.opportunity_finder_jobs%rowtype;
  review_context jsonb;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if input_entity_type not in ('result', 'possible_match') then
    raise exception using errcode = '22023', message = 'invalid_review_entity_type';
  end if;

  if input_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_review_decision';
  end if;

  if input_review_note is not null and length(input_review_note) > 2000 then
    raise exception using errcode = '22001', message = 'review_note_too_long';
  end if;

  select job.*
  into target_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found
     or not public.can_access_opportunity_finder_job(input_job_id, target_job.tenant_id) then
    raise exception using errcode = '42501', message = 'opportunity_job_access_denied';
  end if;

  if input_entity_type = 'result' then
    select jsonb_build_object(
      'matchTier', result.match_tier,
      'demandEventId', result.demand_event_id,
      'candidateId', result.candidate_id,
      'resultKey', result.result_key
    )
    into review_context
    from public.opportunity_finder_results result
    where result.id = input_entity_id
      and result.job_id = input_job_id
      and result.tenant_id = target_job.tenant_id
    for update;

    if not found then
      raise exception using errcode = 'P0002', message = 'review_result_not_found';
    end if;

    update public.opportunity_finder_results result
    set review_status = input_decision
    where result.id = input_entity_id
      and result.job_id = input_job_id;
  else
    select jsonb_build_object(
      'matchTier', candidate.match_tier,
      'demandOptionId', candidate.demand_option_id,
      'supplyLotId', candidate.supply_lot_id,
      'candidateKey', candidate.candidate_key
    )
    into review_context
    from public.opportunity_finder_possible_matches candidate
    where candidate.id = input_entity_id
      and candidate.job_id = input_job_id
      and candidate.tenant_id = target_job.tenant_id
    for update;

    if not found then
      raise exception using errcode = 'P0002', message = 'review_candidate_not_found';
    end if;

    update public.opportunity_finder_possible_matches candidate
    set review_status = input_decision
    where candidate.id = input_entity_id
      and candidate.job_id = input_job_id;
  end if;

  insert into public.opportunity_finder_review_decisions (
    tenant_id,
    job_id,
    entity_type,
    entity_id,
    decision,
    reviewer_id,
    review_note,
    decided_at,
    decision_context
  )
  values (
    target_job.tenant_id,
    input_job_id,
    input_entity_type,
    input_entity_id,
    input_decision,
    caller_id,
    nullif(trim(input_review_note), ''),
    now(),
    coalesce(review_context, '{}'::jsonb)
  )
  on conflict on constraint opportunity_finder_review_entity_uidx do update
  set decision = excluded.decision,
      reviewer_id = excluded.reviewer_id,
      review_note = excluded.review_note,
      decided_at = excluded.decided_at,
      decision_context = excluded.decision_context;

  insert into public.opportunity_finder_audit_events (
    tenant_id,
    job_id,
    actor_user_id,
    event_type,
    entity_type,
    entity_id,
    safe_metadata
  )
  values (
    target_job.tenant_id,
    input_job_id,
    caller_id,
    'review_decided',
    input_entity_type,
    input_entity_id,
    jsonb_build_object('decision', input_decision)
  );

  return input_decision;
end;
$$;

revoke all on function public.decide_opportunity_finder_review(uuid, text, uuid, text, text)
  from public, anon;
grant execute on function public.decide_opportunity_finder_review(uuid, text, uuid, text, text)
  to authenticated, service_role;

-- Review mutation is routed through decide_opportunity_finder_review so the
-- decision row, target review_status and audit event commit atomically.
revoke insert on public.opportunity_finder_review_decisions from authenticated;
drop policy if exists opportunity_finder_review_decisions_insert_own
  on public.opportunity_finder_review_decisions;

-- ---------------------------------------------------------------------------
-- Fenced, chunked output staging.
--
-- Chunk uploads are separate short transactions, but they are never visible as
-- business output. The final RPC verifies a complete, contiguous manifest and
-- invokes replace_opportunity_finder_job_output inside its own transaction, so
-- delete/reset/insert/allocation/finalize either all commit or all roll back.
-- ---------------------------------------------------------------------------

create table public.opportunity_finder_output_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  worker_id text not null,
  lock_token uuid not null,
  processing_fence bigint not null check (processing_fence > 0),
  commit_key text not null check (length(commit_key) between 16 and 240),
  state text not null default 'staging' check (state in ('staging')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_finder_output_runs_job_tenant_fk
    foreign key (job_id, tenant_id)
    references public.opportunity_finder_jobs(id, tenant_id) on delete cascade,
  unique (job_id),
  unique (job_id, commit_key),
  unique (id, job_id, tenant_id)
);

create table public.opportunity_finder_output_items (
  run_id uuid not null,
  tenant_id uuid not null,
  job_id uuid not null,
  output_kind text not null check (
    output_kind in (
      'results',
      'possible_matches',
      'rejected_rows',
      'allocations',
      'commercials',
      'financials'
    )
  ),
  item_index bigint not null check (item_index >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  primary key (run_id, output_kind, item_index),
  constraint opportunity_finder_output_items_run_fk
    foreign key (run_id, job_id, tenant_id)
    references public.opportunity_finder_output_runs(id, job_id, tenant_id)
    on delete cascade
);

create index opportunity_finder_output_items_manifest_idx
  on public.opportunity_finder_output_items (job_id, run_id, output_kind, item_index);

comment on table public.opportunity_finder_output_runs is
  'Private fenced manifests for chunked worker output. A run is not user-visible business output.';
comment on table public.opportunity_finder_output_items is
  'Private ordered payload staging. Rows become visible only through the atomic staged-output commit RPC.';

alter table public.opportunity_finder_output_runs enable row level security;
alter table public.opportunity_finder_output_runs force row level security;
alter table public.opportunity_finder_output_items enable row level security;
alter table public.opportunity_finder_output_items force row level security;

revoke all on public.opportunity_finder_output_runs from public, anon, authenticated, service_role;
revoke all on public.opportunity_finder_output_items from public, anon, authenticated, service_role;

create or replace function public.begin_opportunity_finder_output(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  processing_fence bigint,
  commit_key text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_processing_fence alias for $4;
  input_commit_key alias for $5;
  locked_job public.opportunity_finder_jobs%rowtype;
  staged_run public.opportunity_finder_output_runs%rowtype;
begin
  if nullif(trim(input_commit_key), '') is null
     or length(input_commit_key) not between 16 and 240 then
    raise exception using errcode = '22023', message = 'invalid_output_commit_key';
  end if;

  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.processing_fence is distinct from input_processing_fence then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_stageable';
  end if;

  select run.*
  into staged_run
  from public.opportunity_finder_output_runs run
  where run.job_id = input_job_id
    and run.commit_key = input_commit_key
  for update;

  if found then
    if staged_run.worker_id is distinct from input_worker_id
       or staged_run.lock_token is distinct from input_lock_token
       or staged_run.processing_fence is distinct from input_processing_fence then
      raise exception using errcode = '40001', message = 'stale_opportunity_output_run';
    end if;
    return staged_run.id;
  end if;

  delete from public.opportunity_finder_output_runs run
  where run.job_id = input_job_id;

  insert into public.opportunity_finder_output_runs (
    tenant_id,
    job_id,
    worker_id,
    lock_token,
    processing_fence,
    commit_key
  )
  values (
    locked_job.tenant_id,
    input_job_id,
    input_worker_id,
    input_lock_token,
    input_processing_fence,
    input_commit_key
  )
  returning * into staged_run;

  return staged_run.id;
end;
$$;

revoke all on function public.begin_opportunity_finder_output(uuid, text, uuid, bigint, text)
  from public, anon, authenticated;
grant execute on function public.begin_opportunity_finder_output(uuid, text, uuid, bigint, text)
  to service_role;

create or replace function public.append_opportunity_finder_output(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  processing_fence bigint,
  commit_key text,
  output_kind text,
  start_index bigint,
  items jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_processing_fence alias for $4;
  input_commit_key alias for $5;
  input_output_kind alias for $6;
  input_start_index alias for $7;
  input_items alias for $8;
  locked_job public.opportunity_finder_jobs%rowtype;
  staged_run public.opportunity_finder_output_runs%rowtype;
  item_count integer;
begin
  if input_output_kind not in (
    'results',
    'possible_matches',
    'rejected_rows',
    'allocations',
    'commercials',
    'financials'
  ) then
    raise exception using errcode = '22023', message = 'invalid_output_kind';
  end if;

  if input_start_index is null or input_start_index < 0 then
    raise exception using errcode = '22023', message = 'invalid_output_start_index';
  end if;

  if input_items is null or jsonb_typeof(input_items) <> 'array' then
    raise exception using errcode = '22023', message = 'output_items_must_be_json_array';
  end if;

  item_count := jsonb_array_length(input_items);
  if item_count < 1 or item_count > 1000 then
    raise exception using errcode = '54000', message = 'output_chunk_size_invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(input_items) item(payload)
    where jsonb_typeof(item.payload) <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'output_item_must_be_json_object';
  end if;

  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.processing_fence is distinct from input_processing_fence then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_stageable';
  end if;

  select run.*
  into staged_run
  from public.opportunity_finder_output_runs run
  where run.job_id = input_job_id
    and run.commit_key = input_commit_key
  for update;

  if not found
     or staged_run.worker_id is distinct from input_worker_id
     or staged_run.lock_token is distinct from input_lock_token
     or staged_run.processing_fence is distinct from input_processing_fence then
    raise exception using errcode = '40001', message = 'stale_opportunity_output_run';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(input_items) with ordinality item(payload, ordinal)
    join public.opportunity_finder_output_items staged
      on staged.run_id = staged_run.id
     and staged.output_kind = input_output_kind
     and staged.item_index = input_start_index + item.ordinal - 1
    where staged.payload is distinct from item.payload
  ) then
    raise exception using errcode = '23505', message = 'output_chunk_replay_conflict';
  end if;

  insert into public.opportunity_finder_output_items (
    run_id,
    tenant_id,
    job_id,
    output_kind,
    item_index,
    payload
  )
  select
    staged_run.id,
    locked_job.tenant_id,
    input_job_id,
    input_output_kind,
    input_start_index + item.ordinal - 1,
    item.payload
  from jsonb_array_elements(input_items) with ordinality item(payload, ordinal)
  on conflict on constraint opportunity_finder_output_items_pkey do nothing;

  update public.opportunity_finder_output_runs run
  set updated_at = now()
  where run.id = staged_run.id;

  return item_count;
end;
$$;

revoke all on function public.append_opportunity_finder_output(
  uuid, text, uuid, bigint, text, text, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.append_opportunity_finder_output(
  uuid, text, uuid, bigint, text, text, bigint, jsonb
) to service_role;

create or replace function public.commit_staged_opportunity_finder_output(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  processing_fence bigint,
  commit_key text,
  expected_counts jsonb,
  summary jsonb,
  warning_count integer,
  missing_mpn_rows integer,
  invalid_quantity_rows integer
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_processing_fence alias for $4;
  input_commit_key alias for $5;
  input_expected_counts alias for $6;
  input_summary alias for $7;
  input_warning_count alias for $8;
  input_missing_mpn_rows alias for $9;
  input_invalid_quantity_rows alias for $10;
  locked_job public.opportunity_finder_jobs%rowtype;
  staged_run public.opportunity_finder_output_runs%rowtype;
  replaced_job public.opportunity_finder_jobs%rowtype;
  expected_kind text;
  expected_count bigint;
  actual_count bigint;
  first_index bigint;
  last_index bigint;
  staged_results jsonb;
  staged_possible_matches jsonb;
  staged_rejected_rows jsonb;
  staged_allocations jsonb;
  staged_commercials jsonb;
  staged_financials jsonb;
begin
  if input_expected_counts is null or jsonb_typeof(input_expected_counts) <> 'object'
     or input_summary is null or jsonb_typeof(input_summary) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_output_manifest';
  end if;

  if input_warning_count < 0
     or input_missing_mpn_rows < 0
     or input_invalid_quantity_rows < 0 then
    raise exception using errcode = '22023', message = 'invalid_job_counters';
  end if;

  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.output_commit_key = input_commit_key
     and locked_job.status in ('completed', 'completed_with_warnings') then
    return locked_job;
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.processing_fence is distinct from input_processing_fence
     or locked_job.materialized_lock_token is distinct from input_lock_token then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_committable';
  end if;

  select run.*
  into staged_run
  from public.opportunity_finder_output_runs run
  where run.job_id = input_job_id
    and run.commit_key = input_commit_key
  for update;

  if not found
     or staged_run.worker_id is distinct from input_worker_id
     or staged_run.lock_token is distinct from input_lock_token
     or staged_run.processing_fence is distinct from input_processing_fence then
    raise exception using errcode = '40001', message = 'stale_opportunity_output_run';
  end if;

  foreach expected_kind in array array[
    'results',
    'possible_matches',
    'rejected_rows',
    'allocations',
    'commercials',
    'financials'
  ] loop
    if jsonb_typeof(input_expected_counts -> expected_kind) is distinct from 'number'
       or (input_expected_counts ->> expected_kind) !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = 'invalid_output_expected_count';
    end if;

    expected_count := (input_expected_counts ->> expected_kind)::bigint;
    select count(*), min(item.item_index), max(item.item_index)
    into actual_count, first_index, last_index
    from public.opportunity_finder_output_items item
    where item.run_id = staged_run.id
      and item.output_kind = expected_kind;

    if actual_count <> expected_count
       or (expected_count > 0 and (first_index <> 0 or last_index <> expected_count - 1))
       or (expected_count = 0 and (first_index is not null or last_index is not null)) then
      raise exception using errcode = '23514', message = 'incomplete_opportunity_output_manifest';
    end if;
  end loop;

  select coalesce(jsonb_agg(item.payload order by item.item_index), '[]'::jsonb)
  into staged_results
  from public.opportunity_finder_output_items item
  where item.run_id = staged_run.id and item.output_kind = 'results';

  select coalesce(jsonb_agg(item.payload order by item.item_index), '[]'::jsonb)
  into staged_possible_matches
  from public.opportunity_finder_output_items item
  where item.run_id = staged_run.id and item.output_kind = 'possible_matches';

  select coalesce(jsonb_agg(item.payload order by item.item_index), '[]'::jsonb)
  into staged_rejected_rows
  from public.opportunity_finder_output_items item
  where item.run_id = staged_run.id and item.output_kind = 'rejected_rows';

  select coalesce(jsonb_agg(item.payload order by item.item_index), '[]'::jsonb)
  into staged_allocations
  from public.opportunity_finder_output_items item
  where item.run_id = staged_run.id and item.output_kind = 'allocations';

  select coalesce(jsonb_agg(item.payload order by item.item_index), '[]'::jsonb)
  into staged_commercials
  from public.opportunity_finder_output_items item
  where item.run_id = staged_run.id and item.output_kind = 'commercials';

  select coalesce(jsonb_agg(item.payload order by item.item_index), '[]'::jsonb)
  into staged_financials
  from public.opportunity_finder_output_items item
  where item.run_id = staged_run.id and item.output_kind = 'financials';

  select replaced.*
  into replaced_job
  from public.replace_opportunity_finder_job_output(
    input_job_id,
    input_worker_id,
    input_lock_token,
    input_commit_key,
    staged_results,
    staged_possible_matches,
    staged_rejected_rows,
    staged_allocations,
    staged_commercials,
    staged_financials,
    input_summary || jsonb_build_object(
      'rejectedRows', (input_expected_counts ->> 'rejected_rows')::bigint
    ),
    input_warning_count,
    input_missing_mpn_rows,
    input_invalid_quantity_rows
  ) replaced;

  delete from public.opportunity_finder_output_runs run
  where run.id = staged_run.id;

  return replaced_job;
end;
$$;

revoke all on function public.commit_staged_opportunity_finder_output(
  uuid, text, uuid, bigint, text, jsonb, jsonb, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.commit_staged_opportunity_finder_output(
  uuid, text, uuid, bigint, text, jsonb, jsonb, integer, integer, integer
) to service_role;

-- User-triggered state transitions are exposed to the API through narrow,
-- service-only RPCs. Each function locks the job and all affected files so a
-- concurrent request cannot publish file roles that disagree with the job or
-- report a transition it did not win.
create or replace function public.confirm_opportunity_finder_roles(
  job_id uuid,
  actor_id uuid,
  file_a_id uuid,
  file_a_role text,
  file_a_valid_until timestamptz,
  file_b_id uuid,
  file_b_role text,
  file_b_valid_until timestamptz
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_actor_id alias for $2;
  input_file_a_id alias for $3;
  input_file_a_role alias for $4;
  input_file_a_valid_until alias for $5;
  input_file_b_id alias for $6;
  input_file_b_role alias for $7;
  input_file_b_valid_until alias for $8;
  locked_job public.opportunity_finder_jobs%rowtype;
  locked_file_a public.opportunity_finder_files%rowtype;
  locked_file_b public.opportunity_finder_files%rowtype;
  updated_job public.opportunity_finder_jobs%rowtype;
  allowed_roles constant text[] := array[
    'demand', 'stock', 'excess', 'supplier_offer', 'received_history',
    'purchase_history', 'quote_history', 'sales_history', 'ignore'
  ];
begin
  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;
  if locked_job.status <> 'awaiting_roles' then
    raise exception using errcode = '55000', message = 'opportunity_job_not_awaiting_roles';
  end if;
  if input_file_a_role is null or not (input_file_a_role = any(allowed_roles))
     or input_file_b_role is null or not (input_file_b_role = any(allowed_roles)) then
    raise exception using errcode = '22023', message = 'opportunity_roles_invalid';
  end if;
  if input_file_a_valid_until is not null and input_file_a_valid_until <= now()
     or input_file_b_valid_until is not null and input_file_b_valid_until <= now() then
    raise exception using errcode = '22023', message = 'opportunity_offer_validity_not_future';
  end if;
  if input_file_a_role = 'supplier_offer' and input_file_a_valid_until is null
     or input_file_b_role = 'supplier_offer' and input_file_b_valid_until is null then
    raise exception using errcode = '22023', message = 'opportunity_offer_validity_required';
  end if;

  select file.* into locked_file_a
  from public.opportunity_finder_files file
  where file.id = input_file_a_id
    and file.job_id = input_job_id
    and file.side = 'A'
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'opportunity_file_a_invalid';
  end if;

  select file.* into locked_file_b
  from public.opportunity_finder_files file
  where file.id = input_file_b_id
    and file.job_id = input_job_id
    and file.side = 'B'
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'opportunity_file_b_invalid';
  end if;

  if locked_job.file_a_id is distinct from input_file_a_id
     or locked_job.file_b_id is distinct from input_file_b_id
     or locked_file_a.storage_deleted_at is not null
     or locked_file_b.storage_deleted_at is not null
     or locked_file_a.storage_deletion_token is not null
     or locked_file_b.storage_deletion_token is not null then
    raise exception using errcode = '55000', message = 'opportunity_source_files_unavailable';
  end if;
  if locked_file_a.detected_type = 'financial' or locked_file_b.detected_type = 'financial' then
    raise exception using errcode = '22023', message = 'opportunity_financial_file_incompatible';
  end if;

  update public.opportunity_finder_files file
  set
    selected_role = input_file_a_role,
    validity_override_expires_at = input_file_a_valid_until
  where file.id = input_file_a_id;

  update public.opportunity_finder_files file
  set
    selected_role = input_file_b_role,
    validity_override_expires_at = input_file_b_valid_until
  where file.id = input_file_b_id;

  update public.opportunity_finder_jobs job
  set
    file_a_role = input_file_a_role,
    file_b_role = input_file_b_role,
    status = 'queued',
    current_stage = 'normalizing_mpn',
    progress_percent = 26,
    attempts = 0,
    error_code = null,
    cancel_requested = false,
    next_retry_at = null
  where job.id = input_job_id
  returning job.* into updated_job;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id,
    input_job_id,
    input_actor_id,
    'roles_confirmed',
    'opportunity_finder_job',
    input_job_id,
    jsonb_build_object(
      'fileARole', input_file_a_role,
      'fileBRole', input_file_b_role,
      'fileAValidityAttested', input_file_a_valid_until is not null,
      'fileBValidityAttested', input_file_b_valid_until is not null
    )
  );

  return updated_job;
end;
$$;

revoke all on function public.confirm_opportunity_finder_roles(
  uuid, uuid, uuid, text, timestamptz, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.confirm_opportunity_finder_roles(
  uuid, uuid, uuid, text, timestamptz, uuid, text, timestamptz
) to service_role;

create or replace function public.cancel_opportunity_finder_job(
  job_id uuid,
  actor_id uuid
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_actor_id alias for $2;
  locked_job public.opportunity_finder_jobs%rowtype;
  updated_job public.opportunity_finder_jobs%rowtype;
  worker_active boolean;
begin
  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;
  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.status in ('completed', 'completed_with_warnings', 'failed', 'cancelled') then
    return locked_job;
  end if;

  worker_active := locked_job.status in ('profiling', 'parsing', 'matching');
  update public.opportunity_finder_jobs job
  set
    cancel_requested = true,
    status = case when worker_active then job.status else 'cancelled' end,
    cancelled_at = case when worker_active then job.cancelled_at else now() end,
    error_code = case when worker_active then job.error_code else 'JOB_CANCELLED' end
  where job.id = input_job_id
  returning job.* into updated_job;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id,
    input_job_id,
    input_actor_id,
    'job_cancel_requested',
    'opportunity_finder_job',
    input_job_id,
    jsonb_build_object('workerActive', worker_active)
  );

  return updated_job;
end;
$$;

revoke all on function public.cancel_opportunity_finder_job(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_opportunity_finder_job(uuid, uuid)
  to service_role;

create or replace function public.retry_opportunity_finder_job(
  job_id uuid,
  actor_id uuid
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_actor_id alias for $2;
  locked_job public.opportunity_finder_jobs%rowtype;
  updated_job public.opportunity_finder_jobs%rowtype;
  file_count integer;
  source_expired boolean;
  ready_for_matching boolean;
begin
  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;
  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;
  if locked_job.status not in ('failed', 'cancelled') then
    raise exception using errcode = '55000', message = 'opportunity_job_not_retryable';
  end if;
  if locked_job.error_code = 'JOB_DELETION_REQUESTED' then
    raise exception using errcode = '55000', message = 'opportunity_job_deletion_in_progress';
  end if;

  perform 1
  from public.opportunity_finder_files file
  where file.job_id = input_job_id
  for update;

  select
    count(*)::integer,
    coalesce(bool_or(
      file.storage_deleted_at is not null or file.storage_deletion_token is not null
    ), false),
    count(*) = 2 and coalesce(bool_and(
      file.profiled_at is not null and file.selected_role is not null
    ), false)
  into file_count, source_expired, ready_for_matching
  from public.opportunity_finder_files file
  where file.job_id = input_job_id;

  if file_count <> 2 then
    raise exception using errcode = '55000', message = 'opportunity_exactly_two_files_required';
  end if;
  if source_expired then
    raise exception using errcode = '55000', message = 'opportunity_source_file_expired';
  end if;

  update public.opportunity_finder_jobs job
  set
    status = 'queued',
    current_stage = case when ready_for_matching then 'normalizing_mpn' else 'inspecting_sheets' end,
    progress_percent = case when ready_for_matching then 26 else 2 end,
    cancel_requested = false,
    cancelled_at = null,
    error_code = null,
    attempts = 0,
    next_retry_at = null,
    locked_at = null,
    locked_by = null,
    heartbeat_at = null,
    lock_token = null
  where job.id = input_job_id
  returning job.* into updated_job;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id,
    input_job_id,
    input_actor_id,
    'job_retried',
    'opportunity_finder_job',
    input_job_id,
    jsonb_build_object('readyForMatching', ready_for_matching)
  );

  return updated_job;
end;
$$;

revoke all on function public.retry_opportunity_finder_job(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.retry_opportunity_finder_job(uuid, uuid)
  to service_role;

create or replace function public.queue_opportunity_finder_profile(
  job_id uuid,
  actor_id uuid,
  expected_status text,
  uploaded_at timestamptz
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_actor_id alias for $2;
  input_expected_status alias for $3;
  input_uploaded_at alias for $4;
  locked_job public.opportunity_finder_jobs%rowtype;
  updated_job public.opportunity_finder_jobs%rowtype;
  file_count integer;
  source_unavailable boolean;
begin
  if input_expected_status not in ('uploading', 'failed') then
    raise exception using errcode = '22023', message = 'opportunity_queue_expected_status_invalid';
  end if;
  if input_uploaded_at is null then
    raise exception using errcode = '22023', message = 'opportunity_uploaded_at_required';
  end if;

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;
  if locked_job.status is distinct from input_expected_status then
    raise exception using errcode = '40001', message = 'opportunity_job_status_changed';
  end if;

  perform 1
  from public.opportunity_finder_files file
  where file.job_id = input_job_id
  order by file.id
  for update;

  select
    count(*)::integer,
    coalesce(bool_or(
      file.storage_deleted_at is not null or file.storage_deletion_token is not null
    ), false)
  into file_count, source_unavailable
  from public.opportunity_finder_files file
  where file.job_id = input_job_id;

  if file_count <> 2 then
    raise exception using errcode = '22023', message = 'opportunity_exactly_two_files_required';
  end if;
  if source_unavailable then
    raise exception using errcode = '55000', message = 'opportunity_source_files_unavailable';
  end if;

  update public.opportunity_finder_files file
  set uploaded_at = input_uploaded_at,
      parse_status = 'uploaded'
  where file.job_id = input_job_id;

  update public.opportunity_finder_jobs job
  set status = 'queued',
      current_stage = 'inspecting_sheets',
      progress_percent = 2,
      error_code = null,
      cancel_requested = false,
      cancelled_at = null,
      attempts = 0,
      next_retry_at = null,
      locked_at = null,
      locked_by = null,
      heartbeat_at = null,
      lock_token = null,
      updated_at = now()
  where job.id = input_job_id
    and job.status = input_expected_status
  returning job.* into updated_job;

  if not found then
    raise exception using errcode = '40001', message = 'opportunity_job_status_changed';
  end if;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id,
    input_job_id,
    input_actor_id,
    'upload_confirmed_and_queued',
    'opportunity_finder_job',
    input_job_id,
    jsonb_build_object('fileCount', file_count, 'expectedStatus', input_expected_status)
  );

  return updated_job;
end;
$$;

revoke all on function public.queue_opportunity_finder_profile(
  uuid, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.queue_opportunity_finder_profile(
  uuid, uuid, text, timestamptz
) to service_role;

create or replace function public.prepare_opportunity_finder_job_deletion(
  job_id uuid,
  actor_id uuid
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_actor_id alias for $2;
  locked_job public.opportunity_finder_jobs%rowtype;
  updated_job public.opportunity_finder_jobs%rowtype;
begin
  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;
  if locked_job.status in ('profiling', 'parsing', 'matching') then
    raise exception using errcode = '55000', message = 'opportunity_job_worker_active';
  end if;

  perform 1
  from public.opportunity_finder_files file
  where file.job_id = input_job_id
  order by file.id
  for update;

  if exists (
    select 1
    from public.opportunity_finder_files file
    where file.job_id = input_job_id
      and file.storage_deletion_token is not null
  ) then
    raise exception using errcode = '40001', message = 'opportunity_file_deletion_in_progress';
  end if;

  if locked_job.status = 'cancelled'
     and locked_job.error_code = 'JOB_DELETION_REQUESTED' then
    return locked_job;
  end if;

  update public.opportunity_finder_jobs job
  set status = 'cancelled',
      cancel_requested = true,
      cancelled_at = now(),
      error_code = 'JOB_DELETION_REQUESTED',
      next_retry_at = null,
      locked_at = null,
      locked_by = null,
      heartbeat_at = null,
      lock_token = null,
      updated_at = now()
  where job.id = input_job_id
  returning job.* into updated_job;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id,
    input_job_id,
    input_actor_id,
    'job_deletion_requested',
    'opportunity_finder_job',
    input_job_id,
    jsonb_build_object('previousStatus', locked_job.status)
  );

  return updated_job;
end;
$$;

revoke all on function public.prepare_opportunity_finder_job_deletion(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_opportunity_finder_job_deletion(uuid, uuid)
  to service_role;

-- Retention uses a status CAS so a stale expiry scan cannot delete a job that
-- was retried or otherwise reactivated after the scan. The interactive DELETE
-- RPC above deliberately keeps its owner-authorized pre-worker semantics.
create or replace function public.prepare_opportunity_finder_expired_job_deletion(
  job_id uuid,
  expected_status text,
  observed_at timestamptz
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_expected_status alias for $2;
  input_observed_at alias for $3;
  locked_job public.opportunity_finder_jobs%rowtype;
  prepared_job public.opportunity_finder_jobs%rowtype;
begin
  if input_expected_status not in (
    'completed', 'completed_with_warnings', 'failed', 'cancelled'
  ) or input_observed_at is null then
    raise exception using errcode = '22023', message = 'opportunity_expired_job_claim_invalid';
  end if;

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;
  if locked_job.status is distinct from input_expected_status then
    raise exception using errcode = '40001', message = 'opportunity_job_status_changed';
  end if;
  if locked_job.expires_at >= input_observed_at then
    raise exception using errcode = '55000', message = 'opportunity_job_not_expired';
  end if;

  select prepared.* into prepared_job
  from public.prepare_opportunity_finder_job_deletion(
    input_job_id, locked_job.created_by
  ) prepared;
  return prepared_job;
end;
$$;

revoke all on function public.prepare_opportunity_finder_expired_job_deletion(
  uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.prepare_opportunity_finder_expired_job_deletion(
  uuid, text, timestamptz
) to service_role;

create or replace function public.finalize_opportunity_finder_job_deletion(
  job_id uuid,
  actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_actor_id alias for $2;
  locked_job public.opportunity_finder_jobs%rowtype;
  file_count integer;
  deleted_job_id uuid;
begin
  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;
  if locked_job.status <> 'cancelled'
     or locked_job.error_code <> 'JOB_DELETION_REQUESTED'
     or locked_job.locked_by is not null
     or locked_job.lock_token is not null then
    raise exception using errcode = '55000', message = 'opportunity_job_not_prepared_for_deletion';
  end if;

  perform 1
  from public.opportunity_finder_files file
  where file.job_id = input_job_id
  order by file.id
  for update;

  if exists (
    select 1
    from public.opportunity_finder_files file
    where file.job_id = input_job_id
      and file.storage_deletion_token is not null
  ) then
    raise exception using errcode = '40001', message = 'opportunity_file_deletion_in_progress';
  end if;

  select count(*)::integer into file_count
  from public.opportunity_finder_files file
  where file.job_id = input_job_id;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id,
    input_job_id,
    input_actor_id,
    'job_deleted',
    'opportunity_finder_job',
    input_job_id,
    jsonb_build_object('fileCount', file_count)
  );

  delete from public.opportunity_finder_jobs job
  where job.id = input_job_id
    and job.status = 'cancelled'
    and job.error_code = 'JOB_DELETION_REQUESTED'
  returning job.id into deleted_job_id;

  if deleted_job_id is null then
    raise exception using errcode = '40001', message = 'opportunity_job_deletion_lost';
  end if;
  return deleted_job_id;
end;
$$;

revoke all on function public.finalize_opportunity_finder_job_deletion(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_opportunity_finder_job_deletion(uuid, uuid)
  to service_role;

create or replace function public.claim_opportunity_finder_file_retention(
  batch_size integer,
  claimed_at timestamptz
)
returns table (
  file_id uuid,
  job_id uuid,
  owner_id uuid,
  original_file_name text,
  storage_bucket text,
  storage_path text,
  storage_deletion_token uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_batch_size alias for $1;
  input_claimed_at alias for $2;
begin
  if input_batch_size is null or input_batch_size < 1 or input_batch_size > 500 then
    raise exception using errcode = '22023', message = 'opportunity_retention_batch_size_invalid';
  end if;
  if input_claimed_at is null then
    raise exception using errcode = '22023', message = 'opportunity_retention_claimed_at_required';
  end if;

  return query
  with locked_jobs as materialized (
    select job.id, job.tenant_id, job.created_by
    from public.opportunity_finder_jobs job
    where job.status in ('completed', 'completed_with_warnings', 'failed', 'cancelled')
      and (
        job.error_code is distinct from 'JOB_DELETION_REQUESTED'
        or job.updated_at < input_claimed_at - interval '2 hours'
      )
      and exists (
        select 1
        from public.opportunity_finder_files candidate_file
        where candidate_file.job_id = job.id
          and candidate_file.file_expires_at < input_claimed_at
          and candidate_file.storage_deleted_at is null
          and (
            candidate_file.storage_deletion_token is null
            or candidate_file.storage_deletion_started_at <
               input_claimed_at - interval '2 hours'
          )
      )
    order by job.id
    for update of job skip locked
    limit input_batch_size
  ),
  locked_files as materialized (
    select
      file.id,
      file.storage_deletion_token is not null as was_reclaimed
    from locked_jobs locked_job
    join public.opportunity_finder_files file on file.job_id = locked_job.id
    where file.file_expires_at < input_claimed_at
      and file.storage_deleted_at is null
      and (
        file.storage_deletion_token is null
        or file.storage_deletion_started_at < input_claimed_at - interval '2 hours'
      )
    order by file.job_id, file.id
    for update of file skip locked
    limit input_batch_size
  ),
  claimed as (
    update public.opportunity_finder_files file
    set storage_deletion_token = gen_random_uuid(),
        storage_deletion_started_at = input_claimed_at
    from locked_files locked_file
    where file.id = locked_file.id
    returning
      file.id,
      file.job_id,
      file.original_file_name,
      file.storage_bucket,
      file.storage_path,
      file.storage_deletion_token,
      locked_file.was_reclaimed
  ),
  audited as (
    insert into public.opportunity_finder_audit_events (
      tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
    )
    select
      locked_job.tenant_id,
      claimed.job_id,
      null,
      case
        when claimed.was_reclaimed then 'source_file_retention_reclaimed'
        else 'source_file_deletion_claimed'
      end,
      'opportunity_finder_file',
      claimed.id,
      jsonb_build_object('retention', true)
    from claimed
    join locked_jobs locked_job on locked_job.id = claimed.job_id
    returning entity_id
  )
  select
    claimed.id,
    claimed.job_id,
    locked_job.created_by,
    claimed.original_file_name,
    claimed.storage_bucket,
    claimed.storage_path,
    claimed.storage_deletion_token
  from claimed
  join locked_jobs locked_job on locked_job.id = claimed.job_id
  join audited on audited.entity_id = claimed.id
  order by claimed.job_id, claimed.id;
end;
$$;

revoke all on function public.claim_opportunity_finder_file_retention(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_opportunity_finder_file_retention(integer, timestamptz)
  to service_role;

create or replace function public.finalize_opportunity_finder_file_retention(
  storage_deletion_token uuid,
  deleted_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_token alias for $1;
  input_deleted_at alias for $2;
  target_job_id uuid;
  locked_job public.opportunity_finder_jobs%rowtype;
  locked_file public.opportunity_finder_files%rowtype;
begin
  if input_token is null or input_deleted_at is null then
    raise exception using errcode = '22023', message = 'opportunity_retention_finalize_invalid';
  end if;

  select file.job_id into target_job_id
  from public.opportunity_finder_files file
  where file.storage_deletion_token = input_token;
  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_retention_claim_not_found';
  end if;

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = target_job_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_retention_claim_not_found';
  end if;

  select file.* into locked_file
  from public.opportunity_finder_files file
  where file.storage_deletion_token = input_token
    and file.job_id = target_job_id
  for update;
  if not found then
    raise exception using errcode = '40001', message = 'opportunity_retention_claim_changed';
  end if;

  update public.opportunity_finder_files file
  set storage_deleted_at = input_deleted_at,
      storage_deletion_token = null,
      storage_deletion_started_at = null
  where file.id = locked_file.id
    and file.storage_deletion_token = input_token;
  if not found then
    raise exception using errcode = '40001', message = 'opportunity_retention_claim_changed';
  end if;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id,
    locked_job.id,
    null,
    'source_file_deleted',
    'opportunity_finder_file',
    locked_file.id,
    jsonb_build_object('retention', true)
  );
  return locked_file.id;
end;
$$;

revoke all on function public.finalize_opportunity_finder_file_retention(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_opportunity_finder_file_retention(uuid, timestamptz)
  to service_role;

create or replace function public.abort_opportunity_finder_file_retention(
  storage_deletion_token uuid,
  failure_code text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_token alias for $1;
  input_failure_code alias for $2;
  target_job_id uuid;
  locked_job public.opportunity_finder_jobs%rowtype;
  locked_file public.opportunity_finder_files%rowtype;
begin
  if input_token is null
     or input_failure_code not in (
       'STORAGE_DELETE_FAILED', 'INVALID_STORAGE_REFERENCE', 'UNEXPECTED_STORAGE_RESPONSE'
     ) then
    raise exception using errcode = '22023', message = 'opportunity_retention_abort_invalid';
  end if;

  select file.job_id into target_job_id
  from public.opportunity_finder_files file
  where file.storage_deletion_token = input_token;
  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_retention_claim_not_found';
  end if;

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = target_job_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_retention_claim_not_found';
  end if;

  select file.* into locked_file
  from public.opportunity_finder_files file
  where file.storage_deletion_token = input_token
    and file.job_id = target_job_id
  for update;
  if not found then
    raise exception using errcode = '40001', message = 'opportunity_retention_claim_changed';
  end if;

  update public.opportunity_finder_files file
  set storage_deletion_token = null,
      storage_deletion_started_at = null
  where file.id = locked_file.id
    and file.storage_deletion_token = input_token;
  if not found then
    raise exception using errcode = '40001', message = 'opportunity_retention_claim_changed';
  end if;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id,
    locked_job.id,
    null,
    'source_file_deletion_failed',
    'opportunity_finder_file',
    locked_file.id,
    jsonb_build_object('failureCode', input_failure_code)
  );
  return locked_file.id;
end;
$$;

revoke all on function public.abort_opportunity_finder_file_retention(uuid, text)
  from public, anon, authenticated;
grant execute on function public.abort_opportunity_finder_file_retention(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- EXACT DEPLOYMENT RUNBOOK (MANUAL; NOT EXECUTED BY THIS CHANGE)
-- ---------------------------------------------------------------------------
-- Preconditions:
--   1. Back up the target database and record the restore point identifier.
--   2. Confirm 20260727090000 and 20260729120000 are present in migration history.
--   3. Keep the current API/worker running; this migration is additive for the
--      legacy tables. Deploy the new API/worker only after the migration passes.
-- Commands, from the repository root, after explicit production authorization:
--   supabase migration list --linked
--   supabase db push --linked --dry-run
--   supabase db push --linked
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 \
--     -f supabase/tests/opportunity_finder_advanced_contract.sql
-- Required post-deploy checks:
--   select version from supabase_migrations.schema_migrations
--   where version = '20260808120000';
--   select id, public, file_size_limit from storage.buckets
--   where id = 'opportunity-finder';
-- Expected: one migration row; bucket public=false; contract exits with code 0.
-- Verify service_role-only EXECUTE for queue/profile, prepare/finalize job
-- deletion and claim/finalize/abort file-retention RPCs before enabling cleanup.
-- Do not run a worker or cleanup process using these RPCs until all checks succeed.

-- ---------------------------------------------------------------------------
-- EXACT ROLLBACK RUNBOOK (MANUAL; NOT EXECUTED; DESTRUCTIVE IF SCHEMA IS DROPPED)
-- ---------------------------------------------------------------------------
-- Preferred rollback (no data loss):
--   1. Stop new Opportunity Finder workers.
--   2. Redeploy the immediately previous API/worker release.
--   3. Leave this additive migration applied. Legacy jobs/files/rows/results and
--      possible_matches remain backward compatible.
--   4. Do not delete the migration-history row and do not edit an applied file.
--
-- If a database rollback is mandatory, first export every opportunity_finder_*
-- advanced table and create a NEW compensating migration. The exact destructive
-- object-removal order for that new migration is below. It intentionally keeps
-- tenant_id and hardened owner RLS on legacy tables; removing that boundary is a
-- separate security migration and must never be bundled into an emergency rollback.
--
--   begin;
--   revoke execute on function public.confirm_opportunity_finder_roles(
--     uuid,uuid,uuid,text,timestamptz,uuid,text,timestamptz
--   ) from service_role;
--   revoke execute on function public.cancel_opportunity_finder_job(uuid,uuid)
--     from service_role;
--   revoke execute on function public.retry_opportunity_finder_job(uuid,uuid)
--     from service_role;
--   revoke execute on function public.queue_opportunity_finder_profile(
--     uuid,uuid,text,timestamptz
--   ) from service_role;
--   revoke execute on function public.prepare_opportunity_finder_job_deletion(uuid,uuid)
--     from service_role;
--   revoke execute on function public.prepare_opportunity_finder_expired_job_deletion(
--     uuid,text,timestamptz
--   ) from service_role;
--   revoke execute on function public.finalize_opportunity_finder_job_deletion(uuid,uuid)
--     from service_role;
--   revoke execute on function public.claim_opportunity_finder_file_retention(
--     integer,timestamptz
--   ) from service_role;
--   revoke execute on function public.finalize_opportunity_finder_file_retention(
--     uuid,timestamptz
--   ) from service_role;
--   revoke execute on function public.abort_opportunity_finder_file_retention(uuid,text)
--     from service_role;
--   revoke execute on function public.commit_staged_opportunity_finder_output(
--     uuid,text,uuid,bigint,text,jsonb,jsonb,integer,integer,integer
--   ) from service_role;
--   revoke execute on function public.append_opportunity_finder_output(
--     uuid,text,uuid,bigint,text,text,bigint,jsonb
--   ) from service_role;
--   revoke execute on function public.begin_opportunity_finder_output(
--     uuid,text,uuid,bigint,text
--   ) from service_role;
--   revoke execute on function public.decide_opportunity_finder_review(uuid,text,uuid,text,text)
--     from authenticated, service_role;
--   revoke execute on function public.replace_opportunity_finder_job_output(
--     uuid,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,integer,integer,integer
--   ) from service_role;
--   revoke execute on function public.finalize_opportunity_finder_job(
--     uuid,text,uuid,text,jsonb,integer,integer,integer
--   ) from service_role;
--   revoke execute on function public.commit_opportunity_finder_allocations(uuid,text,uuid,jsonb)
--     from service_role;
--   revoke execute on function public.materialize_opportunity_finder_entities(uuid,text,uuid)
--     from service_role;
--
--   drop function if exists public.confirm_opportunity_finder_roles(
--     uuid,uuid,uuid,text,timestamptz,uuid,text,timestamptz
--   );
--   drop function if exists public.cancel_opportunity_finder_job(uuid,uuid);
--   drop function if exists public.retry_opportunity_finder_job(uuid,uuid);
--   drop function if exists public.queue_opportunity_finder_profile(
--     uuid,uuid,text,timestamptz
--   );
--   drop function if exists public.prepare_opportunity_finder_job_deletion(uuid,uuid);
--   drop function if exists public.prepare_opportunity_finder_expired_job_deletion(
--     uuid,text,timestamptz
--   );
--   drop function if exists public.finalize_opportunity_finder_job_deletion(uuid,uuid);
--   drop function if exists public.claim_opportunity_finder_file_retention(
--     integer,timestamptz
--   );
--   drop function if exists public.finalize_opportunity_finder_file_retention(
--     uuid,timestamptz
--   );
--   drop function if exists public.abort_opportunity_finder_file_retention(uuid,text);
--   drop function if exists public.commit_staged_opportunity_finder_output(
--     uuid,text,uuid,bigint,text,jsonb,jsonb,integer,integer,integer
--   );
--   drop function if exists public.append_opportunity_finder_output(
--     uuid,text,uuid,bigint,text,text,bigint,jsonb
--   );
--   drop function if exists public.begin_opportunity_finder_output(
--     uuid,text,uuid,bigint,text
--   );
--   drop function if exists public.decide_opportunity_finder_review(uuid,text,uuid,text,text);
--   drop function if exists public.replace_opportunity_finder_job_output(
--     uuid,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,integer,integer,integer
--   );
--   drop function if exists public.finalize_opportunity_finder_job(
--     uuid,text,uuid,text,jsonb,integer,integer,integer
--   );
--   drop function if exists public.commit_opportunity_finder_allocations(uuid,text,uuid,jsonb);
--   drop function if exists public.opportunity_finder_allocation_identity_kind(uuid,uuid,uuid,uuid);
--   drop function if exists public.opportunity_finder_candidate_uuid(text);
--   drop function if exists public.normalize_opportunity_unit_of_measure(text);
--   drop function if exists public.normalize_opportunity_manufacturer_exact(text);
--   drop function if exists public.materialize_opportunity_finder_entities(uuid,text,uuid);
--
--   alter table public.opportunity_finder_results
--     drop constraint if exists opportunity_finder_results_candidate_fk,
--     drop constraint if exists opportunity_finder_results_demand_event_fk;
--   alter table public.opportunity_finder_possible_matches
--     drop constraint if exists opportunity_finder_possible_demand_option_fk,
--     drop constraint if exists opportunity_finder_possible_supply_lot_fk;
--
--   drop table if exists public.opportunity_finder_output_items;
--   drop table if exists public.opportunity_finder_output_runs;
--   drop table if exists public.opportunity_finder_audit_events;
--   drop table if exists public.opportunity_finder_review_decisions;
--   drop table if exists public.opportunity_finder_part_equivalences;
--   drop table if exists public.opportunity_finder_part_equivalence_versions;
--   drop table if exists public.opportunity_finder_manufacturer_aliases;
--   drop table if exists public.opportunity_finder_manufacturers;
--   drop table if exists public.opportunity_finder_manufacturer_registry_versions;
--   drop table if exists public.opportunity_finder_rejected_rows;
--   drop table if exists public.opportunity_finder_result_financials;
--   drop table if exists public.opportunity_finder_result_commercials;
--   drop table if exists public.opportunity_finder_allocations;
--   drop table if exists public.opportunity_finder_historical_signals;
--   alter table if exists public.opportunity_finder_demand_part_options
--     drop column if exists unit_of_measure;
--   drop table if exists public.opportunity_finder_demand_part_options;
--   drop table if exists public.opportunity_finder_demand_events;
--   drop table if exists public.opportunity_finder_supply_lots;
--
--   alter table public.opportunity_finder_results
--     drop column if exists result_key,
--     drop column if exists demand_event_id,
--     drop column if exists demand_event_key,
--     drop column if exists candidate_id,
--     drop column if exists demand_mpn_original,
--     drop column if exists supply_mpn_original,
--     drop column if exists manufacturer_canonical,
--     drop column if exists exact_mpn_match,
--     drop column if exists match_tier,
--     drop column if exists confidence,
--     drop column if exists match_explanation,
--     drop column if exists review_status,
--     drop column if exists remaining_qty,
--     drop column if exists moq,
--     drop column if exists spq,
--     drop column if exists date_code,
--     drop column if exists coo,
--     drop column if exists lead_time_weeks,
--     drop column if exists condition,
--     drop column if exists expires_at,
--     drop column if exists demand_traces,
--     drop column if exists supply_traces,
--     drop column if exists allocations_trace;
--
--   alter table public.opportunity_finder_possible_matches
--     drop column if exists candidate_key,
--     drop column if exists demand_option_id,
--     drop column if exists supply_lot_id,
--     drop column if exists match_tier,
--     drop column if exists confidence,
--     drop column if exists explanation,
--     drop column if exists manufacturer_compatible,
--     drop column if exists review_status,
--     drop column if exists demand_trace,
--     drop column if exists supply_trace;
--
--   alter table public.opportunity_finder_rows
--     drop column if exists record_kind,
--     drop column if exists template_type,
--     drop column if exists mapping_version,
--     drop column if exists header_row,
--     drop column if exists source_row_hidden,
--     drop column if exists source_columns,
--     drop column if exists source_cell_refs,
--     drop column if exists raw_row,
--     drop column if exists demand_event_key,
--     drop column if exists demand_event_source_id,
--     drop column if exists supply_lot_key,
--     drop column if exists manufacturer_canonical,
--     drop column if exists manufacturer_alias_version,
--     drop column if exists snapshot_key,
--     drop column if exists client_item,
--     drop column if exists plant_facility,
--     drop column if exists end_customer,
--     drop column if exists option_ordinal,
--     drop column if exists is_primary_option,
--     drop column if exists is_approved_alternate,
--     drop column if exists is_active_demand,
--     drop column if exists raw_quantity,
--     drop column if exists required_date_quality,
--     drop column if exists target_price,
--     drop column if exists target_currency,
--     drop column if exists offer_price,
--     drop column if exists unit_cost,
--     drop column if exists currency,
--     drop column if exists currency_status,
--     drop column if exists moq,
--     drop column if exists spq,
--     drop column if exists date_code,
--     drop column if exists coo,
--     drop column if exists lead_time_weeks,
--     drop column if exists transit_time_weeks,
--     drop column if exists condition,
--     drop column if exists expires_at,
--     drop column if exists is_live_supply;
--
--   alter table public.opportunity_finder_files
--     drop column if exists content_sha256,
--     drop column if exists actual_size_bytes,
--     drop column if exists sha256_verified_at,
--     drop column if exists validation_status,
--     drop column if exists template_type,
--     drop column if exists mapping_version,
--     drop column if exists classification_confidence,
--     drop column if exists useful_row_count,
--     drop column if exists hidden_row_count,
--     drop column if exists column_mappings,
--     drop column if exists profile_warnings,
--     drop column if exists profile_errors,
--     drop column if exists profile_json,
--     drop column if exists validity_override_expires_at,
--     drop column if exists storage_deletion_token,
--     drop column if exists storage_deletion_started_at;
--
--   alter table public.opportunity_finder_jobs
--     drop column if exists client_context,
--     drop column if exists content_pair_sha256,
--     drop column if exists pipeline_version,
--     drop column if exists processing_fence,
--     drop column if exists lock_token,
--     drop column if exists materialized_lock_token,
--     drop column if exists materialized_at,
--     drop column if exists output_commit_key,
--     drop column if exists committed_fence,
--     drop column if exists committed_lock_token;
--   commit;
--
-- After the compensating migration, rerun the previous release's database
-- contract and only then restart legacy workers. Never run these DROP statements
-- directly in production or remove 20260808120000 from schema_migrations.
