-- QuikSol performance/scalability layer.
-- Additive only. This file is intentionally not applied by the application.
-- Source JSON remains in business_records and is fetched only by detail routes.

create extension if not exists pg_trgm;

create or replace function public.normalize_business_mpn_v1(value text)
returns text language sql immutable strict set search_path = public, pg_temp as $$
  select case
    when regexp_replace(upper(trim(value)), '\s+', '', 'g') ~ '^\d{1,3}([,.]\d{3})+$'
      then regexp_replace(regexp_replace(upper(trim(value)), '\s+', '', 'g'), '[,.]', '', 'g')
    else regexp_replace(upper(trim(value)), '\s+', '', 'g')
  end;
$$;
grant execute on function public.normalize_business_mpn_v1(text) to authenticated;

create or replace function public.search_executive_mpn_v1(
  p_mpn text,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table(records jsonb, total_count bigint)
language sql stable security invoker set search_path = public, pg_temp as $$
  with input as (
    select public.normalize_business_mpn_v1(p_mpn) normalized_mpn
  ), candidates as (
    select record.id, record.upload_batch_id, record.uploaded_by, record.category,
      record.created_at, record.line_id, record.client, record.customer, record.supplier,
      record.supplier_name, record.mpn, record.mpn_quoted, record.manufacturer,
      record.description, record.generic, record.po, record.qty, record.req_qty,
      record.price, record.gp_rate, record.lead_time_weeks,
      record.shipping_point_country, record.has_errors,
      case when profile.id is null then null else jsonb_build_object(
        'full_name',profile.full_name,'email',profile.email,'department',profile.department,
        'region',profile.region,'role',profile.role) end profiles,
      case when upload.id is null then null else jsonb_build_object(
        'original_file_name',upload.original_file_name,'detected_category',upload.detected_category,
        'status',upload.status,'created_at',upload.created_at) end upload_batches,
      case
        when public.normalize_business_mpn_v1(coalesce(record.mpn, '')) = input.normalized_mpn
          or public.normalize_business_mpn_v1(coalesce(record.mpn_quoted, '')) = input.normalized_mpn then 0
        when public.normalize_business_mpn_v1(coalesce(record.mpn, '')) like input.normalized_mpn || '%'
          or public.normalize_business_mpn_v1(coalesce(record.mpn_quoted, '')) like input.normalized_mpn || '%' then 1
        else 2
      end match_rank
    from public.business_records record
    cross join input
    left join public.profiles profile on profile.id = record.uploaded_by
    left join public.upload_batches upload on upload.id = record.upload_batch_id
    where input.normalized_mpn <> '' and record.archived_at is null
      and (
        public.normalize_business_mpn_v1(coalesce(record.mpn, '')) like '%' || input.normalized_mpn || '%'
        or public.normalize_business_mpn_v1(coalesce(record.mpn_quoted, '')) like '%' || input.normalized_mpn || '%'
      )
  ), page as (
    select * from candidates
    order by match_rank, created_at desc, id desc
    limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)
  )
  select coalesce((select jsonb_agg(to_jsonb(page) - 'match_rank'
    order by match_rank, created_at desc, id desc) from page), '[]'::jsonb),
    (select count(*) from candidates)::bigint;
$$;
grant execute on function public.search_executive_mpn_v1(text,integer,integer) to authenticated;
comment on function public.search_executive_mpn_v1(text,integer,integer) is
  'One RLS-scoped MPN query ranked by normalized exact, prefix, then contains match.';

create index if not exists business_records_active_keyset_idx
  on public.business_records (created_at desc, id desc)
  where archived_at is null;
create index if not exists business_records_active_mpn_quoted_created_idx
  on public.business_records (mpn_quoted, created_at desc, id desc)
  where archived_at is null;
create index if not exists business_records_active_mpn_created_idx
  on public.business_records (mpn, created_at desc, id desc)
  where archived_at is null;
create index if not exists business_records_active_customer_trgm_idx
  on public.business_records using gin (customer gin_trgm_ops)
  where archived_at is null and customer is not null;
create index if not exists business_records_active_client_trgm_idx
  on public.business_records using gin (client gin_trgm_ops)
  where archived_at is null and client is not null;
create index if not exists business_records_active_supplier_trgm_idx
  on public.business_records using gin (supplier gin_trgm_ops)
  where archived_at is null and supplier is not null;
create index if not exists business_records_active_supplier_name_trgm_idx
  on public.business_records using gin (supplier_name gin_trgm_ops)
  where archived_at is null and supplier_name is not null;
create index if not exists business_records_active_mpn_trgm_idx
  on public.business_records using gin (mpn gin_trgm_ops)
  where archived_at is null and mpn is not null;
create index if not exists business_records_active_mpn_quoted_trgm_idx
  on public.business_records using gin (mpn_quoted gin_trgm_ops)
  where archived_at is null and mpn_quoted is not null;
create index if not exists business_records_active_normalized_mpn_trgm_idx
  on public.business_records using gin (public.normalize_business_mpn_v1(mpn) gin_trgm_ops)
  where archived_at is null and mpn is not null;
create index if not exists business_records_active_normalized_mpn_quoted_trgm_idx
  on public.business_records using gin (public.normalize_business_mpn_v1(mpn_quoted) gin_trgm_ops)
  where archived_at is null and mpn_quoted is not null;
create index if not exists business_records_active_manufacturer_trgm_idx
  on public.business_records using gin (manufacturer gin_trgm_ops)
  where archived_at is null and manufacturer is not null;
create index if not exists business_records_active_clean_mfg_trgm_idx
  on public.business_records using gin (clean_mfg gin_trgm_ops)
  where archived_at is null and clean_mfg is not null;
create index if not exists business_records_active_po_trgm_idx
  on public.business_records using gin (po gin_trgm_ops)
  where archived_at is null and po is not null;
create index if not exists business_records_active_line_id_trgm_idx
  on public.business_records using gin (line_id gin_trgm_ops)
  where archived_at is null and line_id is not null;
create index if not exists business_records_active_country_trgm_idx
  on public.business_records using gin (shipping_point_country gin_trgm_ops)
  where archived_at is null and shipping_point_country is not null;

create index if not exists import_errors_created_id_idx
  on public.import_errors (created_at desc, id desc);
create index if not exists import_errors_type_created_id_idx
  on public.import_errors (error_type, created_at desc, id desc);
create index if not exists import_errors_search_trgm_idx
  on public.import_errors using gin ((coalesce(column_name, '') || ' ' || coalesce(error_type, '') || ' ' || coalesce(message, '')) gin_trgm_ops);

create index if not exists opportunity_finder_results_job_created_id_idx
  on public.opportunity_finder_results (job_id, created_at, id);
create index if not exists opportunity_finder_possible_job_created_id_idx
  on public.opportunity_finder_possible_matches (job_id, created_at, id);
create index if not exists opportunity_finder_rejected_job_row_id_idx
  on public.opportunity_finder_rejected_rows (job_id, source_row, id);
create index if not exists opportunity_finder_allocations_job_rank_id_idx
  on public.opportunity_finder_allocations (job_id, deterministic_rank, id);

create table public.business_upload_versions (
  upload_batch_id uuid primary key references public.upload_batches(id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
  data_version bigint not null default 1 check (data_version > 0),
  summary_version bigint check (summary_version is null or summary_version > 0),
  dirty boolean not null default true,
  source_watermark timestamptz,
  rebuilt_at timestamptz,
  rebuild_locked_at timestamptz,
  rebuild_locked_by text,
  rebuild_attempts integer not null default 0,
  last_rebuild_error_code text,
  updated_at timestamptz not null default now()
);

create table public.business_scope_counters (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  record_count bigint not null default 0 check (record_count >= 0),
  records_with_errors bigint not null default 0 check (records_with_errors >= 0),
  records_missing_mpn bigint not null default 0 check (records_missing_mpn >= 0),
  active_upload_count bigint not null default 0 check (active_upload_count >= 0),
  data_version bigint not null default 1 check (data_version > 0),
  updated_at timestamptz not null default now()
);

create table public.business_mpn_summaries (
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
  data_version bigint not null check (data_version > 0),
  normalized_mpn text not null,
  display_mpn text not null,
  customer_name text,
  supplier_name text,
  manufacturer_name text,
  manufacturer_names text[] not null default '{}',
  demand_qty numeric,
  stock_qty numeric,
  excess_qty numeric,
  received_qty numeric,
  stock_required_qty numeric,
  stock_available_qty numeric,
  stock_customer_name text,
  stock_supplier_name text,
  stock_manufacturer_name text,
  required_date text,
  lead_time text,
  unit_of_measure text,
  approved_part_signal boolean not null default false,
  received_signal boolean not null default false,
  source_record_count bigint not null default 0,
  warnings text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (upload_batch_id, data_version, normalized_mpn)
);

create index business_mpn_summaries_owner_version_mpn_idx
  on public.business_mpn_summaries (owner_id, data_version, normalized_mpn);
create index business_mpn_summaries_mpn_trgm_idx
  on public.business_mpn_summaries using gin (normalized_mpn gin_trgm_ops);
create index business_mpn_summaries_customer_trgm_idx
  on public.business_mpn_summaries using gin (customer_name gin_trgm_ops)
  where customer_name is not null;
create index business_mpn_summaries_supplier_trgm_idx
  on public.business_mpn_summaries using gin (supplier_name gin_trgm_ops)
  where supplier_name is not null;
create index business_mpn_summaries_manufacturer_trgm_idx
  on public.business_mpn_summaries using gin (manufacturer_name gin_trgm_ops)
  where manufacturer_name is not null;

alter table public.business_upload_versions enable row level security;
alter table public.business_scope_counters enable row level security;
alter table public.business_mpn_summaries enable row level security;
alter table public.business_upload_versions force row level security;
alter table public.business_scope_counters force row level security;
alter table public.business_mpn_summaries force row level security;

create policy business_upload_versions_select_scoped on public.business_upload_versions
  for select using (public.can_read_upload(owner_id));
create policy business_scope_counters_select_scoped on public.business_scope_counters
  for select using (public.can_read_upload(owner_id));
create policy business_mpn_summaries_select_scoped on public.business_mpn_summaries
  for select using (public.can_read_upload(owner_id));

revoke insert, update, delete on public.business_upload_versions from authenticated;
revoke insert, update, delete on public.business_scope_counters from authenticated;
revoke insert, update, delete on public.business_mpn_summaries from authenticated;
grant select on public.business_upload_versions, public.business_scope_counters, public.business_mpn_summaries to authenticated;
grant all on public.business_upload_versions, public.business_scope_counters, public.business_mpn_summaries to service_role;

insert into public.business_scope_counters (
  owner_id, record_count, records_with_errors, records_missing_mpn, active_upload_count
)
select
  profile.id,
  count(record.id) filter (where record.archived_at is null),
  count(record.id) filter (where record.archived_at is null and record.has_errors),
  count(record.id) filter (where record.archived_at is null and record.mpn is null),
  (select count(*) from public.upload_batches upload where upload.uploaded_by = profile.id and upload.archived_at is null and upload.status <> 'archived')
from public.profiles profile
left join public.business_records record on record.uploaded_by = profile.id
group by profile.id
on conflict (owner_id) do update set
  record_count = excluded.record_count,
  records_with_errors = excluded.records_with_errors,
  records_missing_mpn = excluded.records_missing_mpn,
  active_upload_count = excluded.active_upload_count,
  data_version = public.business_scope_counters.data_version + 1,
  updated_at = now();

insert into public.business_upload_versions (upload_batch_id, owner_id, source_watermark)
select upload.id, upload.uploaded_by, greatest(upload.completed_at, upload.created_at)
from public.upload_batches upload
on conflict (upload_batch_id) do nothing;

create function public.mark_business_rows_inserted_v1()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.business_scope_counters (owner_id, record_count, records_with_errors, records_missing_mpn)
  select uploaded_by,
    count(*) filter (where archived_at is null),
    count(*) filter (where archived_at is null and has_errors),
    count(*) filter (where archived_at is null and mpn is null)
  from new_business_rows group by uploaded_by
  on conflict (owner_id) do update set
    record_count = public.business_scope_counters.record_count + excluded.record_count,
    records_with_errors = public.business_scope_counters.records_with_errors + excluded.records_with_errors,
    records_missing_mpn = public.business_scope_counters.records_missing_mpn + excluded.records_missing_mpn,
    data_version = public.business_scope_counters.data_version + 1,
    updated_at = now();

  insert into public.business_upload_versions (upload_batch_id, owner_id, data_version, dirty, source_watermark)
  select upload_batch_id, uploaded_by, 1, true, max(created_at)
  from new_business_rows group by upload_batch_id, uploaded_by
  on conflict (upload_batch_id) do update set
    data_version = public.business_upload_versions.data_version + 1,
    dirty = true,
    source_watermark = greatest(public.business_upload_versions.source_watermark, excluded.source_watermark),
    updated_at = now();
  return null;
end $$;

create trigger business_records_summary_insert_v1
after insert on public.business_records
referencing new table as new_business_rows
for each statement execute function public.mark_business_rows_inserted_v1();

create function public.mark_business_rows_deleted_v1()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.business_scope_counters counter set
    record_count = greatest(counter.record_count - delta.record_count, 0),
    records_with_errors = greatest(counter.records_with_errors - delta.error_count, 0),
    records_missing_mpn = greatest(counter.records_missing_mpn - delta.missing_count, 0),
    data_version = counter.data_version + 1,
    updated_at = now()
  from (
    select uploaded_by,
      count(*) filter (where archived_at is null) record_count,
      count(*) filter (where archived_at is null and has_errors) error_count,
      count(*) filter (where archived_at is null and mpn is null) missing_count
    from old_business_rows group by uploaded_by
  ) delta where counter.owner_id = delta.uploaded_by;

  update public.business_upload_versions version set
    data_version = version.data_version + 1, dirty = true, updated_at = now()
  where version.upload_batch_id in (select distinct upload_batch_id from old_business_rows);
  return null;
end $$;

create trigger business_records_summary_delete_v1
after delete on public.business_records
referencing old table as old_business_rows
for each statement execute function public.mark_business_rows_deleted_v1();

create function public.recount_business_rows_updated_v1()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.business_scope_counters counter set
    record_count = greatest(counter.record_count + delta.record_delta,0),
    records_with_errors = greatest(counter.records_with_errors + delta.error_delta,0),
    records_missing_mpn = greatest(counter.records_missing_mpn + delta.missing_delta,0),
    data_version = counter.data_version + 1,
    updated_at = now()
  from (
    select owner_id,sum(record_delta) record_delta,sum(error_delta) error_delta,sum(missing_delta) missing_delta
    from (
      select uploaded_by owner_id,-(archived_at is null)::int record_delta,
        -(archived_at is null and has_errors)::int error_delta,
        -(archived_at is null and mpn is null)::int missing_delta
      from old_business_rows
      union all
      select uploaded_by,(archived_at is null)::int,(archived_at is null and has_errors)::int,
        (archived_at is null and mpn is null)::int
      from new_business_rows
    ) changes group by owner_id
  ) delta where counter.owner_id=delta.owner_id;

  insert into public.business_upload_versions (upload_batch_id, owner_id, dirty)
  select upload.id, upload.uploaded_by, true
  from public.upload_batches upload
  where upload.id in (
    select upload_batch_id from old_business_rows union select upload_batch_id from new_business_rows
  )
  on conflict (upload_batch_id) do update set
    data_version = public.business_upload_versions.data_version + 1,
    dirty = true,
    updated_at = now();
  return null;
end $$;

create trigger business_records_summary_update_v1
after update on public.business_records
referencing old table as old_business_rows new table as new_business_rows
for each statement execute function public.recount_business_rows_updated_v1();

create or replace function public.get_business_record_counter_v1()
returns table(record_count bigint, records_with_errors bigint, records_missing_mpn bigint, data_version bigint)
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(sum(counter.record_count), 0)::bigint,
    coalesce(sum(counter.records_with_errors), 0)::bigint,
    coalesce(sum(counter.records_missing_mpn), 0)::bigint,
    coalesce(max(counter.data_version), 0)::bigint
  from public.business_scope_counters counter;
$$;
grant execute on function public.get_business_record_counter_v1() to authenticated;

create or replace function public.replace_business_upload_summary_v1(
  target_upload_batch_id uuid,
  expected_data_version bigint,
  summary_rows jsonb
)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  locked_version public.business_upload_versions%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if jsonb_typeof(summary_rows) <> 'array' then raise exception 'summary_rows_must_be_array' using errcode = '22023'; end if;

  select * into locked_version from public.business_upload_versions
  where upload_batch_id = target_upload_batch_id for update;
  if not found or locked_version.data_version <> expected_data_version then
    raise exception 'summary_version_stale' using errcode = '40001';
  end if;

  insert into public.business_mpn_summaries (
    upload_batch_id, owner_id, data_version, normalized_mpn, display_mpn,
    customer_name, supplier_name, manufacturer_name, manufacturer_names,
    demand_qty, stock_qty, excess_qty, received_qty, stock_required_qty, stock_available_qty,
    stock_customer_name, stock_supplier_name, stock_manufacturer_name, required_date, lead_time,
    unit_of_measure, approved_part_signal, received_signal, source_record_count, warnings
  )
  select target_upload_batch_id, locked_version.owner_id, expected_data_version,
    row.normalized_mpn, coalesce(row.display_mpn, row.normalized_mpn), row.customer_name,
    row.supplier_name, row.manufacturer_name, coalesce(row.manufacturer_names, '{}'),
    row.demand_qty, row.stock_qty, row.excess_qty, row.received_qty, row.stock_required_qty,
    row.stock_available_qty, row.stock_customer_name, row.stock_supplier_name,
    row.stock_manufacturer_name, row.required_date,
    row.lead_time, row.unit_of_measure, coalesce(row.approved_part_signal, false),
    coalesce(row.received_signal, false), coalesce(row.source_record_count, 0), coalesce(row.warnings, '{}')
  from jsonb_to_recordset(summary_rows) as row(
    normalized_mpn text, display_mpn text, customer_name text, supplier_name text,
    manufacturer_name text, manufacturer_names text[], demand_qty numeric, stock_qty numeric,
    excess_qty numeric, received_qty numeric, stock_required_qty numeric, stock_available_qty numeric,
    stock_customer_name text, stock_supplier_name text, stock_manufacturer_name text,
    required_date text, lead_time text,
    unit_of_measure text, approved_part_signal boolean, received_signal boolean,
    source_record_count bigint, warnings text[]
  )
  on conflict (upload_batch_id, data_version, normalized_mpn) do update set
    display_mpn = excluded.display_mpn,
    customer_name = excluded.customer_name,
    supplier_name = excluded.supplier_name,
    manufacturer_name = excluded.manufacturer_name,
    manufacturer_names = excluded.manufacturer_names,
    demand_qty = excluded.demand_qty,
    stock_qty = excluded.stock_qty,
    excess_qty = excluded.excess_qty,
    received_qty = excluded.received_qty,
    stock_required_qty = excluded.stock_required_qty,
    stock_available_qty = excluded.stock_available_qty,
    stock_customer_name = excluded.stock_customer_name,
    stock_supplier_name = excluded.stock_supplier_name,
    stock_manufacturer_name = excluded.stock_manufacturer_name,
    required_date = excluded.required_date,
    lead_time = excluded.lead_time,
    unit_of_measure = excluded.unit_of_measure,
    approved_part_signal = excluded.approved_part_signal,
    received_signal = excluded.received_signal,
    source_record_count = excluded.source_record_count,
    warnings = excluded.warnings;

  update public.business_upload_versions set
    summary_version = expected_data_version,
    dirty = false,
    rebuilt_at = now(),
    rebuild_locked_at = null,
    rebuild_locked_by = null,
    last_rebuild_error_code = null,
    updated_at = now()
  where upload_batch_id = target_upload_batch_id and data_version = expected_data_version;
  return expected_data_version;
end $$;
revoke all on function public.replace_business_upload_summary_v1(uuid, bigint, jsonb) from public, authenticated;
grant execute on function public.replace_business_upload_summary_v1(uuid, bigint, jsonb) to service_role;

create or replace function public.get_opportunity_summary_v1()
returns table(
  ready boolean, data_version bigint, total_opportunities bigint, immediate_sale bigint,
  partial_sale bigint, excess_resale bigint, sourcing_needed bigint,
  stock_without_demand bigint, approved_part_matches bigint, received_history_matches bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with visible_uploads as (
    select upload.id, version.data_version, version.summary_version, version.dirty
    from public.upload_batches upload
    left join public.business_upload_versions version on version.upload_batch_id = upload.id
    where upload.archived_at is null and upload.status <> 'archived'
  ), readiness as (
    select not exists (
      select 1 from visible_uploads where dirty is distinct from false or summary_version is distinct from data_version
    ) ready, coalesce(max(data_version), 0)::bigint data_version
    from visible_uploads
  ), grouped as (
    select summary.normalized_mpn,
      coalesce(sum(summary.demand_qty), 0) demand_qty,
      coalesce(sum(summary.stock_qty), 0) stock_qty,
      coalesce(sum(summary.excess_qty), 0) excess_qty,
      bool_or(summary.approved_part_signal) approved,
      bool_or(summary.received_signal) received
    from public.business_mpn_summaries summary
    join visible_uploads visible on visible.id = summary.upload_batch_id and visible.summary_version = summary.data_version
    group by summary.normalized_mpn
  ), classified as (
    select *,
      (demand_qty > 0 and stock_qty >= demand_qty)::int immediate,
      (demand_qty > 0 and stock_qty > 0 and stock_qty < demand_qty)::int partial,
      (demand_qty > 0 and excess_qty > 0)::int excess,
      (demand_qty > 0 and stock_qty <= 0 and excess_qty <= 0)::int sourcing,
      (demand_qty <= 0 and (stock_qty > 0 or excess_qty > 0))::int stock_only
    from grouped
  )
  select readiness.ready, readiness.data_version,
    coalesce(sum(immediate + partial + excess + sourcing + stock_only), 0)::bigint,
    coalesce(sum(immediate), 0)::bigint, coalesce(sum(partial), 0)::bigint,
    coalesce(sum(excess), 0)::bigint, coalesce(sum(sourcing), 0)::bigint,
    coalesce(sum(stock_only), 0)::bigint,
    coalesce(sum((immediate + partial + excess + sourcing + stock_only) * approved::int), 0)::bigint,
    coalesce(sum((immediate + partial + excess + sourcing + stock_only) * received::int), 0)::bigint
  from readiness left join classified on true group by readiness.ready, readiness.data_version;
$$;
grant execute on function public.get_opportunity_summary_v1() to authenticated;

comment on table public.business_mpn_summaries is
  'Exact, versioned derived data. raw_data and normalized_data remain only in business_records. Dirty versions are never served.';
comment on function public.replace_business_upload_summary_v1(uuid, bigint, jsonb) is
  'Atomic publish boundary for a fully reconciled upload summary. Stale rebuilds fail with 40001.';

create or replace function public.recount_business_uploads_v1()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.business_scope_counters (owner_id, active_upload_count, data_version)
  select owner.id,
    (select count(*) from public.upload_batches upload
      where upload.uploaded_by = owner.id and upload.archived_at is null and upload.status <> 'archived'),
    1
  from (
    select uploaded_by id from new_business_uploads
    union
    select uploaded_by from old_business_uploads
  ) owner
  on conflict (owner_id) do update set
    active_upload_count = excluded.active_upload_count,
    data_version = public.business_scope_counters.data_version + 1,
    updated_at = now();
  return null;
end $$;

create trigger upload_batches_counter_update_v1
after update on public.upload_batches
referencing old table as old_business_uploads new table as new_business_uploads
for each statement execute function public.recount_business_uploads_v1();

create function public.count_business_upload_insert_v1()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.business_scope_counters (owner_id, active_upload_count)
  select uploaded_by, count(*) filter (where archived_at is null and status <> 'archived')
  from new_business_uploads group by uploaded_by
  on conflict (owner_id) do update set
    active_upload_count = public.business_scope_counters.active_upload_count + excluded.active_upload_count,
    data_version = public.business_scope_counters.data_version + 1,
    updated_at = now();
  insert into public.business_upload_versions(upload_batch_id,owner_id,source_watermark)
  select id,uploaded_by,created_at from new_business_uploads on conflict(upload_batch_id) do nothing;
  return null;
end $$;
create trigger upload_batches_counter_insert_v1 after insert on public.upload_batches
referencing new table as new_business_uploads for each statement execute function public.count_business_upload_insert_v1();

create function public.count_business_upload_delete_v1()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.business_scope_counters counter set
    active_upload_count = greatest(counter.active_upload_count - removed.amount, 0),
    data_version = counter.data_version + 1,
    updated_at = now()
  from (
    select uploaded_by, count(*) filter (where archived_at is null and status <> 'archived') amount
    from old_business_uploads group by uploaded_by
  ) removed where counter.owner_id = removed.uploaded_by;
  return null;
end $$;
create trigger upload_batches_counter_delete_v1 after delete on public.upload_batches
referencing old table as old_business_uploads for each statement execute function public.count_business_upload_delete_v1();

create or replace function public.get_dashboard_summary_v1()
returns table(
  total_records bigint,
  total_uploads bigint,
  records_with_errors bigint,
  records_missing_mpn bigint,
  data_version bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(sum(record_count), 0)::bigint,
    coalesce(sum(active_upload_count), 0)::bigint,
    coalesce(sum(records_with_errors), 0)::bigint,
    coalesce(sum(records_missing_mpn), 0)::bigint,
    coalesce(max(data_version), 0)::bigint
  from public.business_scope_counters;
$$;
grant execute on function public.get_dashboard_summary_v1() to authenticated;

create or replace function public.claim_business_summary_rebuilds_v1(worker_id text, batch_limit integer default 4)
returns table(upload_batch_id uuid, data_version bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  return query
  with candidates as (
    select version.upload_batch_id
    from public.business_upload_versions version
    join public.upload_batches upload on upload.id = version.upload_batch_id
    where version.dirty
      and upload.archived_at is null
      and upload.status in ('completed', 'completed_with_warnings')
      and (version.rebuild_locked_at is null or version.rebuild_locked_at < now() - interval '10 minutes')
    order by version.updated_at, version.upload_batch_id
    for update of version skip locked
    limit least(greatest(batch_limit, 1), 20)
  ), claimed as (
    update public.business_upload_versions version set
      rebuild_locked_at = now(), rebuild_locked_by = worker_id,
      rebuild_attempts = rebuild_attempts + 1, last_rebuild_error_code = null
    from candidates where version.upload_batch_id = candidates.upload_batch_id
    returning version.upload_batch_id, version.data_version
  ) select claimed.upload_batch_id, claimed.data_version from claimed;
end $$;
revoke all on function public.claim_business_summary_rebuilds_v1(text, integer) from public, authenticated;
grant execute on function public.claim_business_summary_rebuilds_v1(text, integer) to service_role;

create or replace function public.release_business_summary_rebuild_v1(
  target_upload_batch_id uuid, worker_id text, error_code text default null
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  update public.business_upload_versions set rebuild_locked_at = null, rebuild_locked_by = null,
    last_rebuild_error_code = left(regexp_replace(coalesce(error_code, 'unknown'), '[^A-Za-z0-9_.-]', '', 'g'), 80),
    updated_at = now()
  where upload_batch_id = target_upload_batch_id and rebuild_locked_by = worker_id;
end $$;
revoke all on function public.release_business_summary_rebuild_v1(uuid, text, text) from public, authenticated;
grant execute on function public.release_business_summary_rebuild_v1(uuid, text, text) to service_role;

create or replace function public.get_stock_needs_page_v1(
  p_limit integer default 50, p_offset integer default 0, p_q text default null,
  p_customer text default null, p_supplier text default null, p_manufacturer text default null,
  p_status text default null, p_coverage text default null, p_upload_batch_id uuid default null
)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
with visible as (
  select summary.*, upload.original_file_name, upload.detected_category, upload.status import_status,
    upload.created_at upload_created_at,
    profile.detected_template, (profile.upload_batch_id is null) missing_profile
  from public.business_mpn_summaries summary
  join public.business_upload_versions version on version.upload_batch_id = summary.upload_batch_id
    and version.summary_version = summary.data_version and not version.dirty
  join public.upload_batches upload on upload.id = summary.upload_batch_id
    and upload.archived_at is null and upload.status <> 'archived'
  left join public.file_schema_profiles profile on profile.upload_batch_id = upload.id
  where p_upload_batch_id is null or summary.upload_batch_id = p_upload_batch_id
), grouped as (
  select normalized_mpn, min(display_mpn) display_mpn,
    (array_agg(stock_customer_name order by upload_created_at desc, upload_batch_id desc) filter (where stock_customer_name is not null))[1] customer_name,
    (array_agg(stock_supplier_name order by upload_created_at desc, upload_batch_id desc) filter (where stock_supplier_name is not null))[1] supplier_name,
    (array_agg(stock_manufacturer_name order by upload_created_at desc, upload_batch_id desc) filter (where stock_manufacturer_name is not null))[1] manufacturer_name,
    nullif(sum(stock_required_qty), 0) demand_qty, nullif(sum(stock_available_qty), 0) stock_qty,
    (array_agg(required_date order by upload_created_at desc, upload_batch_id desc) filter (where required_date is not null))[1] required_date,
    (array_agg(lead_time order by upload_created_at desc, upload_batch_id desc) filter (where lead_time is not null))[1] lead_time,
    bool_or(missing_profile) missing_profile,
    array_agg(distinct upload_batch_id) upload_ids,
    to_jsonb((array_agg(jsonb_build_object('uploadBatchId', upload_batch_id, 'fileName', original_file_name,
      'detectedTemplate', coalesce(detected_template, detected_category), 'importStatus', import_status)
      order by upload_created_at desc, upload_batch_id desc))[1:5]) source_uploads
  from visible group by normalized_mpn
), classified as (
  select *, greatest(coalesce(demand_qty, 0) - coalesce(stock_qty, 0), 0) shortage_qty,
    case when demand_qty is null and coalesce(stock_qty,0) > 0 then 'overstock'
      when demand_qty is null then 'unknown' when coalesce(stock_qty,0) <= 0 then 'no_stock'
      when stock_qty < demand_qty then 'partial_stock' when stock_qty > demand_qty then 'overstock' else 'in_stock' end coverage_status
  from grouped
), filtered as (
  select * from classified where
    (p_q is null or normalized_mpn like '%' || public.normalize_business_mpn_v1(p_q) || '%')
    and (p_customer is null or customer_name ilike '%' || p_customer || '%')
    and case when p_supplier is not null and p_manufacturer is not null and p_supplier = p_manufacturer
      then coalesce(supplier_name ilike '%' || p_supplier || '%', false)
        or coalesce(manufacturer_name ilike '%' || p_manufacturer || '%', false)
      else (p_supplier is null or supplier_name ilike '%' || p_supplier || '%')
        and (p_manufacturer is null or manufacturer_name ilike '%' || p_manufacturer || '%') end
    and (p_status is null or exists (select 1 from visible v where v.normalized_mpn = classified.normalized_mpn and v.import_status = p_status))
    and (p_coverage is null or coverage_status = p_coverage)
), totals as (
  select count(*) total_items, count(*) filter(where coverage_status='in_stock') in_stock,
    count(*) filter(where coverage_status='partial_stock') partial_stock,
    count(*) filter(where coverage_status='no_stock') no_stock,
    count(*) filter(where coverage_status='overstock') overstock,
    count(*) filter(where coverage_status='unknown') unknown,
    coalesce(sum(demand_qty),0) total_required_qty, coalesce(sum(stock_qty),0) total_stock_qty
  from filtered
), page as (
  select * from filtered order by
    case coverage_status when 'no_stock' then 0 when 'partial_stock' then 1 when 'unknown' then 2 when 'in_stock' then 3 else 4 end,
    normalized_mpn limit least(greatest(p_limit,1),200) offset greatest(p_offset,0)
)
select jsonb_build_object(
  'items', coalesce((select jsonb_agg(jsonb_build_object('mpn',display_mpn,'customerName',customer_name,
    'manufacturerName',manufacturer_name,'supplierName',supplier_name,'requiredQty',demand_qty,'stockQty',stock_qty,
    'availableQty',stock_qty,'shortageQty',shortage_qty,'coverageStatus',coverage_status,'requiredDate',required_date,
    'leadTime',lead_time,'sourceUploads',source_uploads,'warnings','[]'::jsonb)) from page), '[]'::jsonb),
  'totals', (select jsonb_build_object('totalItems',total_items,'inStock',in_stock,'partialStock',partial_stock,
    'noStock',no_stock,'overstock',overstock,'unknown',unknown,'totalRequiredQty',total_required_qty,'totalStockQty',total_stock_qty) from totals),
  'meta', jsonb_build_object('limit',least(greatest(p_limit,1),200),'offset',greatest(p_offset,0),
    'returnedItems',(select count(*) from page),'scannedRecords',0,
    'missingProfileCount',(select count(distinct id) from public.upload_batches id where false),
    'missingProfileUploadIds','[]'::jsonb,'hasMissingProfiles',coalesce((select bool_or(missing_profile) from filtered),false)),
  'summaryReady', not exists (select 1 from public.business_upload_versions v join public.upload_batches u on u.id=v.upload_batch_id
    where u.archived_at is null and u.status <> 'archived'
      and (p_upload_batch_id is null or u.id = p_upload_batch_id)
      and (v.dirty or v.summary_version is distinct from v.data_version))
);
$$;
grant execute on function public.get_stock_needs_page_v1(integer,integer,text,text,text,text,text,text,uuid) to authenticated;

create or replace function public.get_sales_opportunities_page_v1(
  p_limit integer default 50, p_offset integer default 0, p_q text default null, p_mpn text default null,
  p_customer text default null, p_supplier text default null, p_manufacturer text default null,
  p_opportunity_type text default null, p_upload_batch_id uuid default null,
  p_client_id uuid default null
)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
with visible as (
  select summary.*, upload.original_file_name, upload.detected_category, upload.status import_status,
    upload.created_at upload_created_at
  from public.business_mpn_summaries summary
  join public.business_upload_versions version on version.upload_batch_id = summary.upload_batch_id
    and version.summary_version = summary.data_version and not version.dirty
  join public.upload_batches upload on upload.id = summary.upload_batch_id
    and upload.archived_at is null and upload.status <> 'archived'
  where (p_upload_batch_id is null or summary.upload_batch_id = p_upload_batch_id)
    and (p_client_id is null or exists (
      select 1 from public.client_upload_assignments assignment
      where assignment.upload_batch_id = summary.upload_batch_id and assignment.client_id = p_client_id
    ))
), grouped as (
  select normalized_mpn, min(display_mpn) display_mpn,
    (array_agg(customer_name order by upload_created_at desc, upload_batch_id desc) filter (where customer_name is not null))[1] customer_name,
    (array_agg(supplier_name order by upload_created_at desc, upload_batch_id desc) filter (where supplier_name is not null))[1] supplier_name,
    (array_agg(manufacturer_name order by upload_created_at desc, upload_batch_id desc) filter (where manufacturer_name is not null))[1] manufacturer_name,
    nullif(sum(demand_qty),0) demand_qty, nullif(sum(stock_qty),0) stock_qty,
    nullif(sum(excess_qty),0) excess_qty, nullif(sum(received_qty),0) received_qty,
    bool_or(approved_part_signal) approved_part_signal, bool_or(received_signal) received_signal,
    to_jsonb((array_agg(jsonb_build_object('uploadBatchId',upload_batch_id,'fileName',original_file_name,
      'detectedTemplate',detected_category,'importStatus',import_status)
      order by upload_created_at desc, upload_batch_id desc))[1:6]) source_uploads,
    array(select distinct warning from visible warning_source
      cross join lateral unnest(warning_source.warnings) warning
      where warning_source.normalized_mpn = visible.normalized_mpn order by warning limit 8) warnings
  from visible group by normalized_mpn
), typed as (
  select grouped.*,
    opportunity_type,
    greatest(coalesce(demand_qty,0) - coalesce(stock_qty,0)
      - case when opportunity_type='excess_resale' then coalesce(excess_qty,0) else 0 end, 0) shortage_qty
  from grouped cross join lateral (
    select 'immediate_sale' opportunity_type where coalesce(demand_qty,0)>0 and coalesce(stock_qty,0)>=demand_qty
    union all select 'partial_sale' where coalesce(demand_qty,0)>0 and coalesce(stock_qty,0)>0 and stock_qty<demand_qty
    union all select 'sourcing_needed' where coalesce(demand_qty,0)>0 and coalesce(stock_qty,0)<=0 and coalesce(excess_qty,0)<=0
    union all select 'excess_resale' where coalesce(demand_qty,0)>0 and coalesce(excess_qty,0)>0
    union all select 'stock_without_demand' where coalesce(demand_qty,0)<=0 and (coalesce(stock_qty,0)>0 or coalesce(excess_qty,0)>0)
  ) kinds
), filtered as (
  select * from typed where
    (p_mpn is null or normalized_mpn = public.normalize_business_mpn_v1(p_mpn))
    and (p_q is null or normalized_mpn like '%' || public.normalize_business_mpn_v1(p_q) || '%')
    and (p_customer is null or customer_name ilike '%' || p_customer || '%')
    and case when p_supplier is not null and p_manufacturer is not null and p_supplier = p_manufacturer
      then coalesce(supplier_name ilike '%' || p_supplier || '%', false)
        or coalesce(manufacturer_name ilike '%' || p_manufacturer || '%', false)
      else (p_supplier is null or supplier_name ilike '%' || p_supplier || '%')
        and (p_manufacturer is null or manufacturer_name ilike '%' || p_manufacturer || '%') end
    and (p_opportunity_type is null or opportunity_type = p_opportunity_type)
), totals as (
  select count(*) total_opportunities,
    count(*) filter(where opportunity_type='immediate_sale') immediate_sale,
    count(*) filter(where opportunity_type='partial_sale') partial_sale,
    count(*) filter(where opportunity_type='excess_resale') excess_resale,
    count(*) filter(where opportunity_type='sourcing_needed') sourcing_needed,
    count(*) filter(where opportunity_type='stock_without_demand') stock_without_demand,
    count(*) filter(where approved_part_signal) approved_part_matches,
    count(*) filter(where received_signal) received_history_matches
  from filtered
), page as (
  select * from filtered order by
    case opportunity_type when 'immediate_sale' then 0 when 'partial_sale' then 1 when 'excess_resale' then 2 when 'sourcing_needed' then 3 else 4 end,
    coalesce(demand_qty,-1) desc, shortage_qty desc, display_mpn
  limit least(greatest(p_limit,1),200) offset greatest(p_offset,0)
)
select jsonb_build_object(
  'items', coalesce((select jsonb_agg(jsonb_build_object(
    'id',opportunity_type || ':' || normalized_mpn,'opportunityType',opportunity_type,'mpn',display_mpn,
    'normalizedMpn',normalized_mpn,'customerNeedName',customer_name,
    'excessOwnerName',case when opportunity_type in ('excess_resale','stock_without_demand') then coalesce(customer_name,supplier_name,manufacturer_name) end,
    'supplierName',supplier_name,'manufacturerName',manufacturer_name,'requiredQty',demand_qty,'availableQty',stock_qty,
    'excessQty',excess_qty,'receivedQty',received_qty,'shortageQty',shortage_qty,
    'approvedPartSignal',approved_part_signal,'receivedSignal',received_signal,'accountClients','[]'::jsonb,
    'sourceUploads',source_uploads,'dataQualityFlags',to_jsonb(warnings))) from page), '[]'::jsonb),
  'totals', (select jsonb_build_object('totalOpportunities',total_opportunities,'immediateSale',immediate_sale,
    'partialSale',partial_sale,'excessResale',excess_resale,'sourcingNeeded',sourcing_needed,
    'stockWithoutDemand',stock_without_demand,'approvedPartMatches',approved_part_matches,
    'receivedHistoryMatches',received_history_matches) from totals),
  'meta', jsonb_build_object('limit',least(greatest(p_limit,1),200),'offset',greatest(p_offset,0),
    'returnedItems',(select count(*) from page),'scannedRecords',0,
    'scannedUploads',(select count(distinct upload_batch_id) from visible),
    'totalBeforePagination',(select total_opportunities from totals)),
  'summaryReady', not exists (select 1 from public.business_upload_versions v join public.upload_batches u on u.id=v.upload_batch_id
    where u.archived_at is null and u.status <> 'archived'
      and (p_upload_batch_id is null or u.id = p_upload_batch_id)
      and (p_client_id is null or exists (
        select 1 from public.client_upload_assignments assignment
        where assignment.upload_batch_id = u.id and assignment.client_id = p_client_id
      ))
      and (v.dirty or v.summary_version is distinct from v.data_version))
);
$$;
grant execute on function public.get_sales_opportunities_page_v1(integer,integer,text,text,text,text,text,text,uuid,uuid) to authenticated;

create table public.observability_log_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','completed','dead_letter')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index observability_log_outbox_pending_idx on public.observability_log_outbox(next_attempt_at, created_at)
  where status in ('pending','processing');
alter table public.observability_log_outbox enable row level security;
alter table public.observability_log_outbox force row level security;
revoke all on public.observability_log_outbox from public, anon, authenticated;
grant all on public.observability_log_outbox to service_role;

create or replace function public.claim_observability_log_outbox_v1(worker_id text, batch_limit integer default 50)
returns setof public.observability_log_outbox
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  return query with candidates as (
    select id from public.observability_log_outbox
    where (status='pending' and next_attempt_at <= now())
      or (status='processing' and locked_at < now() - interval '10 minutes')
    order by created_at, id for update skip locked limit least(greatest(batch_limit,1),200)
  ) update public.observability_log_outbox event set status='processing', locked_at=now(), locked_by=worker_id,
    attempts=attempts+1 from candidates where event.id=candidates.id returning event.*;
end $$;
revoke all on function public.claim_observability_log_outbox_v1(text,integer) from public,authenticated;
grant execute on function public.claim_observability_log_outbox_v1(text,integer) to service_role;

create or replace function public.complete_observability_log_outbox_v1(event_id uuid, worker_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  update public.observability_log_outbox set status='completed',completed_at=now(),locked_at=null,locked_by=null
  where id=event_id and status='processing' and locked_by=worker_id;
end $$;
revoke all on function public.complete_observability_log_outbox_v1(uuid,text) from public,authenticated;
grant execute on function public.complete_observability_log_outbox_v1(uuid,text) to service_role;

create or replace function public.fail_observability_log_outbox_v1(event_id uuid, worker_id text, error_code text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  update public.observability_log_outbox set
    status=case when attempts >= 8 then 'dead_letter' else 'pending' end,
    next_attempt_at=now() + make_interval(secs => least(300, power(2,least(attempts,8))::integer)),
    locked_at=null,locked_by=null,last_error_code=left(regexp_replace(coalesce(error_code,'unknown'),'[^A-Za-z0-9_.-]','','g'),80)
  where id=event_id and status='processing' and locked_by=worker_id;
end $$;
revoke all on function public.fail_observability_log_outbox_v1(uuid,text,text) from public,authenticated;
grant execute on function public.fail_observability_log_outbox_v1(uuid,text,text) to service_role;

comment on table public.observability_log_outbox is
  'Durable async observability only. Critical audit events remain synchronous in their authoritative audit tables.';

create or replace function public.get_client_business_metrics_v1(target_client_ids uuid[])
returns table(
  client_id uuid, mpn_count bigint, opportunity_count bigint, immediate_sale_count bigint,
  partial_sale_count bigint, sourcing_needed_count bigint, stock_without_demand_count bigint,
  high_confidence_count bigint, summary_ready boolean
)
language sql stable security invoker set search_path = public, pg_temp as $$
with assigned as (
  select assignment.client_id, summary.*
  from public.client_upload_assignments assignment
  join public.upload_batches upload on upload.id=assignment.upload_batch_id
    and upload.archived_at is null and upload.status <> 'archived'
  join public.business_upload_versions version on version.upload_batch_id=assignment.upload_batch_id
    and not version.dirty and version.summary_version=version.data_version
  join public.business_mpn_summaries summary on summary.upload_batch_id=version.upload_batch_id
    and summary.data_version=version.summary_version
  where assignment.client_id=any(target_client_ids)
), grouped as (
  select client_id,normalized_mpn,sum(coalesce(demand_qty,0)) demand_qty,
    sum(coalesce(stock_qty,0)) stock_qty,sum(coalesce(excess_qty,0)) excess_qty,
    bool_or(customer_name is not null) has_customer,
    bool_or(supplier_name is not null or manufacturer_name is not null) has_partner,
    bool_or(approved_part_signal) approved,bool_or(received_signal) received,
    count(distinct upload_batch_id) source_uploads,
    (select count(distinct warning) from assigned warning_source
      cross join lateral unnest(warning_source.warnings) warning
      where warning_source.client_id=assigned.client_id and warning_source.normalized_mpn=assigned.normalized_mpn) warning_count
  from assigned
  group by client_id,normalized_mpn
), typed as (
  select grouped.*,kind,
    greatest(demand_qty-stock_qty-case when kind='excess_resale' then excess_qty else 0 end,0) shortage,
    30 + 10 + case when demand_qty>0 then 10 else 0 end
      + case when stock_qty>0 or excess_qty>0 then 10 else 0 end
      + case when greatest(demand_qty-stock_qty-case when kind='excess_resale' then excess_qty else 0 end,0)>0 then 5 else 0 end
      + case when has_customer then 10 else 0 end
      + case when has_partner then 5 else 0 end + case when approved then 10 else 0 end
      + case when received then 5 else 0 end + case when source_uploads>1 then 5 else 0 end
      - least(warning_count*5,20) confidence_score
  from grouped cross join lateral (
    select 'immediate_sale' kind where demand_qty>0 and stock_qty>=demand_qty
    union all select 'partial_sale' where demand_qty>0 and stock_qty>0 and stock_qty<demand_qty
    union all select 'sourcing_needed' where demand_qty>0 and stock_qty<=0 and excess_qty<=0
    union all select 'excess_resale' where demand_qty>0 and excess_qty>0
    union all select 'stock_without_demand' where demand_qty<=0 and (stock_qty>0 or excess_qty>0)
  ) types
), clients as (select unnest(target_client_ids) client_id)
select clients.client_id,count(distinct grouped.normalized_mpn)::bigint,count(typed.kind)::bigint,
  count(*) filter(where typed.kind='immediate_sale')::bigint,
  count(*) filter(where typed.kind='partial_sale')::bigint,
  count(*) filter(where typed.kind='sourcing_needed')::bigint,
  count(*) filter(where typed.kind='stock_without_demand')::bigint,
  count(*) filter(where typed.confidence_score>=75)::bigint,
  not exists (
    select 1 from public.client_upload_assignments assignment
    join public.upload_batches upload on upload.id=assignment.upload_batch_id
      and upload.archived_at is null and upload.status <> 'archived'
    left join public.business_upload_versions version on version.upload_batch_id=assignment.upload_batch_id
    where assignment.client_id=clients.client_id
      and (version.upload_batch_id is null or version.dirty or version.summary_version is distinct from version.data_version)
  ) summary_ready
from clients left join grouped using(client_id) left join typed using(client_id,normalized_mpn)
group by clients.client_id;
$$;
grant execute on function public.get_client_business_metrics_v1(uuid[]) to authenticated;
