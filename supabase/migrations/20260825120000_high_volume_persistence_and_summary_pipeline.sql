-- Ronda 7: bounded, fenced business-summary persistence and chunked
-- Opportunity Finder dataset snapshots. This migration is additive: it does
-- not rebuild production summaries and does not delete business data on apply.

-- Fail closed and keep the complete R7 cutover atomic.  The deterministic
-- table locks stop writers before any statement below can fire the previous
-- row-hot watermark implementation; SECTION D replaces it and initializes the
-- sequence-backed watermark from the final state before COMMIT.
begin;
set local lock_timeout = '15s';

do $$
declare
  item record;
begin
  for item in
    select schema_name, table_name
    from public.database_safety_table_catalog_v2()
    where planned_action = 'DELETE'
    order by schema_name, table_name
  loop
    execute format(
      'lock table %I.%I in share row exclusive mode',
      item.schema_name,
      item.table_name
    );
  end loop;

  if to_regclass('storage.objects') is not null then
    lock table storage.objects in share row exclusive mode;
  end if;

  perform 1
  from public.database_safety_state
  where singleton
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'DATABASE_SAFETY_STATE_MISSING';
  end if;
end;
$$;

-- ================================================================
-- SECTION A: BUSINESS SUMMARY JOB AUTHORITY AND PRIVATE STAGING
-- Owned by r7_summary_pipeline.
-- ================================================================

alter table public.business_upload_versions
  add column rebuild_status text not null default 'queued',
  add column rebuild_target_version bigint,
  add column rebuild_id uuid,
  add column rebuild_generation bigint not null default 0,
  add column rebuild_fence_token bigint not null default 0,
  add column rebuild_lease_expires_at timestamptz,
  add column rebuild_heartbeat_at timestamptz,
  add column rebuild_next_retry_at timestamptz,
  add column rebuild_max_attempts integer not null default 8,
  add column rebuild_last_chunk_sequence integer not null default -1,
  add column rebuild_last_chunk_fingerprint text,
  add column rebuild_last_cursor_created_at timestamptz,
  add column rebuild_last_cursor_id uuid,
  add column rebuild_rows_processed bigint not null default 0,
  add column rebuild_summary_partial_count bigint not null default 0,
  add column rebuild_entity_count bigint not null default 0,
  add column rebuild_peak_chunk_rows integer not null default 0,
  add column rebuild_peak_payload_bytes bigint not null default 0,
  add column rebuild_source_fingerprint text,
  add column rebuild_started_at timestamptz,
  add column rebuild_evaluation_at timestamptz,
  add column last_published_rebuild_id uuid,
  add column last_published_generation bigint,
  add column last_published_fence_token bigint,
  add column last_published_data_version bigint,
  add column last_published_source_fingerprint text,
  add column last_published_source_rows bigint,
  add column last_published_summary_rows bigint,
  add column last_published_entity_rows bigint,
  add column last_published_result jsonb,
  add column last_published_at timestamptz;

alter table public.business_upload_versions
  add constraint business_upload_versions_rebuild_status_check
    check (rebuild_status in ('ready', 'queued', 'rebuilding', 'retrying', 'failed')),
  add constraint business_upload_versions_rebuild_target_check
    check (rebuild_target_version is null or rebuild_target_version > 0),
  add constraint business_upload_versions_rebuild_generation_check
    check (rebuild_generation >= 0),
  add constraint business_upload_versions_rebuild_fence_check
    check (rebuild_fence_token >= 0),
  add constraint business_upload_versions_rebuild_attempts_check
    check (rebuild_attempts >= 0 and rebuild_max_attempts between 1 and 32),
  add constraint business_upload_versions_rebuild_progress_check
    check (
      rebuild_last_chunk_sequence >= -1
      and rebuild_rows_processed >= 0
      and rebuild_summary_partial_count >= 0
      and rebuild_entity_count >= 0
      and rebuild_peak_chunk_rows >= 0
      and rebuild_peak_payload_bytes >= 0
    ),
  add constraint business_upload_versions_rebuild_fingerprint_check
    check (rebuild_source_fingerprint is null or rebuild_source_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint business_upload_versions_rebuild_chunk_fingerprint_check
    check (rebuild_last_chunk_fingerprint is null or rebuild_last_chunk_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint business_upload_versions_publish_receipt_check
    check (
      (last_published_source_fingerprint is null or last_published_source_fingerprint ~ '^[0-9a-f]{64}$')
      and (last_published_generation is null or last_published_generation > 0)
      and (last_published_fence_token is null or last_published_fence_token >= 0)
      and (last_published_data_version is null or last_published_data_version > 0)
      and (last_published_source_rows is null or last_published_source_rows >= 0)
      and (last_published_summary_rows is null or last_published_summary_rows >= 0)
      and (last_published_entity_rows is null or last_published_entity_rows >= 0)
      and (last_published_result is null or jsonb_typeof(last_published_result) = 'object')
    );

update public.business_upload_versions
set rebuild_status = case
      when dirty is false
       and summary_version = data_version
       and opportunity_entity_version = data_version then 'ready'
      else 'queued'
    end,
    rebuild_target_version = null,
    rebuild_id = null,
    rebuild_lease_expires_at = null,
    rebuild_heartbeat_at = null,
    rebuild_next_retry_at = null,
    rebuild_last_chunk_sequence = -1,
    rebuild_last_chunk_fingerprint = null,
    rebuild_rows_processed = 0,
    rebuild_summary_partial_count = 0,
    rebuild_entity_count = 0,
    rebuild_peak_chunk_rows = 0,
    rebuild_peak_payload_bytes = 0,
    rebuild_source_fingerprint = null,
    rebuild_evaluation_at = null;

create table public.business_summary_mpn_stage (
  rebuild_id uuid not null,
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  target_data_version bigint not null check (target_data_version > 0),
  rebuild_generation bigint not null check (rebuild_generation > 0),
  chunk_sequence integer not null check (chunk_sequence >= 0),
  source_ordinal integer not null check (source_ordinal between 0 and 499),
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
  source_record_count bigint not null default 0 check (source_record_count >= 0),
  warnings text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (rebuild_id, chunk_sequence, source_ordinal, normalized_mpn)
);

create index business_summary_mpn_stage_scope_idx
  on public.business_summary_mpn_stage
  (upload_batch_id, target_data_version, rebuild_generation, rebuild_id, normalized_mpn);

create table public.business_summary_entity_stage (
  rebuild_id uuid not null,
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  target_data_version bigint not null check (target_data_version > 0),
  rebuild_generation bigint not null check (rebuild_generation > 0),
  chunk_sequence integer not null check (chunk_sequence >= 0),
  source_record_id uuid not null references public.business_records(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('demand', 'stock', 'excess', 'supplier_offer', 'historical')),
  entity_key text not null,
  normalized_mpn text not null,
  display_mpn text not null,
  manufacturer_name text,
  customer_name text,
  supplier_name text,
  required_qty numeric,
  available_qty numeric,
  excess_qty numeric,
  required_date date,
  unit_of_measure text,
  lead_time_weeks numeric,
  moq numeric,
  spq numeric,
  date_code text,
  coo text,
  condition text,
  expires_at timestamptz,
  is_active_demand boolean not null default true,
  is_live_supply boolean not null default true,
  warnings text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (rebuild_id, source_record_id, entity_kind)
);

create index business_summary_entity_stage_scope_idx
  on public.business_summary_entity_stage
  (upload_batch_id, target_data_version, rebuild_generation, rebuild_id, normalized_mpn, source_record_id);

alter table public.business_summary_mpn_stage enable row level security;
alter table public.business_summary_mpn_stage force row level security;
alter table public.business_summary_entity_stage enable row level security;
alter table public.business_summary_entity_stage force row level security;

revoke all on public.business_summary_mpn_stage from public, anon, authenticated, service_role;
revoke all on public.business_summary_entity_stage from public, anon, authenticated, service_role;

-- A business data-version change supersedes any in-flight derived rebuild.
-- The per-upload fence is intentionally advanced here; unrelated uploads never
-- contend on this row.
create function public.queue_business_summary_rebuild_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.dirty then
      new.rebuild_status := 'queued';
    end if;
    return new;
  end if;

  if new.data_version is distinct from old.data_version
     or (new.dirty and not old.dirty) then
    new.rebuild_status := 'queued';
    new.rebuild_target_version := null;
    new.rebuild_id := null;
    new.rebuild_generation := old.rebuild_generation;
    new.rebuild_fence_token := old.rebuild_fence_token + 1;
    new.rebuild_locked_at := null;
    new.rebuild_locked_by := null;
    new.rebuild_lease_expires_at := null;
    new.rebuild_heartbeat_at := null;
    new.rebuild_next_retry_at := null;
    new.rebuild_attempts := 0;
    new.last_rebuild_error_code := null;
    new.rebuild_last_chunk_sequence := -1;
    new.rebuild_last_chunk_fingerprint := null;
    new.rebuild_last_cursor_created_at := null;
    new.rebuild_last_cursor_id := null;
    new.rebuild_rows_processed := 0;
    new.rebuild_summary_partial_count := 0;
    new.rebuild_entity_count := 0;
    new.rebuild_peak_chunk_rows := 0;
    new.rebuild_peak_payload_bytes := 0;
    new.rebuild_source_fingerprint := null;
    new.rebuild_started_at := null;
    new.rebuild_evaluation_at := null;
  end if;
  return new;
end;
$$;

create trigger business_upload_versions_queue_insert_v2
before insert on public.business_upload_versions
for each row execute function public.queue_business_summary_rebuild_v2();

create trigger business_upload_versions_queue_update_v2
before update of data_version, dirty on public.business_upload_versions
for each row execute function public.queue_business_summary_rebuild_v2();

revoke all on function public.queue_business_summary_rebuild_v2()
  from public, anon, authenticated, service_role;

-- ================================================================
-- SECTION B: SUMMARY RPCS V2
-- Owned by r7_summary_pipeline.
-- ================================================================

create or replace function public.claim_business_summary_rebuild_v2(
  input_worker_id text,
  input_lease_seconds integer default 120
)
returns table(
  upload_batch_id uuid,
  target_data_version bigint,
  rebuild_id uuid,
  rebuild_generation bigint,
  fence_token bigint,
  lease_expires_at timestamptz,
  evaluation_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  candidate public.business_upload_versions%rowtype;
  next_rebuild_id uuid := gen_random_uuid();
  now_value timestamptz := clock_timestamp();
  lease_seconds integer := least(greatest(coalesce(input_lease_seconds, 120), 30), 900);
  terminal_rebuild_ids uuid[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SUMMARY_SERVICE_ROLE_REQUIRED';
  end if;
  if input_worker_id is null or length(input_worker_id) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'SUMMARY_WORKER_ID_INVALID';
  end if;

  -- A worker can crash after consuming its final allowed attempt.  Convert
  -- that expired lease to a durable terminal state before searching for the
  -- next claim so consumers never observe an infinite `rebuilding` state.
  with expired as (
    select version.upload_batch_id, version.rebuild_id
    from public.business_upload_versions version
    where version.rebuild_status = 'rebuilding'
      and (version.rebuild_lease_expires_at is null
        or version.rebuild_lease_expires_at <= now_value)
      and version.rebuild_attempts >= version.rebuild_max_attempts
    order by version.updated_at, version.upload_batch_id
    for update skip locked
    limit 100
  ), terminalized as (
    update public.business_upload_versions version
    set rebuild_status = 'failed',
        rebuild_id = null,
        rebuild_fence_token = version.rebuild_fence_token + 1,
        rebuild_locked_at = null,
        rebuild_locked_by = null,
        rebuild_lease_expires_at = null,
        rebuild_heartbeat_at = now_value,
        rebuild_next_retry_at = null,
        last_rebuild_error_code = 'SUMMARY_LEASE_EXPIRED_MAX_ATTEMPTS',
        updated_at = now_value
    from expired
    where version.upload_batch_id = expired.upload_batch_id
    returning expired.rebuild_id
  )
  select array_agg(terminalized.rebuild_id)
  into terminal_rebuild_ids
  from terminalized;

  if terminal_rebuild_ids is not null then
    delete from public.business_summary_mpn_stage stage
    where stage.rebuild_id = any(terminal_rebuild_ids);
    delete from public.business_summary_entity_stage stage
    where stage.rebuild_id = any(terminal_rebuild_ids);
  end if;

  select version.* into candidate
  from public.business_upload_versions version
  join public.upload_batches upload on upload.id = version.upload_batch_id
  where upload.archived_at is null
    and upload.status in ('completed', 'completed_with_warnings')
    and (
      version.dirty
      or version.summary_version is distinct from version.data_version
      or version.opportunity_entity_version is distinct from version.data_version
    )
    and (
      version.rebuild_status = 'queued'
      or (
        version.rebuild_status = 'retrying'
        and coalesce(version.rebuild_next_retry_at, '-infinity'::timestamptz) <= now_value
      )
      or (
        version.rebuild_status = 'rebuilding'
        and coalesce(version.rebuild_lease_expires_at, '-infinity'::timestamptz) <= now_value
      )
    )
    and (
      version.rebuild_target_version is distinct from version.data_version
      or version.rebuild_attempts < version.rebuild_max_attempts
    )
  order by version.updated_at, version.upload_batch_id
  for update of version skip locked
  limit 1;

  if not found then
    return;
  end if;

  -- A reclaimed attempt never shares staging rows with its predecessor.
  delete from public.business_summary_mpn_stage stage
  where stage.upload_batch_id = candidate.upload_batch_id;
  delete from public.business_summary_entity_stage stage
  where stage.upload_batch_id = candidate.upload_batch_id;

  update public.business_upload_versions version
  set rebuild_status = 'rebuilding',
      rebuild_target_version = candidate.data_version,
      rebuild_id = next_rebuild_id,
      rebuild_generation = candidate.rebuild_generation + 1,
      rebuild_fence_token = candidate.rebuild_fence_token + 1,
      rebuild_locked_at = now_value,
      rebuild_locked_by = input_worker_id,
      rebuild_lease_expires_at = now_value + make_interval(secs => lease_seconds),
      rebuild_heartbeat_at = now_value,
      rebuild_next_retry_at = null,
      rebuild_attempts = case
        when candidate.rebuild_target_version is distinct from candidate.data_version then 1
        else candidate.rebuild_attempts + 1
      end,
      last_rebuild_error_code = null,
      rebuild_last_chunk_sequence = -1,
      rebuild_last_chunk_fingerprint = null,
      rebuild_last_cursor_created_at = null,
      rebuild_last_cursor_id = null,
      rebuild_rows_processed = 0,
      rebuild_summary_partial_count = 0,
      rebuild_entity_count = 0,
      rebuild_peak_chunk_rows = 0,
      rebuild_peak_payload_bytes = 0,
      rebuild_source_fingerprint = null,
      rebuild_started_at = now_value,
      rebuild_evaluation_at = now_value,
      updated_at = now_value
  where version.upload_batch_id = candidate.upload_batch_id
  returning
    version.upload_batch_id,
    version.rebuild_target_version,
    version.rebuild_id,
    version.rebuild_generation,
    version.rebuild_fence_token,
    version.rebuild_lease_expires_at,
    version.rebuild_evaluation_at
  into upload_batch_id, target_data_version, rebuild_id,
       rebuild_generation, fence_token, lease_expires_at, evaluation_at;
  return next;
end;
$$;

create or replace function public.heartbeat_business_summary_rebuild_v2(
  input_upload_batch_id uuid,
  input_worker_id text,
  input_rebuild_id uuid,
  input_generation bigint,
  input_fence_token bigint,
  input_lease_seconds integer default 120
)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  next_expiry timestamptz;
  now_value timestamptz := clock_timestamp();
  lease_seconds integer := least(greatest(coalesce(input_lease_seconds, 120), 30), 900);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SUMMARY_SERVICE_ROLE_REQUIRED';
  end if;
  update public.business_upload_versions version
  set rebuild_heartbeat_at = now_value,
      rebuild_lease_expires_at = now_value + make_interval(secs => lease_seconds),
      updated_at = now_value
  where version.upload_batch_id = input_upload_batch_id
    and version.rebuild_status = 'rebuilding'
    and version.rebuild_locked_by = input_worker_id
    and version.rebuild_id = input_rebuild_id
    and version.rebuild_generation = input_generation
    and version.rebuild_fence_token = input_fence_token
    and version.rebuild_target_version = version.data_version
    and version.rebuild_lease_expires_at > now_value
  returning version.rebuild_lease_expires_at into next_expiry;
  if next_expiry is null then
    raise exception using errcode = '55000', message = 'SUMMARY_WORKER_FENCED';
  end if;
  return next_expiry;
end;
$$;

create or replace function public.read_business_summary_source_chunk_v2(
  input_upload_batch_id uuid,
  input_worker_id text,
  input_rebuild_id uuid,
  input_generation bigint,
  input_fence_token bigint,
  input_after_created_at timestamptz default null,
  input_after_id uuid default null,
  input_limit integer default 500
)
returns table(record_id uuid, record_created_at timestamptz, record_payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  now_value timestamptz := clock_timestamp();
  page_limit integer := least(greatest(coalesce(input_limit, 500), 1), 1000);
  candidate record;
  candidate_payload jsonb;
  candidate_bytes bigint;
  page_bytes bigint := 0;
  returned_rows integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SUMMARY_SERVICE_ROLE_REQUIRED';
  end if;
  if (input_after_created_at is null) <> (input_after_id is null) then
    raise exception using errcode = '22023', message = 'SUMMARY_CURSOR_INVALID';
  end if;
  if not exists (
    select 1 from public.business_upload_versions version
    where version.upload_batch_id = input_upload_batch_id
      and version.rebuild_status = 'rebuilding'
      and version.rebuild_locked_by = input_worker_id
      and version.rebuild_id = input_rebuild_id
      and version.rebuild_generation = input_generation
      and version.rebuild_fence_token = input_fence_token
      and version.rebuild_target_version = version.data_version
      and version.rebuild_lease_expires_at > now_value
  ) then
    raise exception using errcode = '55000', message = 'SUMMARY_WORKER_FENCED';
  end if;

  -- Iterate the keyset cursor so the database stops before materializing an
  -- oversized PostgREST response.  One pathological source row fails loudly;
  -- normal rows adaptively fill a page up to the byte budget.
  for candidate in
    select record.*
    from public.business_records record
    where record.upload_batch_id = input_upload_batch_id
      and record.archived_at is null
      and (
        input_after_created_at is null
        or (record.created_at, record.id) < (input_after_created_at, input_after_id)
      )
    order by record.created_at desc, record.id desc
    limit page_limit
  loop
    candidate_payload := jsonb_build_object(
      'id', candidate.id,
      'upload_batch_id', candidate.upload_batch_id,
      'uploaded_by', candidate.uploaded_by,
      'category', candidate.category,
      'raw_data', candidate.raw_data,
      'normalized_data', candidate.normalized_data,
      'has_errors', candidate.has_errors,
      'errors', candidate.errors,
      'mpn', candidate.mpn,
      'mpn_quoted', candidate.mpn_quoted,
      'customer', candidate.customer,
      'client', candidate.client,
      'supplier', candidate.supplier,
      'supplier_name', candidate.supplier_name,
      'manufacturer', candidate.manufacturer,
      'clean_mfg', candidate.clean_mfg,
      'qty', candidate.qty,
      'req_qty', candidate.req_qty,
      'on_hand', candidate.on_hand,
      'earliest_shipping_date', candidate.earliest_shipping_date,
      'lead_time_weeks', candidate.lead_time_weeks,
      'created_at', candidate.created_at
    );
    candidate_bytes := pg_column_size(candidate_payload)::bigint;
    if candidate_bytes > 1048576 then
      raise exception using errcode = '22023', message = 'SUMMARY_SOURCE_ROW_TOO_LARGE';
    end if;
    if returned_rows > 0 and page_bytes + candidate_bytes > 4194304 then
      exit;
    end if;
    record_id := candidate.id;
    record_created_at := candidate.created_at;
    record_payload := candidate_payload;
    page_bytes := page_bytes + candidate_bytes;
    returned_rows := returned_rows + 1;
    return next;
  end loop;
end;
$$;

create or replace function public.stage_business_summary_chunk_v2(
  input_upload_batch_id uuid,
  input_worker_id text,
  input_rebuild_id uuid,
  input_generation bigint,
  input_fence_token bigint,
  input_chunk_sequence integer,
  input_source_rows integer,
  input_summary_rows jsonb,
  input_entity_rows jsonb,
  input_payload_bytes bigint,
  input_cursor_created_at timestamptz,
  input_cursor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_version public.business_upload_versions%rowtype;
  summary_count integer;
  entity_count integer;
  actual_payload_bytes bigint;
  chunk_fingerprint text;
  now_value timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SUMMARY_SERVICE_ROLE_REQUIRED';
  end if;
  if input_chunk_sequence < 0 or input_source_rows not between 1 and 500
     or input_cursor_created_at is null or input_cursor_id is null
     or jsonb_typeof(input_summary_rows) <> 'array'
     or jsonb_typeof(input_entity_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'SUMMARY_STAGE_PAYLOAD_INVALID';
  end if;
  summary_count := jsonb_array_length(input_summary_rows);
  entity_count := jsonb_array_length(input_entity_rows);
  actual_payload_bytes := pg_column_size(input_summary_rows)::bigint + pg_column_size(input_entity_rows)::bigint;
  chunk_fingerprint := encode(extensions.digest(
    convert_to(jsonb_build_object(
      'chunkSequence', input_chunk_sequence,
      'sourceRows', input_source_rows,
      'summaryRows', input_summary_rows,
      'entityRows', input_entity_rows,
      'cursorCreatedAt', input_cursor_created_at,
      'cursorId', input_cursor_id
    )::text, 'UTF8'),
    'sha256'
  ), 'hex');
  if summary_count > input_source_rows
     or entity_count > input_source_rows * 5
     or input_payload_bytes < 0
     or input_payload_bytes > 8388608
     or actual_payload_bytes > 8388608 then
    raise exception using errcode = '22023', message = 'SUMMARY_STAGE_LIMIT_EXCEEDED';
  end if;

  select version.* into locked_version
  from public.business_upload_versions version
  where version.upload_batch_id = input_upload_batch_id
  for update;
  if not found
     or locked_version.rebuild_status <> 'rebuilding'
     or locked_version.rebuild_locked_by is distinct from input_worker_id
     or locked_version.rebuild_id is distinct from input_rebuild_id
     or locked_version.rebuild_generation <> input_generation
     or locked_version.rebuild_fence_token <> input_fence_token
     or locked_version.rebuild_target_version is distinct from locked_version.data_version
     or locked_version.rebuild_lease_expires_at is null
     or locked_version.rebuild_lease_expires_at <= now_value then
    raise exception using errcode = '55000', message = 'SUMMARY_WORKER_FENCED';
  end if;
  if input_chunk_sequence <= locked_version.rebuild_last_chunk_sequence then
    if input_chunk_sequence <> locked_version.rebuild_last_chunk_sequence
       or locked_version.rebuild_last_chunk_fingerprint is distinct from chunk_fingerprint
       or locked_version.rebuild_last_cursor_created_at is distinct from input_cursor_created_at
       or locked_version.rebuild_last_cursor_id is distinct from input_cursor_id then
      raise exception using errcode = '22023', message = 'SUMMARY_STAGE_DUPLICATE_MISMATCH';
    end if;
    return jsonb_build_object(
      'accepted', false,
      'duplicate', true,
      'nextChunkSequence', locked_version.rebuild_last_chunk_sequence + 1,
      'rowsProcessed', locked_version.rebuild_rows_processed
    );
  end if;
  if input_chunk_sequence <> locked_version.rebuild_last_chunk_sequence + 1 then
    raise exception using errcode = '22023', message = 'SUMMARY_STAGE_SEQUENCE_INVALID';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(input_entity_rows) item
    where not exists (
      select 1
      from public.business_records source
      where source.id = (item->>'source_record_id')::uuid
        and source.upload_batch_id = input_upload_batch_id
        and source.archived_at is null
    )
  ) then
    raise exception using errcode = '22023', message = 'SUMMARY_ENTITY_SOURCE_OUTSIDE_UPLOAD';
  end if;

  insert into public.business_summary_mpn_stage (
    rebuild_id, upload_batch_id, owner_id, target_data_version, rebuild_generation,
    chunk_sequence, source_ordinal, normalized_mpn, display_mpn, customer_name, supplier_name,
    manufacturer_name, manufacturer_names, demand_qty, stock_qty, excess_qty,
    received_qty, stock_required_qty, stock_available_qty, stock_customer_name,
    stock_supplier_name, stock_manufacturer_name, required_date, lead_time,
    unit_of_measure, approved_part_signal, received_signal, source_record_count, warnings
  )
  select
    input_rebuild_id, input_upload_batch_id, locked_version.owner_id,
    locked_version.rebuild_target_version, input_generation, input_chunk_sequence,
    row.source_ordinal,
    row.normalized_mpn, coalesce(row.display_mpn, row.normalized_mpn),
    row.customer_name, row.supplier_name, row.manufacturer_name,
    coalesce(row.manufacturer_names, '{}'), row.demand_qty, row.stock_qty,
    row.excess_qty, row.received_qty, row.stock_required_qty,
    row.stock_available_qty, row.stock_customer_name, row.stock_supplier_name,
    row.stock_manufacturer_name, row.required_date, row.lead_time,
    row.unit_of_measure, coalesce(row.approved_part_signal, false),
    coalesce(row.received_signal, false), coalesce(row.source_record_count, 0),
    coalesce(row.warnings, '{}')
  from jsonb_to_recordset(input_summary_rows) as row(
    source_ordinal integer, normalized_mpn text, display_mpn text, customer_name text, supplier_name text,
    manufacturer_name text, manufacturer_names text[], demand_qty numeric,
    stock_qty numeric, excess_qty numeric, received_qty numeric,
    stock_required_qty numeric, stock_available_qty numeric,
    stock_customer_name text, stock_supplier_name text,
    stock_manufacturer_name text, required_date text, lead_time text,
    unit_of_measure text, approved_part_signal boolean, received_signal boolean,
    source_record_count bigint, warnings text[]
  );

  insert into public.business_summary_entity_stage (
    rebuild_id, upload_batch_id, owner_id, target_data_version, rebuild_generation,
    chunk_sequence, source_record_id, entity_kind, entity_key, normalized_mpn,
    display_mpn, manufacturer_name, customer_name, supplier_name, required_qty,
    available_qty, excess_qty, required_date, unit_of_measure, lead_time_weeks,
    moq, spq, date_code, coo, condition, expires_at, is_active_demand,
    is_live_supply, warnings
  )
  select
    input_rebuild_id, input_upload_batch_id, locked_version.owner_id,
    locked_version.rebuild_target_version, input_generation, input_chunk_sequence,
    row.source_record_id, row.entity_kind, row.entity_key, row.normalized_mpn,
    coalesce(row.display_mpn, row.normalized_mpn), row.manufacturer_name,
    row.customer_name, row.supplier_name, row.required_qty, row.available_qty,
    row.excess_qty, row.required_date, row.unit_of_measure, row.lead_time_weeks,
    row.moq, row.spq, row.date_code, row.coo, row.condition, row.expires_at,
    coalesce(row.is_active_demand, true), coalesce(row.is_live_supply, true),
    coalesce(row.warnings, '{}')
  from jsonb_to_recordset(input_entity_rows) as row(
    source_record_id uuid, entity_kind text, entity_key text, normalized_mpn text,
    display_mpn text, manufacturer_name text, customer_name text,
    supplier_name text, required_qty numeric, available_qty numeric,
    excess_qty numeric, required_date date, unit_of_measure text,
    lead_time_weeks numeric, moq numeric, spq numeric, date_code text, coo text,
    condition text, expires_at timestamptz, is_active_demand boolean,
    is_live_supply boolean, warnings text[]
  );

  update public.business_upload_versions version
  set rebuild_last_chunk_sequence = input_chunk_sequence,
      rebuild_last_chunk_fingerprint = chunk_fingerprint,
      rebuild_last_cursor_created_at = input_cursor_created_at,
      rebuild_last_cursor_id = input_cursor_id,
      rebuild_rows_processed = version.rebuild_rows_processed + input_source_rows,
      rebuild_summary_partial_count = version.rebuild_summary_partial_count + summary_count,
      rebuild_entity_count = version.rebuild_entity_count + entity_count,
      rebuild_peak_chunk_rows = greatest(version.rebuild_peak_chunk_rows, input_source_rows),
      rebuild_peak_payload_bytes = greatest(version.rebuild_peak_payload_bytes, input_payload_bytes, actual_payload_bytes),
      rebuild_heartbeat_at = now_value,
      updated_at = now_value
  where version.upload_batch_id = input_upload_batch_id;

  return jsonb_build_object(
    'accepted', true,
    'duplicate', false,
    'nextChunkSequence', input_chunk_sequence + 1,
    'rowsProcessed', locked_version.rebuild_rows_processed + input_source_rows,
    'summaryPartials', summary_count,
    'entities', entity_count
  );
end;
$$;

create or replace function public.publish_business_summary_rebuild_v2(
  input_upload_batch_id uuid,
  input_worker_id text,
  input_rebuild_id uuid,
  input_generation bigint,
  input_fence_token bigint,
  input_expected_source_rows bigint,
  input_source_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_version public.business_upload_versions%rowtype;
  actual_source_rows bigint;
  actual_summary_partials bigint;
  actual_entities bigint;
  published_summaries bigint := 0;
  published_entities bigint := 0;
  publish_result jsonb;
  now_value timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SUMMARY_SERVICE_ROLE_REQUIRED';
  end if;
  if input_expected_source_rows < 0
     or input_source_fingerprint is null
     or input_source_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'SUMMARY_PUBLISH_INPUT_INVALID';
  end if;

  select version.* into locked_version
  from public.business_upload_versions version
  where version.upload_batch_id = input_upload_batch_id
  for update;
  if found and locked_version.last_published_rebuild_id = input_rebuild_id then
    if locked_version.last_published_generation = input_generation
       and locked_version.last_published_fence_token = input_fence_token
       and locked_version.last_published_data_version = locked_version.data_version
       and locked_version.last_published_source_fingerprint = input_source_fingerprint
       and locked_version.last_published_source_rows = input_expected_source_rows
       and locked_version.dirty is false
       and locked_version.summary_version = locked_version.data_version
       and locked_version.opportunity_entity_version = locked_version.data_version
       and locked_version.last_published_result is not null then
      return locked_version.last_published_result;
    end if;
    raise exception using errcode = '22023', message = 'SUMMARY_PUBLISH_REPLAY_MISMATCH';
  end if;
  if not found
     or locked_version.rebuild_status <> 'rebuilding'
     or locked_version.rebuild_locked_by is distinct from input_worker_id
     or locked_version.rebuild_id is distinct from input_rebuild_id
     or locked_version.rebuild_generation <> input_generation
     or locked_version.rebuild_fence_token <> input_fence_token
     or locked_version.rebuild_target_version is distinct from locked_version.data_version
     or locked_version.rebuild_lease_expires_at is null
     or locked_version.rebuild_lease_expires_at <= now_value then
    raise exception using errcode = '55000', message = 'SUMMARY_WORKER_FENCED';
  end if;

  select count(*)::bigint into actual_source_rows
  from public.business_records record
  where record.upload_batch_id = input_upload_batch_id
    and record.archived_at is null;
  select count(*)::bigint into actual_summary_partials
  from public.business_summary_mpn_stage stage
  where stage.rebuild_id = input_rebuild_id
    and stage.upload_batch_id = input_upload_batch_id
    and stage.target_data_version = locked_version.rebuild_target_version
    and stage.rebuild_generation = input_generation;
  select count(*)::bigint into actual_entities
  from public.business_summary_entity_stage stage
  where stage.rebuild_id = input_rebuild_id
    and stage.upload_batch_id = input_upload_batch_id
    and stage.target_data_version = locked_version.rebuild_target_version
    and stage.rebuild_generation = input_generation;

  if input_expected_source_rows <> locked_version.rebuild_rows_processed
     or actual_source_rows <> input_expected_source_rows
     or actual_summary_partials <> locked_version.rebuild_summary_partial_count
     or actual_entities <> locked_version.rebuild_entity_count then
    raise exception using errcode = '40001', message = 'SUMMARY_PUBLISH_COUNTS_STALE';
  end if;

  -- Replace only the target upload/version.  Old immutable versions stay in
  -- place because active single-file snapshot manifests can still reference
  -- them until their jobs expire.
  delete from public.business_mpn_summaries summary
  where summary.upload_batch_id = input_upload_batch_id
    and summary.data_version = locked_version.rebuild_target_version;

  with summary_base as (
    select
      stage.normalized_mpn,
      (array_agg(stage.display_mpn order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.display_mpn is not null))[1] as display_mpn,
      (array_agg(stage.customer_name order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.customer_name is not null))[1] as customer_name,
      (array_agg(stage.supplier_name order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.supplier_name is not null))[1] as supplier_name,
      (array_agg(stage.manufacturer_name order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.manufacturer_name is not null))[1] as manufacturer_name,
      case when count(stage.demand_qty) > 0 then
        sum(stage.demand_qty order by stage.chunk_sequence, stage.source_ordinal)
      end as demand_qty,
      case when count(stage.stock_qty) > 0 then
        sum(stage.stock_qty order by stage.chunk_sequence, stage.source_ordinal)
      end as stock_qty,
      case when count(stage.excess_qty) > 0 then
        sum(stage.excess_qty order by stage.chunk_sequence, stage.source_ordinal)
      end as excess_qty,
      case when count(stage.received_qty) > 0 then
        sum(stage.received_qty order by stage.chunk_sequence, stage.source_ordinal)
      end as received_qty,
      case when count(stage.stock_required_qty) > 0 then
        sum(stage.stock_required_qty order by stage.chunk_sequence, stage.source_ordinal)
      end as stock_required_qty,
      case when count(stage.stock_available_qty) > 0 then
        sum(stage.stock_available_qty order by stage.chunk_sequence, stage.source_ordinal)
      end as stock_available_qty,
      (array_agg(stage.stock_customer_name order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.stock_customer_name is not null))[1] as stock_customer_name,
      (array_agg(stage.stock_supplier_name order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.stock_supplier_name is not null))[1] as stock_supplier_name,
      (array_agg(stage.stock_manufacturer_name order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.stock_manufacturer_name is not null))[1] as stock_manufacturer_name,
      (array_agg(stage.required_date order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.required_date is not null))[1] as required_date,
      (array_agg(stage.lead_time order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.lead_time is not null))[1] as lead_time,
      (array_agg(stage.unit_of_measure order by stage.chunk_sequence, stage.source_ordinal)
        filter (where stage.unit_of_measure is not null))[1] as unit_of_measure,
      bool_or(stage.approved_part_signal) as approved_part_signal,
      bool_or(stage.received_signal) as received_signal,
      sum(stage.source_record_count)::bigint as source_record_count
    from public.business_summary_mpn_stage stage
    where stage.rebuild_id = input_rebuild_id
      and stage.upload_batch_id = input_upload_batch_id
      and stage.target_data_version = locked_version.rebuild_target_version
      and stage.rebuild_generation = input_generation
    group by stage.normalized_mpn
  ), manufacturer_values as (
    select value.normalized_mpn,
      array_agg(value.manufacturer_name order by value.first_position, value.manufacturer_name) as manufacturer_names
    from (
      select stage.normalized_mpn, manufacturer.manufacturer_name,
        min(stage.chunk_sequence::bigint * 1000000000 + stage.source_ordinal::bigint * 1000000 + manufacturer.ordinality)::bigint as first_position
      from public.business_summary_mpn_stage stage
      cross join lateral unnest(stage.manufacturer_names)
        with ordinality as manufacturer(manufacturer_name, ordinality)
      where stage.rebuild_id = input_rebuild_id
        and stage.upload_batch_id = input_upload_batch_id
        and stage.target_data_version = locked_version.rebuild_target_version
        and stage.rebuild_generation = input_generation
        and manufacturer.manufacturer_name <> ''
      group by stage.normalized_mpn, manufacturer.manufacturer_name
    ) value
    group by value.normalized_mpn
  ), warning_values as (
    select value.normalized_mpn,
      array_agg(value.warning order by value.first_position, value.warning) as warnings
    from (
      select stage.normalized_mpn, warning.warning,
        min(stage.chunk_sequence::bigint * 1000000000 + stage.source_ordinal::bigint * 1000000 + warning.ordinality)::bigint as first_position
      from public.business_summary_mpn_stage stage
      cross join lateral unnest(stage.warnings)
        with ordinality as warning(warning, ordinality)
      where stage.rebuild_id = input_rebuild_id
        and stage.upload_batch_id = input_upload_batch_id
        and stage.target_data_version = locked_version.rebuild_target_version
        and stage.rebuild_generation = input_generation
        and warning.warning <> ''
        and warning.warning <> 'manufacturer_context_mixed'
      group by stage.normalized_mpn, warning.warning
    ) value
    group by value.normalized_mpn
  )
  insert into public.business_mpn_summaries (
    upload_batch_id, owner_id, data_version, normalized_mpn, display_mpn,
    customer_name, supplier_name, manufacturer_name, manufacturer_names,
    demand_qty, stock_qty, excess_qty, received_qty, stock_required_qty,
    stock_available_qty, stock_customer_name, stock_supplier_name,
    stock_manufacturer_name, required_date, lead_time, unit_of_measure,
    approved_part_signal, received_signal, source_record_count, warnings
  )
  select
    input_upload_batch_id, locked_version.owner_id,
    locked_version.rebuild_target_version, base.normalized_mpn,
    coalesce(base.display_mpn, base.normalized_mpn), base.customer_name,
    base.supplier_name, base.manufacturer_name,
    coalesce(manufacturer.manufacturer_names, '{}'), base.demand_qty,
    base.stock_qty, base.excess_qty, base.received_qty,
    base.stock_required_qty, base.stock_available_qty,
    base.stock_customer_name, base.stock_supplier_name,
    base.stock_manufacturer_name, base.required_date, base.lead_time,
    base.unit_of_measure, base.approved_part_signal, base.received_signal,
    base.source_record_count,
    case
      when cardinality(coalesce(manufacturer.manufacturer_names, '{}')) > 1
       and not ('manufacturer_context_mixed' = any(coalesce(warning.warnings, '{}')))
        then coalesce(warning.warnings, '{}') || array['manufacturer_context_mixed']
      else coalesce(warning.warnings, '{}')
    end
  from summary_base base
  left join manufacturer_values manufacturer using (normalized_mpn)
  left join warning_values warning using (normalized_mpn)
  order by base.normalized_mpn;
  get diagnostics published_summaries = row_count;

  delete from public.business_opportunity_entities entity
  where entity.upload_batch_id = input_upload_batch_id
    and entity.data_version = locked_version.rebuild_target_version;

  insert into public.business_opportunity_entities (
    upload_batch_id, owner_id, data_version, source_record_id, entity_kind,
    entity_key, normalized_mpn, display_mpn, manufacturer_name, customer_name,
    supplier_name, required_qty, available_qty, excess_qty, required_date,
    unit_of_measure, lead_time_weeks, moq, spq, date_code, coo, condition,
    expires_at, is_active_demand, is_live_supply, warnings
  )
  select
    input_upload_batch_id, locked_version.owner_id,
    locked_version.rebuild_target_version, stage.source_record_id,
    stage.entity_kind, stage.entity_key, stage.normalized_mpn,
    stage.display_mpn, stage.manufacturer_name, stage.customer_name,
    stage.supplier_name, stage.required_qty, stage.available_qty,
    stage.excess_qty, stage.required_date, stage.unit_of_measure,
    stage.lead_time_weeks, stage.moq, stage.spq, stage.date_code, stage.coo,
    stage.condition, stage.expires_at, stage.is_active_demand,
    stage.is_live_supply, stage.warnings
  from public.business_summary_entity_stage stage
  where stage.rebuild_id = input_rebuild_id
    and stage.upload_batch_id = input_upload_batch_id
    and stage.target_data_version = locked_version.rebuild_target_version
    and stage.rebuild_generation = input_generation
  order by stage.chunk_sequence, stage.source_record_id, stage.entity_kind;
  get diagnostics published_entities = row_count;

  -- Local/runtime tests can force a failure here and prove that both live
  -- replacements and the visibility pointers roll back together.
  if current_setting('quiksol.summary_fail_after_replace', true) = input_rebuild_id::text then
    raise exception using errcode = 'P0001', message = 'SUMMARY_PUBLISH_INJECTED_FAILURE';
  end if;

  publish_result := jsonb_build_object(
    'status', 'ready',
    'version', locked_version.rebuild_target_version,
    'sourceRows', actual_source_rows,
    'summaryRows', published_summaries,
    'opportunityEntities', published_entities,
    'sourceFingerprint', input_source_fingerprint
  );

  update public.business_upload_versions version
  set summary_version = locked_version.rebuild_target_version,
      opportunity_entity_version = locked_version.rebuild_target_version,
      dirty = false,
      rebuild_status = 'ready',
      rebuild_target_version = null,
      rebuild_id = null,
      rebuild_fence_token = version.rebuild_fence_token + 1,
      rebuild_locked_at = null,
      rebuild_locked_by = null,
      rebuild_lease_expires_at = null,
      rebuild_heartbeat_at = now_value,
      rebuild_next_retry_at = null,
      last_rebuild_error_code = null,
      rebuild_source_fingerprint = input_source_fingerprint,
      last_published_rebuild_id = input_rebuild_id,
      last_published_generation = input_generation,
      last_published_fence_token = input_fence_token,
      last_published_data_version = locked_version.rebuild_target_version,
      last_published_source_fingerprint = input_source_fingerprint,
      last_published_source_rows = actual_source_rows,
      last_published_summary_rows = published_summaries,
      last_published_entity_rows = published_entities,
      last_published_result = publish_result,
      last_published_at = now_value,
      updated_at = now_value
  where version.upload_batch_id = input_upload_batch_id;

  delete from public.business_summary_mpn_stage stage
  where stage.rebuild_id = input_rebuild_id;
  delete from public.business_summary_entity_stage stage
  where stage.rebuild_id = input_rebuild_id;

  return publish_result;
end;
$$;

create or replace function public.fail_business_summary_rebuild_v2(
  input_upload_batch_id uuid,
  input_worker_id text,
  input_rebuild_id uuid,
  input_generation bigint,
  input_fence_token bigint,
  input_error_code text,
  input_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_version public.business_upload_versions%rowtype;
  sanitized_error text;
  next_status text;
  next_retry timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SUMMARY_SERVICE_ROLE_REQUIRED';
  end if;
  sanitized_error := left(regexp_replace(
    coalesce(nullif(input_error_code, ''), 'SUMMARY_REBUILD_FAILED'),
    '[^A-Za-z0-9_.-]', '', 'g'
  ), 80);

  select version.* into locked_version
  from public.business_upload_versions version
  where version.upload_batch_id = input_upload_batch_id
  for update;
  if not found
     or locked_version.rebuild_status <> 'rebuilding'
     or locked_version.rebuild_locked_by is distinct from input_worker_id
     or locked_version.rebuild_id is distinct from input_rebuild_id
     or locked_version.rebuild_generation <> input_generation
     or locked_version.rebuild_fence_token <> input_fence_token then
    raise exception using errcode = '55000', message = 'SUMMARY_WORKER_FENCED';
  end if;

  if coalesce(input_retryable, false)
     and locked_version.rebuild_attempts < locked_version.rebuild_max_attempts then
    next_status := 'retrying';
    next_retry := clock_timestamp() + make_interval(
      secs => least(900::double precision,
        (5 * power(2::numeric, greatest(locked_version.rebuild_attempts - 1, 0)))::double precision)
    );
  else
    next_status := 'failed';
    next_retry := null;
  end if;

  delete from public.business_summary_mpn_stage stage
  where stage.rebuild_id = input_rebuild_id;
  delete from public.business_summary_entity_stage stage
  where stage.rebuild_id = input_rebuild_id;

  update public.business_upload_versions version
  set rebuild_status = next_status,
      rebuild_target_version = locked_version.data_version,
      rebuild_id = null,
      rebuild_fence_token = version.rebuild_fence_token + 1,
      rebuild_locked_at = null,
      rebuild_locked_by = null,
      rebuild_lease_expires_at = null,
      rebuild_heartbeat_at = clock_timestamp(),
      rebuild_next_retry_at = next_retry,
      last_rebuild_error_code = sanitized_error,
      updated_at = clock_timestamp()
  where version.upload_batch_id = input_upload_batch_id;

  return jsonb_build_object(
    'status', next_status,
    'retryAfter', next_retry,
    'attempts', locked_version.rebuild_attempts,
    'maxAttempts', locked_version.rebuild_max_attempts,
    'errorCode', sanitized_error
  );
end;
$$;

create or replace function public.get_business_summary_state_v2(
  p_upload_batch_id uuid default null,
  p_client_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with visible_uploads as (
    select upload.id, upload.uploaded_by
    from public.upload_batches upload
    where upload.archived_at is null
      and upload.status in ('completed', 'completed_with_warnings')
      and public.can_read_upload(upload.uploaded_by)
      and (p_upload_batch_id is null or upload.id = p_upload_batch_id)
      and (p_client_id is null or exists (
        select 1 from public.client_upload_assignments assignment
        where assignment.upload_batch_id = upload.id
          and assignment.client_id = p_client_id
      ))
  ), visible as (
    select
      upload.id as scope_upload_batch_id,
      version.upload_batch_id as version_upload_batch_id,
      version.dirty,
      version.summary_version,
      version.opportunity_entity_version,
      version.data_version,
      version.rebuild_status,
      version.rebuild_next_retry_at
    from visible_uploads upload
    left join public.business_upload_versions version
      on version.upload_batch_id = upload.id
  ), aggregate_state as (
    select
      count(*)::bigint as total_scopes,
      count(*) filter (
        where version_upload_batch_id is null
           or dirty
           or summary_version is distinct from data_version
           or opportunity_entity_version is distinct from data_version
      )::bigint as pending_count,
      count(*) filter (where version_upload_batch_id is null)::bigint as missing_version_count,
      min(summary_version)::bigint as current_version_min,
      max(summary_version)::bigint as current_version_max,
      count(summary_version)::bigint as current_version_count,
      min(data_version)::bigint as required_version_min,
      max(data_version)::bigint as required_version_max,
      count(data_version)::bigint as required_version_count,
      min(rebuild_next_retry_at) filter (where rebuild_status = 'retrying') as retry_after,
      bool_or(rebuild_status = 'failed') as has_failed,
      bool_or(rebuild_status = 'rebuilding') as has_rebuilding,
      bool_or(rebuild_status = 'retrying') as has_retrying,
      bool_or(rebuild_status = 'queued') as has_queued
    from visible
  )
  select jsonb_build_object(
    'summaryReady', pending_count = 0,
    'status', case
      when coalesce(has_failed, false) then 'failed'
      when coalesce(has_rebuilding, false) then 'rebuilding'
      when coalesce(has_retrying, false) then 'retrying'
      when coalesce(has_queued, false) or pending_count > 0 then 'queued'
      else 'ready'
    end,
    'currentVersion', case
      when current_version_count = total_scopes
       and current_version_min = current_version_max then current_version_min
      else null
    end,
    'requiredVersion', case
      when required_version_count = total_scopes
       and required_version_min = required_version_max then required_version_min
      else null
    end,
    'currentVersionMin', current_version_min,
    'currentVersionMax', current_version_max,
    'requiredVersionMin', required_version_min,
    'requiredVersionMax', required_version_max,
    'retryAfter', retry_after,
    'pendingCount', pending_count,
    'missingVersionCount', missing_version_count,
    'totalScopes', total_scopes
  )
  from aggregate_state;
$$;

create or replace function public.request_business_summary_rebuild_v2(
  input_upload_batch_id uuid default null,
  input_client_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  requested_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
    raise exception using errcode = '42501', message = 'SUMMARY_AUTHENTICATED_ACTOR_REQUIRED';
  end if;

  with candidates as (
    select version.upload_batch_id
    from public.business_upload_versions version
    join public.upload_batches upload on upload.id = version.upload_batch_id
    where version.rebuild_status = 'failed'
      and upload.archived_at is null
      and public.can_read_upload(version.owner_id)
      and (input_upload_batch_id is null or version.upload_batch_id = input_upload_batch_id)
      and (input_client_id is null or exists (
        select 1 from public.client_upload_assignments assignment
        where assignment.upload_batch_id = version.upload_batch_id
          and assignment.client_id = input_client_id
      ))
    order by version.updated_at, version.upload_batch_id
    for update of version skip locked
    limit 100
  )
  update public.business_upload_versions version
  set rebuild_status = 'queued',
      rebuild_target_version = null,
      rebuild_id = null,
      rebuild_fence_token = version.rebuild_fence_token + 1,
      rebuild_locked_at = null,
      rebuild_locked_by = null,
      rebuild_lease_expires_at = null,
      rebuild_heartbeat_at = null,
      rebuild_next_retry_at = null,
      rebuild_attempts = 0,
      last_rebuild_error_code = null,
      rebuild_last_chunk_sequence = -1,
      rebuild_last_chunk_fingerprint = null,
      rebuild_last_cursor_created_at = null,
      rebuild_last_cursor_id = null,
      rebuild_rows_processed = 0,
      rebuild_summary_partial_count = 0,
      rebuild_entity_count = 0,
      rebuild_peak_chunk_rows = 0,
      rebuild_peak_payload_bytes = 0,
      rebuild_source_fingerprint = null,
      rebuild_started_at = null,
      rebuild_evaluation_at = null,
      updated_at = clock_timestamp()
  from candidates
  where version.upload_batch_id = candidates.upload_batch_id;
  get diagnostics requested_count = row_count;

  return jsonb_build_object(
    'requestedCount', requested_count,
    'status', case when requested_count > 0 then 'queued' else 'noop' end
  );
end;
$$;

revoke all on function public.claim_business_summary_rebuild_v2(text,integer)
  from public, anon, authenticated;
revoke all on function public.heartbeat_business_summary_rebuild_v2(uuid,text,uuid,bigint,bigint,integer)
  from public, anon, authenticated;
revoke all on function public.read_business_summary_source_chunk_v2(uuid,text,uuid,bigint,bigint,timestamptz,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.stage_business_summary_chunk_v2(uuid,text,uuid,bigint,bigint,integer,integer,jsonb,jsonb,bigint,timestamptz,uuid)
  from public, anon, authenticated;
revoke all on function public.publish_business_summary_rebuild_v2(uuid,text,uuid,bigint,bigint,bigint,text)
  from public, anon, authenticated;
revoke all on function public.fail_business_summary_rebuild_v2(uuid,text,uuid,bigint,bigint,text,boolean)
  from public, anon, authenticated;
grant execute on function public.claim_business_summary_rebuild_v2(text,integer) to service_role;
grant execute on function public.heartbeat_business_summary_rebuild_v2(uuid,text,uuid,bigint,bigint,integer) to service_role;
grant execute on function public.read_business_summary_source_chunk_v2(uuid,text,uuid,bigint,bigint,timestamptz,uuid,integer) to service_role;
grant execute on function public.stage_business_summary_chunk_v2(uuid,text,uuid,bigint,bigint,integer,integer,jsonb,jsonb,bigint,timestamptz,uuid) to service_role;
grant execute on function public.publish_business_summary_rebuild_v2(uuid,text,uuid,bigint,bigint,bigint,text) to service_role;
grant execute on function public.fail_business_summary_rebuild_v2(uuid,text,uuid,bigint,bigint,text,boolean) to service_role;

revoke all on function public.get_business_summary_state_v2(uuid,uuid) from public, anon;
grant execute on function public.get_business_summary_state_v2(uuid,uuid) to authenticated, service_role;
revoke all on function public.request_business_summary_rebuild_v2(uuid,uuid)
  from public, anon, service_role;
grant execute on function public.request_business_summary_rebuild_v2(uuid,uuid)
  to authenticated;

-- Keep the four established data RPCs as the post-read TOCTOU fence, but make
-- their universe identical to state/claim. Pending/failed/cancelled uploads
-- cannot create an unrebuildable false-stale response; a missing version for a
-- completed upload remains fail-closed.
do $$
declare
  signature regprocedure;
  definition text;
  rewritten text;
begin
  foreach signature in array array[
    'public.get_opportunity_summary_v1()'::regprocedure,
    'public.get_stock_needs_page_v1(integer,integer,text,text,text,text,text,text,uuid)'::regprocedure,
    'public.get_sales_opportunities_page_v1(integer,integer,text,text,text,text,text,text,uuid,uuid)'::regprocedure,
    'public.get_client_business_metrics_v1(uuid[])'::regprocedure
  ]
  loop
    select pg_get_functiondef(signature) into definition;
    rewritten := regexp_replace(
      definition,
      '([[:alnum:]_]+)\.status[[:space:]]*<>[[:space:]]*''archived''',
      '\1.status in (''completed'', ''completed_with_warnings'')',
      'gi'
    );
    if signature::text like '%get_stock_needs_page_v1%'
       or signature::text like '%get_sales_opportunities_page_v1%' then
      rewritten := regexp_replace(
        rewritten,
        'from[[:space:]]+public\.business_upload_versions[[:space:]]+v[[:space:]]+join[[:space:]]+public\.upload_batches[[:space:]]+u[[:space:]]+on[[:space:]]+u\.id[[:space:]]*=[[:space:]]*v\.upload_batch_id',
        'from public.upload_batches u left join public.business_upload_versions v on v.upload_batch_id = u.id',
        'gi'
      );
      rewritten := regexp_replace(
        rewritten,
        '\(v\.dirty[[:space:]]+or[[:space:]]+v\.summary_version[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+v\.data_version\)',
        '(v.upload_batch_id is null or v.dirty or v.summary_version is distinct from v.data_version)',
        'gi'
      );
    end if;
    if signature::text like '%get_stock_needs_page_v1%' then
      rewritten := regexp_replace(
        rewritten,
        'from[[:space:]]+public\.upload_batches[[:space:]]+upload[[:space:]]+join[[:space:]]+public\.business_upload_versions[[:space:]]+version[[:space:]]+on[[:space:]]+version\.upload_batch_id[[:space:]]*=[[:space:]]*upload\.id',
        'from public.upload_batches upload left join public.business_upload_versions version on version.upload_batch_id = upload.id',
        'gi'
      );
      rewritten := regexp_replace(
        rewritten,
        'where[[:space:]]+visible\.dirty[[:space:]]+or[[:space:]]+visible\.summary_version[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+visible\.data_version',
        'where visible.data_version is null or visible.dirty is distinct from false or visible.summary_version is distinct from visible.data_version',
        'gi'
      );
      if rewritten !~* 'left[[:space:]]+join[[:space:]]+public\.business_upload_versions[[:space:]]+version'
         or rewritten !~* 'visible\.data_version[[:space:]]+is[[:space:]]+null' then
        raise exception using errcode = '55000', message = 'SUMMARY_STOCK_NEEDS_UNIVERSE_REWRITE_FAILED';
      end if;
    end if;
    if rewritten = definition
       or rewritten ~* '[[:alnum:]_]+\.status[[:space:]]*<>[[:space:]]*''archived''' then
      raise exception using errcode = '55000', message = 'SUMMARY_TERMINAL_UNIVERSE_REWRITE_FAILED';
    end if;
    execute rewritten;
  end loop;
end;
$$;

-- R7 has one summary authority.  Legacy claim/release/direct replacement RPCs
-- remain defined for rollback visibility but cannot be used by the worker.
revoke execute on function public.claim_business_summary_rebuilds_v1(text,integer) from service_role;
revoke execute on function public.release_business_summary_rebuild_v1(uuid,text,text) from service_role;
revoke execute on function public.replace_business_upload_summary_v1(uuid,bigint,jsonb) from service_role;
revoke execute on function public.replace_business_upload_opportunity_entities_v1(uuid,bigint,jsonb) from service_role;

-- ================================================================
-- SECTION C: CHUNKED OPPORTUNITY FINDER SNAPSHOT RPCS V2
-- Owned by r7_summary_pipeline.
-- ================================================================

alter table public.opportunity_finder_dataset_snapshots
  add column build_status text not null default 'ready',
  add column build_generation bigint not null default 0,
  add column build_fence_token bigint not null default 0,
  add column build_last_chunk_sequence integer not null default -1,
  add column build_last_chunk_fingerprint text,
  add column build_rows_fingerprint text,
  add column build_cursor jsonb not null default '{}'::jsonb,
  add column build_idempotency_key text,
  add column universe_version bigint,
  add column authorization_hash text,
  add column build_lookup_metrics jsonb not null default '{}'::jsonb,
  add column finalized_at timestamptz;

alter table public.opportunity_finder_dataset_snapshots
  add constraint opportunity_finder_dataset_snapshots_build_status_check
    check (build_status in ('building', 'ready', 'failed')),
  add constraint opportunity_finder_dataset_snapshots_build_generation_check
    check (build_generation >= 0 and build_fence_token >= 0),
  add constraint opportunity_finder_dataset_snapshots_build_sequence_check
    check (build_last_chunk_sequence >= -1),
  add constraint opportunity_finder_dataset_snapshots_build_fingerprints_check
    check (
      (build_last_chunk_fingerprint is null or build_last_chunk_fingerprint ~ '^[0-9a-f]{64}$')
      and (build_rows_fingerprint is null or build_rows_fingerprint ~ '^[0-9a-f]{64}$')
    ),
  add constraint opportunity_finder_dataset_snapshots_build_cursor_check
    check (jsonb_typeof(build_cursor) = 'object' and pg_column_size(build_cursor) <= 8192),
  add constraint opportunity_finder_dataset_snapshots_locator_check
    check (
      (build_idempotency_key is null or length(build_idempotency_key) between 1 and 512)
      and (universe_version is null or universe_version > 0)
      and (authorization_hash is null or authorization_hash ~ '^[0-9a-f]{64}$')
    ),
  add constraint opportunity_finder_dataset_snapshots_build_metrics_check
    check (jsonb_typeof(build_lookup_metrics) = 'object');

-- Chunk persistence uses the existing snapshot tables as private staging.
-- Authenticated readers see neither the header nor its rows until finalize
-- advances both the header state and the owning job pointer atomically.
drop policy if exists opportunity_finder_dataset_snapshots_owner_select
  on public.opportunity_finder_dataset_snapshots;
create policy opportunity_finder_dataset_snapshots_owner_select
  on public.opportunity_finder_dataset_snapshots
  for select to authenticated
  using (
    build_status = 'ready'
    and tenant_id = auth.uid()
    and created_by = auth.uid()
    and exists (
      select 1
      from public.opportunity_finder_jobs job
      where job.id = public.opportunity_finder_dataset_snapshots.job_id
        and job.tenant_id = auth.uid()
        and job.created_by = auth.uid()
        and job.snapshot_status = 'ready'
        and job.dataset_snapshot_id = public.opportunity_finder_dataset_snapshots.id
    )
  );

drop policy if exists opportunity_finder_dataset_snapshot_rows_owner_select
  on public.opportunity_finder_dataset_snapshot_rows;
create policy opportunity_finder_dataset_snapshot_rows_owner_select
  on public.opportunity_finder_dataset_snapshot_rows
  for select to authenticated
  using (
    exists (
      select 1
      from public.opportunity_finder_dataset_snapshots snapshot
      join public.opportunity_finder_jobs job
        on job.id = snapshot.job_id
       and job.dataset_snapshot_id = snapshot.id
      where snapshot.id = public.opportunity_finder_dataset_snapshot_rows.snapshot_id
        and snapshot.job_id = public.opportunity_finder_dataset_snapshot_rows.job_id
        and snapshot.build_status = 'ready'
        and job.snapshot_status = 'ready'
        and job.tenant_id = auth.uid()
        and job.created_by = auth.uid()
    )
  );

-- A compact, monotonic universe locator replaces the O(upload-count) JSON
-- manifest.  Only changes that can alter the authorized, ready dataset advance
-- this sequence; snapshot staging and summary heartbeats deliberately do not.
create sequence public.opportunity_finder_dataset_universe_seq
  as bigint increment by 1 minvalue 1 no maxvalue start with 1 cache 1 no cycle;
revoke all on sequence public.opportunity_finder_dataset_universe_seq
  from public, anon, authenticated, service_role;

create or replace function public.touch_opportunity_finder_dataset_universe_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  old_row jsonb;
  new_row jsonb;
  changed boolean := false;
begin
  if tg_op = 'INSERT' or tg_op = 'DELETE' then
    changed := true;
  else
    old_row := to_jsonb(old);
    new_row := to_jsonb(new);
    if tg_table_name = 'business_upload_versions' then
      changed := (old_row->'owner_id', old_row->'data_version', old_row->'summary_version',
        old_row->'opportunity_entity_version', old_row->'dirty')
        is distinct from
        (new_row->'owner_id', new_row->'data_version', new_row->'summary_version',
        new_row->'opportunity_entity_version', new_row->'dirty');
    elsif tg_table_name = 'upload_batches' then
      changed := (old_row->'uploaded_by', old_row->'status', old_row->'archived_at')
        is distinct from
        (new_row->'uploaded_by', new_row->'status', new_row->'archived_at');
    elsif tg_table_name = 'profiles' then
      changed := (old_row->'role', old_row->'is_active', old_row->'department', old_row->'region')
        is distinct from
        (new_row->'role', new_row->'is_active', new_row->'department', new_row->'region');
    end if;
  end if;
  if changed then
    perform nextval('public.opportunity_finder_dataset_universe_seq'::regclass);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger business_upload_versions_dataset_universe_v2
after insert or update or delete on public.business_upload_versions
for each row execute function public.touch_opportunity_finder_dataset_universe_v2();
create trigger upload_batches_dataset_universe_v2
after insert or update or delete on public.upload_batches
for each row execute function public.touch_opportunity_finder_dataset_universe_v2();
create trigger profiles_dataset_universe_v2
after insert or update or delete on public.profiles
for each row execute function public.touch_opportunity_finder_dataset_universe_v2();

revoke all on function public.touch_opportunity_finder_dataset_universe_v2()
  from public, anon, authenticated, service_role;

create or replace function public.opportunity_finder_actor_can_read_upload_v2(
  input_actor_id uuid,
  input_owner_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select actor.is_active and (
      actor.role in ('admin', 'super_admin_dev')
      or actor.id = input_owner_id
      or (
        actor.role = 'manager'
        and (
          target.department = actor.department
          or target.region = actor.region
        )
      )
    )
    from public.profiles actor
    join public.profiles target on target.id = input_owner_id
    where actor.id = input_actor_id
  ), false);
$$;
revoke all on function public.opportunity_finder_actor_can_read_upload_v2(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.opportunity_finder_dataset_locator_for_actor_v2(
  input_actor_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor public.profiles%rowtype;
  dataset_scope text;
  universe_version bigint;
  authorization_hash text;
  dataset_version text;
  upload_count bigint;
  ready_upload_count bigint;
begin
  select profile.* into actor
  from public.profiles profile
  where profile.id = input_actor_id and profile.is_active;
  if not found then
    raise exception using errcode = '42501', message = 'OPPORTUNITY_DATASET_ACTOR_INVALID';
  end if;
  dataset_scope := case
    when actor.role in ('admin', 'super_admin_dev') then 'company'
    when actor.role = 'manager' then 'team'
    else 'own'
  end;
  select sequence.last_value into universe_version
  from public.opportunity_finder_dataset_universe_seq sequence;
  authorization_hash := encode(extensions.digest(convert_to(
    input_actor_id::text || chr(31) || actor.role || chr(31)
      || coalesce(actor.department, '') || chr(31) || coalesce(actor.region, ''),
    'UTF8'
  ), 'sha256'), 'hex');
  dataset_version := encode(extensions.digest(convert_to(
    'opportunity-dataset-locator-v2' || chr(31) || universe_version::text
      || chr(31) || input_actor_id::text || chr(31) || dataset_scope
      || chr(31) || authorization_hash,
    'UTF8'
  ), 'sha256'), 'hex');

  select count(*)::bigint,
    count(*) filter (
      where version.dirty is false
        and version.summary_version = version.data_version
        and version.opportunity_entity_version = version.data_version
    )::bigint
  into upload_count, ready_upload_count
  from public.business_upload_versions version
  join public.upload_batches upload on upload.id = version.upload_batch_id
  where upload.archived_at is null
    and upload.status in ('completed', 'completed_with_warnings')
    and public.opportunity_finder_actor_can_read_upload_v2(input_actor_id, version.owner_id);
  if ready_upload_count <> upload_count then
    raise exception using errcode = '55000', message = 'OPPORTUNITY_DATASET_SUMMARY_NOT_READY';
  end if;

  return jsonb_build_object(
    'datasetVersion', dataset_version,
    'datasetScope', dataset_scope,
    'datasetManifest', jsonb_build_object(
      'kind', 'opportunity-dataset-locator-v2',
      'universeVersion', universe_version::text,
      'authorizationHash', authorization_hash,
      'uploadCount', upload_count
    ),
    'uploadCount', upload_count
  );
end;
$$;
revoke all on function public.opportunity_finder_dataset_locator_for_actor_v2(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_opportunity_finder_dataset_locator_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
    raise exception using errcode = '42501', message = 'OPPORTUNITY_AUTHENTICATED_ACTOR_REQUIRED';
  end if;
  return public.opportunity_finder_dataset_locator_for_actor_v2(auth.uid());
end;
$$;
revoke all on function public.get_opportunity_finder_dataset_locator_v2()
  from public, anon, service_role;
grant execute on function public.get_opportunity_finder_dataset_locator_v2()
  to authenticated;

create or replace function public.get_opportunity_finder_uploaded_mpns_page_v2(
  input_job_id uuid,
  input_after_mpn text default null,
  input_limit integer default 100
)
returns table(normalized_mpn text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  page_limit integer := least(greatest(coalesce(input_limit, 100), 1), 500);
begin
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
    raise exception using errcode = '42501', message = 'OPPORTUNITY_AUTHENTICATED_ACTOR_REQUIRED';
  end if;
  if not exists (
    select 1 from public.opportunity_finder_jobs job
    where job.id = input_job_id
      and job.created_by = auth.uid()
      and job.tenant_id = auth.uid()
      and job.comparison_mode = 'single_file'
  ) then
    raise exception using errcode = 'P0002', message = 'OPPORTUNITY_JOB_NOT_FOUND';
  end if;
  return query
  select distinct row.normalized_mpn
  from public.opportunity_finder_rows row
  join public.opportunity_finder_files file
    on file.id = row.file_id
   and file.job_id = row.job_id
   and file.source_kind = 'uploaded'
  where row.job_id = input_job_id
    and row.normalized_mpn <> ''
    and (input_after_mpn is null or row.normalized_mpn > input_after_mpn)
  order by row.normalized_mpn
  limit page_limit;
end;
$$;
revoke all on function public.get_opportunity_finder_uploaded_mpns_page_v2(uuid,text,integer)
  from public, anon, service_role;
grant execute on function public.get_opportunity_finder_uploaded_mpns_page_v2(uuid,text,integer)
  to authenticated;

-- Read at most one bounded page of the actor-authorized opposite dataset. The
-- compact locator stored on the snapshot is the authority; neither the browser
-- nor the web request sends or reconstructs an O(upload-count) manifest.
create or replace function public.read_opportunity_finder_snapshot_chunk_v2(
  input_job_id uuid,
  input_actor_id uuid,
  input_snapshot_id uuid,
  input_generation bigint,
  input_fence_token bigint,
  input_after_source_record_id uuid default null,
  input_after_entity_kind text default null,
  input_limit integer default 250,
  input_max_bytes integer default 2097152
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_job public.opportunity_finder_jobs%rowtype;
  locked_snapshot public.opportunity_finder_dataset_snapshots%rowtype;
  candidate record;
  mapped_row jsonb;
  result_rows jsonb := '[]'::jsonb;
  page_limit integer := least(greatest(coalesce(input_limit, 250), 1), 500);
  byte_limit integer := least(greatest(coalesce(input_max_bytes, 2097152), 1024), 4194304);
  result_bytes integer := 2;
  mapped_bytes integer;
  scanned_rows integer := 0;
  returned_rows integer := 0;
  next_source_record_id uuid := input_after_source_record_id;
  next_entity_kind text := input_after_entity_kind;
  stopped_for_bytes boolean := false;
  done boolean;
  current_universe_version bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;
  if (input_after_source_record_id is null) <> (input_after_entity_kind is null)
     or (input_after_entity_kind is not null and input_after_entity_kind not in (
       'demand','stock','excess','supplier_offer','historical'
     )) then
    raise exception using errcode = '22023', message = 'SNAPSHOT_READ_CURSOR_INVALID';
  end if;

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id;
  if not found or locked_job.created_by <> input_actor_id
     or locked_job.comparison_mode <> 'single_file'
     or locked_job.status <> 'awaiting_roles'
     or locked_job.snapshot_status <> 'pending'
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'SNAPSHOT_BUILDER_FENCED';
  end if;

  select snapshot.* into locked_snapshot
  from public.opportunity_finder_dataset_snapshots snapshot
  where snapshot.id = input_snapshot_id
    and snapshot.job_id = input_job_id;
  if not found
     or locked_snapshot.build_status <> 'building'
     or locked_snapshot.build_generation <> input_generation
     or locked_snapshot.build_fence_token <> input_fence_token
     or locked_snapshot.dataset_version is distinct from locked_job.dataset_version
     or locked_snapshot.dataset_scope is distinct from locked_job.dataset_scope
     or locked_snapshot.manifest is distinct from locked_job.dataset_manifest then
    raise exception using errcode = '55000', message = 'SNAPSHOT_BUILDER_FENCED';
  end if;
  select sequence.last_value into current_universe_version
  from public.opportunity_finder_dataset_universe_seq sequence;
  if current_universe_version is distinct from locked_snapshot.universe_version then
    raise exception using errcode = '40001', message = 'SNAPSHOT_UNIVERSE_CHANGED';
  end if;

  for candidate in
    select entity.*
    from public.business_opportunity_entities entity
    join public.business_upload_versions version
      on version.upload_batch_id = entity.upload_batch_id
     and version.data_version = entity.data_version
    join public.upload_batches upload on upload.id = version.upload_batch_id
    where upload.archived_at is null
      and upload.status in ('completed', 'completed_with_warnings')
      and version.dirty is false
      and version.summary_version = version.data_version
      and version.opportunity_entity_version = version.data_version
      and public.opportunity_finder_actor_can_read_upload_v2(input_actor_id, version.owner_id)
      and exists (
        select 1
        from public.opportunity_finder_rows uploaded_row
        join public.opportunity_finder_files uploaded_file
          on uploaded_file.id = uploaded_row.file_id
         and uploaded_file.job_id = uploaded_row.job_id
         and uploaded_file.source_kind = 'uploaded'
        where uploaded_row.job_id = input_job_id
          and uploaded_row.normalized_mpn = entity.normalized_mpn
      )
      and (
        (locked_job.uploaded_role = 'demand'
          and entity.entity_kind in ('stock','excess','supplier_offer'))
        or (locked_job.uploaded_role <> 'demand' and entity.entity_kind = 'demand')
      )
      and (
        input_after_source_record_id is null
        or (entity.source_record_id, entity.entity_kind)
          > (input_after_source_record_id, input_after_entity_kind)
      )
    order by entity.source_record_id, entity.entity_kind
    limit page_limit
  loop
    scanned_rows := scanned_rows + 1;
    mapped_row := null;

    if locked_job.uploaded_role = 'demand' then
      if candidate.is_live_supply
         and (case when candidate.entity_kind = 'excess'
           then candidate.excess_qty else candidate.available_qty end) > 0
         and (candidate.entity_kind <> 'supplier_offer'
           or (candidate.expires_at is not null
             and candidate.expires_at > locked_snapshot.created_at)) then
        mapped_row := jsonb_build_object(
          'role', candidate.entity_kind,
          'source_key', encode(extensions.digest(convert_to(
            candidate.upload_batch_id::text || chr(31)
              || candidate.data_version::text || chr(31)
              || candidate.entity_key || chr(31) || candidate.entity_kind,
            'UTF8'), 'sha256'), 'hex'),
          'source_upload_id', candidate.upload_batch_id,
          'source_data_version', candidate.data_version,
          'normalized_mpn', candidate.normalized_mpn,
          'display_mpn', coalesce(candidate.display_mpn, candidate.normalized_mpn),
          'manufacturer', candidate.manufacturer_name,
          'customer_context', candidate.customer_name,
          'supplier_context', candidate.supplier_name,
          'required_qty', null,
          'available_qty', case when candidate.entity_kind = 'excess'
            then candidate.excess_qty else candidate.available_qty end,
          'excess_qty', case when candidate.entity_kind = 'excess'
            then candidate.excess_qty else null end,
          'required_date', candidate.required_date,
          'unit_of_measure', candidate.unit_of_measure,
          'lead_time_weeks', candidate.lead_time_weeks,
          'moq', candidate.moq,
          'spq', candidate.spq,
          'date_code', candidate.date_code,
          'coo', candidate.coo,
          'condition', candidate.condition,
          'expires_at', candidate.expires_at,
          'is_active_demand', true,
          'is_live_supply', true,
          'quality_flags', to_jsonb(coalesce(candidate.warnings, '{}'::text[]))
        );
      end if;
    elsif candidate.required_qty > 0 then
      mapped_row := jsonb_build_object(
        'role', 'demand',
        'source_key', encode(extensions.digest(convert_to(
          candidate.upload_batch_id::text || chr(31)
            || candidate.data_version::text || chr(31)
            || candidate.entity_key || chr(31) || 'demand',
          'UTF8'), 'sha256'), 'hex'),
        'source_upload_id', candidate.upload_batch_id,
        'source_data_version', candidate.data_version,
        'normalized_mpn', candidate.normalized_mpn,
        'display_mpn', coalesce(candidate.display_mpn, candidate.normalized_mpn),
        'manufacturer', candidate.manufacturer_name,
        'customer_context', candidate.customer_name,
        'supplier_context', candidate.supplier_name,
        'required_qty', candidate.required_qty,
        'available_qty', null,
        'excess_qty', null,
        'required_date', candidate.required_date,
        'unit_of_measure', candidate.unit_of_measure,
        'lead_time_weeks', candidate.lead_time_weeks,
        'moq', candidate.moq,
        'spq', candidate.spq,
        'date_code', candidate.date_code,
        'coo', candidate.coo,
        'condition', candidate.condition,
        'expires_at', candidate.expires_at,
        'is_active_demand', candidate.is_active_demand
          and candidate.required_date is not null
          and candidate.required_date >= locked_snapshot.created_at::date,
        'is_live_supply', true,
        'quality_flags', to_jsonb(case
          when candidate.required_date is null
            and not ('ambiguous_date' = any(coalesce(candidate.warnings, '{}'::text[])))
            then coalesce(candidate.warnings, '{}'::text[]) || array['ambiguous_date']
          else coalesce(candidate.warnings, '{}'::text[])
        end)
      );
    end if;

    if mapped_row is not null then
      mapped_bytes := octet_length(convert_to(mapped_row::text, 'UTF8'));
      if mapped_bytes + 2 > byte_limit then
        raise exception using errcode = '22023', message = 'OPPORTUNITY_SNAPSHOT_ROW_TOO_LARGE';
      end if;
      if returned_rows > 0 and result_bytes + mapped_bytes + 1 > byte_limit then
        stopped_for_bytes := true;
        scanned_rows := scanned_rows - 1;
        exit;
      end if;
      result_rows := result_rows || jsonb_build_array(mapped_row);
      result_bytes := result_bytes + mapped_bytes + case when returned_rows > 0 then 1 else 0 end;
      returned_rows := returned_rows + 1;
    end if;

    next_source_record_id := candidate.source_record_id;
    next_entity_kind := candidate.entity_kind;
  end loop;

  done := not stopped_for_bytes and scanned_rows < page_limit;
  return jsonb_build_object(
    'rows', result_rows,
    'rowCount', returned_rows,
    'scannedRows', scanned_rows,
    'payloadBytes', octet_length(convert_to(result_rows::text, 'UTF8')),
    'chunkFingerprint', encode(extensions.digest(
      convert_to(result_rows::text, 'UTF8'), 'sha256'
    ), 'hex'),
    'nextCursor', jsonb_build_object(
      'candidateSourceRecordId', next_source_record_id,
      'candidateEntityKind', next_entity_kind,
      'done', done
    ),
    'done', done
  );
end;
$$;

revoke all on function public.read_opportunity_finder_snapshot_chunk_v2(uuid,uuid,uuid,bigint,bigint,uuid,text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.read_opportunity_finder_snapshot_chunk_v2(uuid,uuid,uuid,bigint,bigint,uuid,text,integer,integer)
  to service_role;

create or replace function public.begin_opportunity_finder_dataset_snapshot_v2(
  input_job_id uuid,
  input_actor_id uuid,
  input_snapshot_id uuid,
  input_dataset_version text,
  input_dataset_scope text,
  input_idempotency_key text,
  input_lookup_metrics jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_job public.opportunity_finder_jobs%rowtype;
  existing_snapshot public.opportunity_finder_dataset_snapshots%rowtype;
  virtual_file public.opportunity_finder_files%rowtype;
  existing_job_id uuid;
  next_generation bigint := 1;
  next_fence bigint := 1;
  authoritative_locator jsonb;
  locator_manifest jsonb;
  locator_universe_version bigint;
  locator_authorization_hash text;
  empty_fingerprint text := encode(extensions.digest(convert_to('', 'UTF8'), 'sha256'), 'hex');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;
  if input_dataset_version is null
     or input_dataset_version !~ '^[0-9a-f]{64}$'
     or input_dataset_scope not in ('own', 'team', 'company')
     or input_idempotency_key is null
     or length(input_idempotency_key) not between 1 and 512
     or jsonb_typeof(input_lookup_metrics) <> 'object'
     or pg_column_size(input_lookup_metrics) > 65536 then
    raise exception using errcode = '22023', message = 'SNAPSHOT_BEGIN_PAYLOAD_INVALID';
  end if;

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;
  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'OPPORTUNITY_JOB_NOT_FOUND';
  end if;
  authoritative_locator := public.opportunity_finder_dataset_locator_for_actor_v2(input_actor_id);
  locator_manifest := authoritative_locator->'datasetManifest';
  locator_universe_version := (locator_manifest->>'universeVersion')::bigint;
  locator_authorization_hash := locator_manifest->>'authorizationHash';
  if locked_job.comparison_mode <> 'single_file'
     or locked_job.status <> 'awaiting_roles'
     or locked_job.snapshot_status <> 'pending'
     or locked_job.cancel_requested
     or locked_job.uploaded_role is null
     or locked_job.opposite_dataset_role is null
     or locked_job.dataset_version is distinct from input_dataset_version
     or locked_job.dataset_scope is distinct from input_dataset_scope
     or locked_job.dataset_version is distinct from authoritative_locator->>'datasetVersion'
     or locked_job.dataset_scope is distinct from authoritative_locator->>'datasetScope'
     or locked_job.dataset_manifest is distinct from locator_manifest then
    raise exception using errcode = '40001', message = 'OPPORTUNITY_SNAPSHOT_JOB_CHANGED';
  end if;

  -- The compact job locator is the only authority. R7 has no manifest argument,
  -- so callers cannot resend an O(upload-count) payload.
  perform pg_advisory_xact_lock(hashtextextended(
    locked_job.tenant_id::text || chr(31) || input_actor_id::text
      || chr(31) || input_idempotency_key,
    0
  ));

  select job.id into existing_job_id
  from public.opportunity_finder_jobs job
  where job.tenant_id = locked_job.tenant_id
    and job.created_by = input_actor_id
    and job.idempotency_key = input_idempotency_key
    and job.id <> input_job_id
    and job.comparison_mode = 'single_file'
    and job.status in (
      'uploading', 'queued', 'profiling', 'awaiting_roles',
      'parsing', 'matching', 'completed', 'completed_with_warnings'
    )
    and job.expires_at > clock_timestamp()
  order by job.created_at desc
  limit 1;
  if existing_job_id is not null then
    update public.opportunity_finder_jobs job
    set status = 'cancelled',
        cancel_requested = true,
        cancelled_at = clock_timestamp(),
        error_code = 'COMPARISON_ALREADY_EXISTS',
        updated_at = clock_timestamp()
    where job.id = input_job_id;
    return jsonb_build_object(
      'committedJobId', existing_job_id,
      'reused', true,
      'snapshotId', null,
      'generation', null,
      'fenceToken', null,
      'nextChunkSequence', null,
      'rowsFingerprint', null,
      'cursor', null
    );
  end if;

  select file.* into virtual_file
  from public.opportunity_finder_files file
  where file.job_id = input_job_id
    and file.source_kind = 'platform_snapshot'
  for update;
  if not found
     or virtual_file.validation_status <> 'verified'
     or virtual_file.content_sha256 is null
     or virtual_file.mime_type is distinct from 'application/json'
     or virtual_file.storage_bucket is distinct from 'opportunity-finder'
     or virtual_file.storage_path is distinct from (
       locked_job.created_by::text || '/' || input_job_id::text || '/'
         || virtual_file.id::text || '.json'
     ) then
    raise exception using errcode = '55000', message = 'OPPORTUNITY_VIRTUAL_FILE_INVALID';
  end if;

  select snapshot.* into existing_snapshot
  from public.opportunity_finder_dataset_snapshots snapshot
  where snapshot.job_id = input_job_id
  for update;

  if found
     and existing_snapshot.build_status = 'building'
     and existing_snapshot.dataset_version = input_dataset_version
     and existing_snapshot.dataset_scope = input_dataset_scope
     and existing_snapshot.manifest = locator_manifest
     and existing_snapshot.build_idempotency_key = input_idempotency_key
     and existing_snapshot.universe_version = locator_universe_version
     and existing_snapshot.authorization_hash = locator_authorization_hash then
    return jsonb_build_object(
      'committedJobId', input_job_id,
      'reused', false,
      'resumed', true,
      'snapshotId', existing_snapshot.id,
      'generation', existing_snapshot.build_generation,
      'fenceToken', existing_snapshot.build_fence_token,
      'nextChunkSequence', existing_snapshot.build_last_chunk_sequence + 1,
      'entityCount', existing_snapshot.entity_count,
      'rowsFingerprint', existing_snapshot.build_rows_fingerprint,
      'cursor', existing_snapshot.build_cursor
    );
  end if;

  if found then
    next_generation := existing_snapshot.build_generation + 1;
    next_fence := existing_snapshot.build_fence_token + 1;
    -- A changed locator/idempotency is an explicit restart boundary. A normal
    -- HTTP continuation takes the resume branch above and never repeats O(N).
    delete from public.opportunity_finder_dataset_snapshots snapshot
    where snapshot.id = existing_snapshot.id
      and snapshot.job_id = input_job_id;
  end if;

  insert into public.opportunity_finder_dataset_snapshots (
    id, job_id, tenant_id, created_by, uploaded_role, opposite_dataset_role,
    dataset_version, dataset_scope, manifest, entity_count, mpn_count,
    build_status, build_generation, build_fence_token,
    build_last_chunk_sequence, build_last_chunk_fingerprint,
    build_rows_fingerprint, build_cursor, build_idempotency_key,
    universe_version, authorization_hash, build_lookup_metrics, finalized_at
  ) values (
    input_snapshot_id, input_job_id, locked_job.tenant_id, input_actor_id,
    locked_job.uploaded_role, locked_job.opposite_dataset_role,
    input_dataset_version, input_dataset_scope, locked_job.dataset_manifest,
    0, 0, 'building', next_generation, next_fence, -1, null,
    empty_fingerprint, '{}'::jsonb, input_idempotency_key,
    locator_universe_version, locator_authorization_hash,
    input_lookup_metrics, null
  );

  update public.opportunity_finder_jobs job
  set idempotency_key = input_idempotency_key,
      dataset_snapshot_id = null,
      dataset_snapshot_at = null,
      snapshot_status = 'pending',
      existing_entity_count = 0,
      existing_mpn_count = 0,
      updated_at = clock_timestamp()
  where job.id = input_job_id;

  return jsonb_build_object(
    'committedJobId', input_job_id,
    'reused', false,
    'resumed', false,
    'snapshotId', input_snapshot_id,
    'generation', next_generation,
    'fenceToken', next_fence,
    'nextChunkSequence', 0,
    'entityCount', 0,
    'rowsFingerprint', empty_fingerprint,
    'cursor', '{}'::jsonb
  );
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'SNAPSHOT_ID_CONFLICT';
end;
$$;

create or replace function public.append_opportunity_finder_dataset_snapshot_rows_v2(
  input_job_id uuid,
  input_actor_id uuid,
  input_snapshot_id uuid,
  input_generation bigint,
  input_fence_token bigint,
  input_chunk_sequence integer,
  input_rows jsonb,
  input_payload_bytes bigint,
  input_chunk_fingerprint text,
  input_next_cursor jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_job public.opportunity_finder_jobs%rowtype;
  locked_snapshot public.opportunity_finder_dataset_snapshots%rowtype;
  virtual_file_id uuid;
  row_count integer;
  inserted_count integer := 0;
  actual_payload_bytes bigint;
  payload_fingerprint text;
  effective_chunk_fingerprint text;
  next_rows_fingerprint text;
  current_universe_version bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;
  if input_chunk_sequence < 0
     or jsonb_typeof(input_rows) <> 'array'
     or input_payload_bytes < 0
     or input_payload_bytes > 8388608
     or input_chunk_fingerprint is null
     or input_chunk_fingerprint !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(input_next_cursor) <> 'object'
     or pg_column_size(input_next_cursor) > 8192
     or (input_next_cursor - array[
       'uploadedMpn','candidateSourceRecordId','candidateEntityKind','done'
     ]::text[]) <> '{}'::jsonb
     or coalesce(input_next_cursor->>'done', '') not in ('true', 'false')
     or (
       input_next_cursor ? 'candidateEntityKind'
       and input_next_cursor->>'candidateEntityKind' is not null
       and input_next_cursor->>'candidateEntityKind' not in (
         'demand','stock','excess','supplier_offer','historical'
       )
     ) then
    raise exception using errcode = '22023', message = 'SNAPSHOT_APPEND_PAYLOAD_INVALID';
  end if;
  row_count := jsonb_array_length(input_rows);
  actual_payload_bytes := pg_column_size(input_rows)::bigint;
  if row_count not between 0 and 1000 or actual_payload_bytes > 8388608 then
    raise exception using errcode = '22023', message = 'SNAPSHOT_APPEND_LIMIT_EXCEEDED';
  end if;

  payload_fingerprint := encode(extensions.digest(
    convert_to(input_rows::text, 'UTF8'), 'sha256'
  ), 'hex');
  effective_chunk_fingerprint := encode(extensions.digest(
    convert_to(input_chunk_fingerprint || ':' || payload_fingerprint
      || ':' || input_next_cursor::text, 'UTF8'),
    'sha256'
  ), 'hex');

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;
  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'OPPORTUNITY_JOB_NOT_FOUND';
  end if;
  if locked_job.comparison_mode <> 'single_file'
     or locked_job.status <> 'awaiting_roles'
     or locked_job.snapshot_status <> 'pending'
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'SNAPSHOT_BUILDER_FENCED';
  end if;

  select snapshot.* into locked_snapshot
  from public.opportunity_finder_dataset_snapshots snapshot
  where snapshot.id = input_snapshot_id
    and snapshot.job_id = input_job_id
  for update;
  if not found
     or locked_snapshot.build_status <> 'building'
     or locked_snapshot.build_generation <> input_generation
     or locked_snapshot.build_fence_token <> input_fence_token
     or locked_snapshot.dataset_version is distinct from locked_job.dataset_version
     or locked_snapshot.dataset_scope is distinct from locked_job.dataset_scope
     or locked_snapshot.manifest is distinct from locked_job.dataset_manifest then
    raise exception using errcode = '55000', message = 'SNAPSHOT_BUILDER_FENCED';
  end if;
  select sequence.last_value into current_universe_version
  from public.opportunity_finder_dataset_universe_seq sequence;
  if current_universe_version is distinct from locked_snapshot.universe_version then
    raise exception using errcode = '40001', message = 'SNAPSHOT_UNIVERSE_CHANGED';
  end if;

  if input_chunk_sequence <= locked_snapshot.build_last_chunk_sequence then
    if input_chunk_sequence <> locked_snapshot.build_last_chunk_sequence
       or locked_snapshot.build_last_chunk_fingerprint is distinct from effective_chunk_fingerprint
       or locked_snapshot.build_cursor is distinct from input_next_cursor then
      raise exception using errcode = '22023', message = 'SNAPSHOT_APPEND_DUPLICATE_MISMATCH';
    end if;
    return jsonb_build_object(
      'accepted', false,
      'duplicate', true,
      'nextChunkSequence', locked_snapshot.build_last_chunk_sequence + 1,
      'entityCount', locked_snapshot.entity_count,
      'rowsFingerprint', locked_snapshot.build_rows_fingerprint,
      'cursor', locked_snapshot.build_cursor
    );
  end if;
  if input_chunk_sequence <> locked_snapshot.build_last_chunk_sequence + 1 then
    raise exception using errcode = '22023', message = 'SNAPSHOT_APPEND_SEQUENCE_INVALID';
  end if;
  if locked_snapshot.entity_count::bigint + row_count > 5000000 then
    raise exception using errcode = '22023', message = 'SNAPSHOT_TOTAL_ROW_LIMIT_EXCEEDED';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(input_rows) item
    where coalesce(item->>'source_key', '') = ''
       or length(item->>'source_key') > 500
       or coalesce(item->>'normalized_mpn', '') = ''
       or coalesce(item->>'display_mpn', '') = ''
       or coalesce(item->>'role', '') not in ('demand', 'stock', 'excess', 'supplier_offer')
       or coalesce(jsonb_typeof(item->'quality_flags'), 'array') <> 'array'
       or not exists (
         select 1
         from public.business_upload_versions version
         join public.upload_batches upload on upload.id = version.upload_batch_id
         where version.upload_batch_id = (item->>'source_upload_id')::uuid
           and version.data_version = (item->>'source_data_version')::bigint
           and version.summary_version = version.data_version
           and version.opportunity_entity_version = version.data_version
           and version.dirty is false
           and upload.archived_at is null
           and upload.status in ('completed', 'completed_with_warnings')
           and public.opportunity_finder_actor_can_read_upload_v2(
             input_actor_id, version.owner_id
           )
       )
  ) then
    raise exception using errcode = '22023', message = 'SNAPSHOT_ROW_INVALID_OR_OUTSIDE_MANIFEST';
  end if;
  if (
    select count(distinct item->>'source_key')
    from jsonb_array_elements(input_rows) item
  ) <> row_count then
    raise exception using errcode = '22023', message = 'SNAPSHOT_SOURCE_KEY_DUPLICATE';
  end if;
  if exists (
    select 1
    from public.opportunity_finder_dataset_snapshot_rows existing
    join jsonb_array_elements(input_rows) item
      on item->>'source_key' = existing.source_key
    where existing.snapshot_id = input_snapshot_id
  ) then
    raise exception using errcode = '22023', message = 'SNAPSHOT_SOURCE_KEY_DUPLICATE';
  end if;

  select file.id into virtual_file_id
  from public.opportunity_finder_files file
  where file.job_id = input_job_id
    and file.source_kind = 'platform_snapshot';
  if virtual_file_id is null then
    raise exception using errcode = '55000', message = 'OPPORTUNITY_VIRTUAL_FILE_MISSING';
  end if;

  insert into public.opportunity_finder_dataset_snapshot_rows (
    snapshot_id, job_id, virtual_file_id, role, source_key, source_upload_id,
    source_data_version, normalized_mpn, display_mpn, manufacturer,
    customer_context, supplier_context, required_qty, available_qty, excess_qty,
    required_date, unit_of_measure, lead_time_weeks, moq, spq, date_code, coo,
    condition, expires_at, is_active_demand, is_live_supply, quality_flags
  )
  select
    input_snapshot_id, input_job_id, virtual_file_id,
    item->>'role', item->>'source_key', (item->>'source_upload_id')::uuid,
    (item->>'source_data_version')::bigint, item->>'normalized_mpn',
    item->>'display_mpn', nullif(item->>'manufacturer', ''),
    nullif(item->>'customer_context', ''), nullif(item->>'supplier_context', ''),
    nullif(item->>'required_qty', '')::numeric,
    nullif(item->>'available_qty', '')::numeric,
    nullif(item->>'excess_qty', '')::numeric,
    nullif(item->>'required_date', '')::date,
    nullif(item->>'unit_of_measure', ''),
    nullif(item->>'lead_time_weeks', '')::numeric,
    nullif(item->>'moq', '')::numeric, nullif(item->>'spq', '')::numeric,
    nullif(item->>'date_code', ''), nullif(item->>'coo', ''),
    nullif(item->>'condition', ''), nullif(item->>'expires_at', '')::timestamptz,
    coalesce(nullif(item->>'is_active_demand', '')::boolean, true),
    coalesce(nullif(item->>'is_live_supply', '')::boolean, true),
    coalesce(item->'quality_flags', '[]'::jsonb)
  from jsonb_array_elements(input_rows) item
  on conflict (snapshot_id, source_key) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count <> row_count then
    raise exception using errcode = '40001', message = 'SNAPSHOT_APPEND_CONFLICT';
  end if;

  next_rows_fingerprint := encode(extensions.digest(
    convert_to(
      coalesce(locked_snapshot.build_rows_fingerprint, '')
        || effective_chunk_fingerprint,
      'UTF8'
    ),
    'sha256'
  ), 'hex');
  update public.opportunity_finder_dataset_snapshots snapshot
  set entity_count = snapshot.entity_count + inserted_count,
      build_last_chunk_sequence = input_chunk_sequence,
      build_last_chunk_fingerprint = effective_chunk_fingerprint,
      build_rows_fingerprint = next_rows_fingerprint,
      build_cursor = input_next_cursor
  where snapshot.id = input_snapshot_id;

  return jsonb_build_object(
    'accepted', true,
    'duplicate', false,
    'nextChunkSequence', input_chunk_sequence + 1,
    'entityCount', locked_snapshot.entity_count + inserted_count,
    'rowsFingerprint', next_rows_fingerprint,
    'cursor', input_next_cursor
  );
end;
$$;

create or replace function public.finalize_opportunity_finder_dataset_snapshot_v2(
  input_job_id uuid,
  input_actor_id uuid,
  input_snapshot_id uuid,
  input_generation bigint,
  input_fence_token bigint,
  input_expected_entity_count bigint,
  input_rows_fingerprint text,
  input_lookup_metrics jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_job public.opportunity_finder_jobs%rowtype;
  locked_snapshot public.opportunity_finder_dataset_snapshots%rowtype;
  virtual_file_id uuid;
  actual_entity_count bigint;
  actual_mpn_count integer;
  current_universe_version bigint;
  now_value timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;
  if input_expected_entity_count < 0
     or input_expected_entity_count > 5000000
     or input_rows_fingerprint is null
     or input_rows_fingerprint !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(input_lookup_metrics) <> 'object'
     or pg_column_size(input_lookup_metrics) > 65536 then
    raise exception using errcode = '22023', message = 'SNAPSHOT_FINALIZE_PAYLOAD_INVALID';
  end if;

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;
  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'OPPORTUNITY_JOB_NOT_FOUND';
  end if;

  select snapshot.* into locked_snapshot
  from public.opportunity_finder_dataset_snapshots snapshot
  where snapshot.id = input_snapshot_id
    and snapshot.job_id = input_job_id
  for update;
  if not found
     or locked_snapshot.build_generation <> input_generation
     or locked_snapshot.build_fence_token <> input_fence_token then
    raise exception using errcode = '55000', message = 'SNAPSHOT_BUILDER_FENCED';
  end if;

  if locked_snapshot.build_status = 'ready'
     and locked_job.snapshot_status = 'ready'
     and locked_job.dataset_snapshot_id = input_snapshot_id then
    return jsonb_build_object(
      'committedJobId', input_job_id,
      'reused', false,
      'snapshotId', input_snapshot_id,
      'status', 'ready',
      'entityCount', locked_snapshot.entity_count,
      'mpnCount', locked_snapshot.mpn_count
    );
  end if;
  if locked_snapshot.build_status <> 'building'
     or locked_job.comparison_mode <> 'single_file'
     or locked_job.status <> 'awaiting_roles'
     or locked_job.snapshot_status <> 'pending'
     or locked_job.cancel_requested
     or locked_snapshot.dataset_version is distinct from locked_job.dataset_version
     or locked_snapshot.dataset_scope is distinct from locked_job.dataset_scope
     or locked_snapshot.manifest is distinct from locked_job.dataset_manifest then
    raise exception using errcode = '55000', message = 'SNAPSHOT_BUILDER_FENCED';
  end if;
  select sequence.last_value into current_universe_version
  from public.opportunity_finder_dataset_universe_seq sequence;
  if current_universe_version is distinct from locked_snapshot.universe_version then
    raise exception using errcode = '40001', message = 'SNAPSHOT_UNIVERSE_CHANGED';
  end if;

  select count(*)::bigint, count(distinct row.normalized_mpn)::integer
  into actual_entity_count, actual_mpn_count
  from public.opportunity_finder_dataset_snapshot_rows row
  where row.snapshot_id = input_snapshot_id
    and row.job_id = input_job_id;
  if actual_entity_count <> input_expected_entity_count
     or locked_snapshot.entity_count::bigint <> input_expected_entity_count
     or locked_snapshot.build_rows_fingerprint is distinct from input_rows_fingerprint then
    raise exception using errcode = '40001', message = 'SNAPSHOT_FINALIZE_COUNTS_STALE';
  end if;

  select file.id into virtual_file_id
  from public.opportunity_finder_files file
  where file.job_id = input_job_id
    and file.source_kind = 'platform_snapshot'
  for update;
  if virtual_file_id is null then
    raise exception using errcode = '55000', message = 'OPPORTUNITY_VIRTUAL_FILE_MISSING';
  end if;

  update public.opportunity_finder_dataset_snapshots snapshot
  set mpn_count = actual_mpn_count,
      build_status = 'ready',
      build_lookup_metrics = snapshot.build_lookup_metrics || input_lookup_metrics,
      finalized_at = now_value
  where snapshot.id = input_snapshot_id;

  -- The descriptor has no Storage object.  Marking only this virtual file as
  -- deleted keeps retention workers from attempting a synthetic path.
  update public.opportunity_finder_files file
  set storage_deleted_at = now_value
  where file.id = virtual_file_id
    and file.job_id = input_job_id
    and file.source_kind = 'platform_snapshot';

  update public.opportunity_finder_jobs job
  set dataset_snapshot_id = input_snapshot_id,
      dataset_snapshot_at = now_value,
      snapshot_status = 'ready',
      existing_entity_count = actual_entity_count::integer,
      existing_mpn_count = actual_mpn_count,
      performance_metrics = coalesce(job.performance_metrics, '{}'::jsonb)
        || locked_snapshot.build_lookup_metrics || input_lookup_metrics,
      status = 'queued',
      current_stage = 'finding_matches',
      progress_percent = 58,
      attempts = 0,
      error_code = null,
      next_retry_at = null,
      locked_at = null,
      locked_by = null,
      heartbeat_at = null,
      lock_token = null,
      updated_at = now_value
  where job.id = input_job_id;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id,
    safe_metadata
  ) values (
    locked_job.tenant_id, input_job_id, input_actor_id,
    'single_file_dataset_snapshotted',
    'opportunity_finder_dataset_snapshot', input_snapshot_id,
    jsonb_build_object(
      'datasetVersion', locked_snapshot.dataset_version,
      'entityCount', actual_entity_count,
      'mpnCount', actual_mpn_count,
      'chunkCount', locked_snapshot.build_last_chunk_sequence + 1
    )
  );

  return jsonb_build_object(
    'committedJobId', input_job_id,
    'reused', false,
    'snapshotId', input_snapshot_id,
    'status', 'ready',
    'entityCount', actual_entity_count,
    'mpnCount', actual_mpn_count
  );
end;
$$;

revoke all on function public.begin_opportunity_finder_dataset_snapshot_v2(uuid,uuid,uuid,text,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.append_opportunity_finder_dataset_snapshot_rows_v2(uuid,uuid,uuid,bigint,bigint,integer,jsonb,bigint,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.finalize_opportunity_finder_dataset_snapshot_v2(uuid,uuid,uuid,bigint,bigint,bigint,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.begin_opportunity_finder_dataset_snapshot_v2(uuid,uuid,uuid,text,text,text,jsonb)
  to service_role;
grant execute on function public.append_opportunity_finder_dataset_snapshot_rows_v2(uuid,uuid,uuid,bigint,bigint,integer,jsonb,bigint,text,jsonb)
  to service_role;
grant execute on function public.finalize_opportunity_finder_dataset_snapshot_v2(uuid,uuid,uuid,bigint,bigint,bigint,text,jsonb)
  to service_role;

-- The monolithic U-row JSONB persistence path is no longer callable after R7.
revoke execute on function public.persist_opportunity_finder_dataset_snapshot(uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb)
  from service_role;

-- ================================================================
-- SECTION D: NON-BLOCKING DATABASE SAFETY WATERMARK
-- Owned by r7_watermark_sql. Append only below this marker.
-- ================================================================

-- Keep one runtime catalog authoritative for preflight, purge ordering and
-- watermark trigger coverage.  The TypeScript mirror is contract-tested.
create or replace function public.database_safety_table_catalog_v2()
returns table(
  schema_name text,
  table_name text,
  category text,
  planned_action text,
  delete_order integer,
  reason text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    original.schema_name,
    original.table_name,
    case
      when original.table_name in ('password_reset_codes','api_rate_limits','observability_log_outbox')
        then 'SYSTEM_EPHEMERAL'
      else original.category
    end,
    case
      when original.schema_name='public' and original.table_name in (
        'password_reset_codes','api_rate_limits','observability_log_outbox',
        'audit_logs','security_events','system_logs','client_logs','performance_logs'
      ) then 'PRESERVE'
      else original.planned_action
    end,
    case
      when original.schema_name='public' and original.table_name in (
        'password_reset_codes','api_rate_limits','observability_log_outbox',
        'audit_logs','security_events','system_logs','client_logs','performance_logs'
      ) then null
      else original.delete_order
    end,
    case
      when original.table_name='password_reset_codes' then 'Authentication recovery state is preserved.'
      when original.table_name='api_rate_limits' then 'Security rate-limit state is preserved and does not stale business backups.'
      when original.table_name='observability_log_outbox' then 'Observability delivery state is preserved.'
      when original.table_name in ('audit_logs','security_events','system_logs','client_logs','performance_logs')
        then 'Security and observability evidence is preserved.'
      when original.table_name='database_safety_state'
        then 'Database Safety configuration; authoritative watermarks are sequence-backed.'
      else original.reason
    end
  from public.database_safety_table_catalog() original
  union all
  select 'public','import_job_staging_rows','OPERATIONAL_DATA','DELETE',5,
    'Transient import staging can contain business data.'
  union all
  select 'public','worker_runtime_heartbeats','SYSTEM_EPHEMERAL','PRESERVE',null,
    'Worker liveness contains no business payload and is preserved.'
  union all
  select 'public','business_summary_mpn_stage','BUSINESS_DATA','DELETE',5,
    'Version-fenced staged MPN summary aggregates.'
  union all
  select 'public','business_summary_entity_stage','BUSINESS_DATA','DELETE',5,
    'Version-fenced staged opportunity entities.';
$$;

create or replace function public.database_safety_catalog_version_v2()
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$ select '20260825120000-r7-v1'::text $$;

update public.database_safety_state
set catalog_version='20260825120000-r7-v1',updated_at=clock_timestamp()
where singleton;

-- PostgreSQL sequences are non-transactional: an aborted writer may stale a
-- backup conservatively, but a committed writer can never disappear. CACHE 1
-- bounds allocation gaps and keeps last_value exact for every nextval call.
create sequence public.database_safety_data_version_seq
  as bigint increment by 1 minvalue 1 no maxvalue start with 1 cache 1 no cycle;
create sequence public.database_safety_storage_version_seq
  as bigint increment by 1 minvalue 1 no maxvalue start with 1 cache 1 no cycle;

select pg_catalog.setval(
  'public.database_safety_data_version_seq'::regclass,
  state.data_version,
  true
)
from public.database_safety_state state
where state.singleton;

select pg_catalog.setval(
  'public.database_safety_storage_version_seq'::regclass,
  state.storage_version,
  true
)
from public.database_safety_state state
where state.singleton;

revoke all on sequence public.database_safety_data_version_seq from public,anon,authenticated,service_role;
revoke all on sequence public.database_safety_storage_version_seq from public,anon,authenticated,service_role;

create or replace function public.database_safety_watermark_lock_key_v3()
returns bigint
language sql
immutable
security definer
set search_path = pg_catalog
as $$ select 7000000002026082512::bigint $$;

create or replace function public.database_safety_current_watermarks_v3()
returns table(data_version bigint,storage_version bigint)
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select data_sequence.last_value,storage_sequence.last_value
  from public.database_safety_data_version_seq data_sequence,
       public.database_safety_storage_version_seq storage_sequence;
$$;

create or replace function public.database_safety_capture_watermarks_v3()
returns table(data_version bigint,storage_version bigint)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  -- One exclusive boundary waits for all prior data and Storage writers. Both
  -- trigger families use the same shared key, avoiding cross-scope deadlocks.
  perform pg_advisory_xact_lock(public.database_safety_watermark_lock_key_v3());
  return query select current_versions.data_version,current_versions.storage_version
  from public.database_safety_current_watermarks_v3() current_versions;
end;
$$;

create or replace function public.touch_database_safety_watermark()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock_shared(public.database_safety_watermark_lock_key_v3());
  perform nextval('public.database_safety_data_version_seq'::regclass);
  return null;
end;
$$;

create or replace function public.touch_database_safety_storage_watermark_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected_bucket text;
begin
  affected_bucket:=case
    when tg_op='DELETE' then old.bucket_id
    when tg_op='INSERT' then new.bucket_id
    when old.bucket_id in ('excel-uploads','chat-attachments','email-attachments','client-assets','opportunity-finder')
      then old.bucket_id
    else new.bucket_id
  end;
  if affected_bucket in ('excel-uploads','chat-attachments','email-attachments','client-assets','opportunity-finder') then
    perform pg_advisory_xact_lock_shared(public.database_safety_watermark_lock_key_v3());
    perform nextval('public.database_safety_storage_version_seq'::regclass);
  end if;
  return null;
end;
$$;

create or replace function public.database_safety_current_snapshot_v2(input_actor_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  state public.database_safety_state;
  current_data_version bigint;
  current_storage_version bigint;
  preflight jsonb;
  migration_version text:='unknown';
  storage_count bigint:=null;
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  preflight:=public.database_safety_catalog_preflight_v2();
  if not coalesce((preflight->>'classified')::boolean,false) then
    raise exception 'CATALOG_UNCLASSIFIED' using errcode='55000';
  end if;
  select * into state from public.database_safety_state where singleton;
  select versions.data_version,versions.storage_version
  into current_data_version,current_storage_version
  from public.database_safety_current_watermarks_v3() versions;
  begin
    select coalesce(max(version)::text, 'unknown') into migration_version
    from supabase_migrations.schema_migrations;
  exception when others then migration_version:='unknown'; end;
  begin
    select count(*) into storage_count from storage.objects
    where bucket_id in (
      select bucket_id from public.database_safety_storage_catalog_v2()
      where planned_action='BUSINESS_DELETE'
    );
  exception when others then storage_count:=null; end;
  return jsonb_build_object(
    'dataVersion',current_data_version,
    'storageVersion',current_storage_version,
    'catalogVersion',preflight->>'catalogVersion',
    'schemaInventoryHash',preflight->>'schemaInventoryHash',
    'schemaVersion',migration_version,
    'migrationVersion',migration_version,
    'tableCount',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
    'storageObjectCount',storage_count,
    'storageFilesIncluded',true,
    'deleteEnabledInDatabase',state.delete_enabled,
    'databaseScope',jsonb_build_object('schema','public','included',true),
    'storageScope',(select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket_id,'action',planned_action,'reason',reason) order by bucket_id),'[]'::jsonb) from public.database_safety_storage_catalog_v2()),
    'authScope','PRESERVED_NOT_INCLUDED',
    'catalog',preflight,
    'tables',(select coalesce(jsonb_agg(jsonb_build_object('schema',schema_name,'table',table_name,'category',category,'action',planned_action,'reason',reason) order by coalesce(delete_order,2147483647),schema_name,table_name),'[]'::jsonb) from public.database_safety_table_catalog_v2())
  );
end;
$$;

create or replace function public.database_safety_dry_run_v2(input_actor_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  snapshot jsonb;
begin
  snapshot:=public.database_safety_current_snapshot_v2(input_actor_id);
  return jsonb_build_object(
    'dryRun',true,
    'modifiedRows',0,
    'dataVersion',snapshot->'dataVersion',
    'storageVersion',snapshot->'storageVersion',
    'catalogVersion',snapshot->'catalogVersion',
    'schemaInventoryHash',snapshot->'schemaInventoryHash',
    'wouldDelete',public.database_safety_counts_v2('DELETE'),
    'wouldPreserve',public.database_safety_counts_v2('PRESERVE'),
    'storageScope',snapshot->'storageScope',
    'authScope',snapshot->'authScope',
    'unclassifiedResources',snapshot#>'{catalog,unclassified}'
  );
end;
$$;

create or replace function public.begin_database_backup_manifest_v2(input_actor_id uuid,input_file_name text)
returns public.database_backup_manifests
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  snapshot jsonb;
  boundary_data_version bigint;
  boundary_storage_version bigint;
  created_manifest public.database_backup_manifests;
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  if input_file_name !~ '^backup-respaldo-seguridad-quiksol-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\.tar$' then
    raise exception 'BACKUP_FILE_NAME_INVALID' using errcode='22023';
  end if;

  -- Preflight/counts may be comparatively expensive, so compute them before
  -- entering the short exclusive writer boundary. Only versions are captured
  -- under the fence and become the manifest authority.
  snapshot:=public.database_safety_current_snapshot_v2(input_actor_id);
  select versions.data_version,versions.storage_version
  into boundary_data_version,boundary_storage_version
  from public.database_safety_capture_watermarks_v3() versions;

  insert into public.database_backup_manifests(
    created_by,expires_at,file_name,format,sha256,size_bytes,table_count,
    database_project,schema_version,migration_version,data_version,
    restore_list_verified,restore_verified,storage_files_included,status,
    storage_version,catalog_version,schema_inventory_hash,backup_scope,auth_scope,
    generated_at
  ) values (
    input_actor_id,clock_timestamp()+interval '30 minutes',input_file_name,
    'quiksol-safety-bundle-v2',repeat('0',64),1,(snapshot->>'tableCount')::integer,
    'pending',snapshot->>'schemaVersion',snapshot->>'migrationVersion',boundary_data_version,
    false,false,false,'creating',boundary_storage_version,
    snapshot->>'catalogVersion',snapshot->>'schemaInventoryHash',
    jsonb_build_object('database',snapshot->'databaseScope','storage',snapshot->'storageScope','auth',snapshot->'authScope'),
    'PRESERVED_NOT_INCLUDED',clock_timestamp()
  ) returning * into created_manifest;
  insert into public.database_safety_audit_events(
    backup_manifest_id,actor_id,event_type,status,catalog_version,data_version,storage_scope
  ) values (
    created_manifest.id,input_actor_id,'backup_creating','started',created_manifest.catalog_version,
    created_manifest.data_version,created_manifest.backup_scope->'storage'
  );
  return created_manifest;
end;
$$;

create or replace function public.verify_database_backup_manifest_v2(input_actor_id uuid,input_manifest_id uuid,input_evidence_hash text)
returns public.database_backup_manifests
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  manifest public.database_backup_manifests;
  current_data_version bigint;
  current_storage_version bigint;
  preflight jsonb;
  current_migration_version text:='unknown';
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  select * into manifest from public.database_backup_manifests
  where id=input_manifest_id and created_by=input_actor_id for update;
  if manifest.id is null or manifest.status<>'created' or manifest.evidence_hash<>input_evidence_hash then
    raise exception 'BACKUP_STATE_INVALID' using errcode='55000';
  end if;
  update public.database_backup_manifests set status='verifying' where id=manifest.id;
  select versions.data_version,versions.storage_version
  into current_data_version,current_storage_version
  from public.database_safety_current_watermarks_v3() versions;
  preflight:=public.database_safety_catalog_preflight_v2();
  begin
    select coalesce(max(version)::text, 'unknown') into current_migration_version
    from supabase_migrations.schema_migrations;
  exception when others then current_migration_version:='unknown'; end;
  if not (preflight->>'classified')::boolean
     or manifest.data_version<>current_data_version
     or manifest.storage_version<>current_storage_version
     or manifest.catalog_version<>preflight->>'catalogVersion'
     or manifest.schema_inventory_hash<>preflight->>'schemaInventoryHash'
     or manifest.migration_version<>current_migration_version
     or manifest.schema_version<>current_migration_version then
    raise exception 'BACKUP_STALE' using errcode='55000';
  end if;
  if not manifest.restore_list_verified or not manifest.restore_verified or not manifest.storage_files_included
     or manifest.database_sha256 !~ '^[0-9a-f]{64}$'
     or manifest.storage_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'BACKUP_NOT_VERIFIED' using errcode='55000';
  end if;
  update public.database_backup_manifests
  set status='verified',verified_at=clock_timestamp()
  where id=manifest.id returning * into manifest;
  insert into public.database_safety_audit_events(
    backup_manifest_id,actor_id,event_type,status,manifest_hash,catalog_version,data_version,storage_scope
  ) values (
    manifest.id,input_actor_id,'backup_verified','completed',manifest.evidence_hash,
    manifest.catalog_version,manifest.data_version,manifest.backup_scope->'storage'
  );
  return manifest;
end;
$$;

create or replace function public.arm_database_destruction_v2(
  input_actor_id uuid,
  input_backup_manifest_id uuid,
  input_challenge_hash text,
  input_session_binding_hash text,
  input_ip_hash text default null
)
returns public.database_destruction_operations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  manifest public.database_backup_manifests;
  current_data_version bigint;
  current_storage_version bigint;
  preflight jsonb;
  operation public.database_destruction_operations;
  current_migration_version text:='unknown';
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  if input_challenge_hash !~ '^[0-9a-f]{64}$' or input_session_binding_hash !~ '^[0-9a-f]{64}$'
     or (input_ip_hash is not null and input_ip_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'CHALLENGE_INVALID' using errcode='22023';
  end if;
  if exists(select 1 from public.database_destruction_operations where challenge_hash=input_challenge_hash) then
    raise exception 'CHALLENGE_ALREADY_USED' using errcode='55000';
  end if;
  select * into manifest from public.database_backup_manifests
  where id=input_backup_manifest_id and created_by=input_actor_id for update;
  if manifest.id is null or manifest.status<>'verified' or not manifest.restore_verified
     or not manifest.storage_files_included or manifest.downloaded_at is null
     or manifest.expires_at<=clock_timestamp() then
    raise exception 'BACKUP_NOT_VERIFIED' using errcode='55000';
  end if;
  select versions.data_version,versions.storage_version
  into current_data_version,current_storage_version
  from public.database_safety_current_watermarks_v3() versions;
  preflight:=public.database_safety_catalog_preflight_v2();
  begin
    select coalesce(max(version)::text, 'unknown') into current_migration_version
    from supabase_migrations.schema_migrations;
  exception when others then current_migration_version:='unknown'; end;
  if not (preflight->>'classified')::boolean
     or manifest.data_version<>current_data_version
     or manifest.storage_version<>current_storage_version
     or manifest.catalog_version<>preflight->>'catalogVersion'
     or manifest.schema_inventory_hash<>preflight->>'schemaInventoryHash'
     or manifest.migration_version<>current_migration_version
     or manifest.schema_version<>current_migration_version then
    raise exception 'BACKUP_STALE' using errcode='55000';
  end if;
  update public.database_destruction_operations
  set status='cancelled',cancelled_at=clock_timestamp(),failure_code='SUPERSEDED'
  where created_by=input_actor_id and status in ('pending','backup_verified','armed');
  insert into public.database_destruction_operations(
    created_by,backup_manifest_id,status,challenge_hash,challenge_expires_at,
    session_binding_hash,not_before,reauthenticated_at,reauth_expires_at,backup_sha256,
    data_version,storage_version,catalog_version,schema_inventory_hash,evidence_hash,
    ip_hash,armed_at,storage_status
  ) values (
    input_actor_id,manifest.id,'armed',input_challenge_hash,clock_timestamp()+interval '5 minutes',
    input_session_binding_hash,clock_timestamp()+interval '30 seconds',clock_timestamp(),clock_timestamp()+interval '5 minutes',
    manifest.sha256,manifest.data_version,manifest.storage_version,manifest.catalog_version,
    manifest.schema_inventory_hash,manifest.evidence_hash,input_ip_hash,clock_timestamp(),'pending'
  ) returning * into operation;
  insert into public.database_safety_audit_events(
    operation_id,backup_manifest_id,actor_id,event_type,status,ip_hash,manifest_hash,catalog_version,data_version,storage_scope
  ) values (
    operation.id,manifest.id,input_actor_id,'destruction_armed','completed',input_ip_hash,
    manifest.evidence_hash,manifest.catalog_version,manifest.data_version,manifest.backup_scope->'storage'
  );
  return operation;
end;
$$;

create or replace function public.execute_database_business_purge_v2(
  input_actor_id uuid,
  input_operation_id uuid,
  input_challenge_hash text,
  input_session_binding_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  operation public.database_destruction_operations;
  manifest public.database_backup_manifests;
  state public.database_safety_state;
  current_data_version bigint;
  current_storage_version bigint;
  preflight jsonb;
  item record;
  before_counts jsonb;
  after_counts jsonb;
  affected text[];
  response jsonb;
  current_migration_version text:='unknown';
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  if not exists(select 1 from public.database_safety_state where singleton and delete_enabled) then
    raise exception 'DELETE_KILL_SWITCH_DISABLED' using errcode='55000';
  end if;
  select * into operation from public.database_destruction_operations
  where id=input_operation_id and created_by=input_actor_id for update;
  if operation.id is null then raise exception 'OPERATION_NOT_FOUND' using errcode='P0002'; end if;
  if operation.status in ('database_completed','completed') then
    if operation.challenge_hash<>input_challenge_hash then raise exception 'CHALLENGE_INVALID' using errcode='42501'; end if;
    if operation.session_binding_hash<>input_session_binding_hash then raise exception 'SESSION_CHANGED' using errcode='42501'; end if;
    return operation.result;
  end if;
  if operation.status<>'armed' then raise exception 'OPERATION_NOT_ARMED' using errcode='55000'; end if;
  if operation.challenge_used_at is not null then raise exception 'CHALLENGE_ALREADY_USED' using errcode='55000'; end if;
  if operation.challenge_expires_at<=clock_timestamp() then raise exception 'CHALLENGE_EXPIRED' using errcode='55000'; end if;
  if operation.reauth_expires_at is null or operation.reauth_expires_at<=clock_timestamp() then raise exception 'REAUTH_EXPIRED' using errcode='55000'; end if;
  if operation.not_before>clock_timestamp() then raise exception 'COUNTDOWN_ACTIVE' using errcode='55000'; end if;
  if operation.challenge_hash<>input_challenge_hash then raise exception 'CHALLENGE_INVALID' using errcode='42501'; end if;
  if operation.session_binding_hash<>input_session_binding_hash then raise exception 'SESSION_CHANGED' using errcode='42501'; end if;
  select * into manifest from public.database_backup_manifests
  where id=operation.backup_manifest_id and created_by=input_actor_id for update;
  if manifest.id is null or manifest.status<>'verified' or manifest.evidence_hash<>operation.evidence_hash
     or manifest.downloaded_at is null or manifest.expires_at<=clock_timestamp() then
    raise exception 'BACKUP_NOT_VERIFIED' using errcode='55000';
  end if;
  preflight:=public.database_safety_catalog_preflight_v2();
  select versions.data_version,versions.storage_version
  into current_data_version,current_storage_version
  from public.database_safety_current_watermarks_v3() versions;
  begin
    select coalesce(max(version)::text, 'unknown') into current_migration_version
    from supabase_migrations.schema_migrations;
  exception when others then current_migration_version:='unknown'; end;
  if not (preflight->>'classified')::boolean then
    raise exception 'CATALOG_UNCLASSIFIED' using errcode='55000';
  end if;
  if manifest.data_version<>current_data_version or operation.data_version<>current_data_version
     or manifest.storage_version<>current_storage_version or operation.storage_version<>current_storage_version
     or manifest.catalog_version<>preflight->>'catalogVersion'
     or operation.catalog_version<>preflight->>'catalogVersion'
     or manifest.schema_inventory_hash<>preflight->>'schemaInventoryHash'
     or manifest.migration_version<>current_migration_version
     or manifest.schema_version<>current_migration_version then
    raise exception 'BACKUP_STALE' using errcode='55000';
  end if;

  -- Preserve R3's deterministic table-lock ordering. Once the tables and
  -- Storage are fenced, take the exclusive advisory boundary and re-read both
  -- sequences before allowing any destructive statement.
  for item in
    select * from public.database_safety_table_catalog_v2()
    where schema_name='public' and planned_action='DELETE'
    order by schema_name,table_name
  loop
    execute format('lock table %I.%I in share row exclusive mode',item.schema_name,item.table_name);
  end loop;
  if to_regclass('storage.objects') is not null then
    lock table storage.objects in share row exclusive mode;
  end if;
  select * into state from public.database_safety_state where singleton for update;
  if not state.delete_enabled then
    raise exception 'DELETE_KILL_SWITCH_DISABLED' using errcode='55000';
  end if;
  select versions.data_version,versions.storage_version
  into current_data_version,current_storage_version
  from public.database_safety_capture_watermarks_v3() versions;
  if manifest.data_version<>current_data_version or operation.data_version<>current_data_version
     or manifest.storage_version<>current_storage_version or operation.storage_version<>current_storage_version then
    raise exception 'BACKUP_STALE' using errcode='55000';
  end if;

  before_counts:=public.database_safety_counts_v2('DELETE');
  select array_agg(format('%I.%I',schema_name,table_name) order by delete_order,table_name)
  into affected from public.database_safety_table_catalog_v2()
  where schema_name='public' and planned_action='DELETE';
  update public.database_destruction_operations
  set status='executing',challenge_used_at=clock_timestamp(),executing_at=clock_timestamp(),
      counts_before=before_counts,affected_tables=affected
  where id=operation.id;
  for item in
    select * from public.database_safety_table_catalog_v2()
    where schema_name='public' and planned_action='DELETE'
    order by delete_order,table_name
  loop
    execute format('delete from %I.%I',item.schema_name,item.table_name);
    if current_setting('quiksol.database_safety_fail_after_table',true)=item.table_name then
      raise exception 'INJECTED_DELETE_FAILURE' using errcode='P0001';
    end if;
  end loop;
  after_counts:=public.database_safety_counts_v2('DELETE');
  response:=jsonb_build_object(
    'operationId',operation.id,'status','database_completed','countsBefore',before_counts,
    'countsAfter',after_counts,'affectedTables',affected,'storageStatus','pending','completedAt',clock_timestamp()
  );
  update public.database_destruction_operations
  set status='database_completed',counts_after=after_counts,result=response,storage_status='pending'
  where id=operation.id;
  insert into public.database_safety_audit_events(
    operation_id,backup_manifest_id,actor_id,event_type,status,ip_hash,table_counts,
    counts_after,affected_tables,manifest_hash,catalog_version,data_version,storage_scope
  ) values (
    operation.id,manifest.id,input_actor_id,'business_database_deleted','completed',operation.ip_hash,
    before_counts,after_counts,affected,manifest.evidence_hash,manifest.catalog_version,
    manifest.data_version,manifest.backup_scope->'storage'
  );
  return response;
end;
$$;

-- Rebuild the exact trigger set from the runtime catalog. Public DELETE tables
-- remain statement-level; PRESERVE tables never stale a business backup.
do $$
declare
  item record;
begin
  for item in
    select * from public.database_safety_table_catalog_v2()
    where schema_name='public'
    order by schema_name,table_name
  loop
    if to_regclass(format('%I.%I',item.schema_name,item.table_name)) is null then
      raise exception 'DATABASE_SAFETY_CATALOG_TABLE_MISSING:%',format('%I.%I',item.schema_name,item.table_name)
        using errcode='55000';
    end if;
    execute format('drop trigger if exists database_safety_watermark on %I.%I',item.schema_name,item.table_name);
    if item.planned_action='DELETE' then
      execute format(
        'create trigger database_safety_watermark after insert or update or delete or truncate on %I.%I for each statement execute function public.touch_database_safety_watermark()',
        item.schema_name,item.table_name
      );
    end if;
  end loop;
end;
$$;

do $$
begin
  if exists(
    select 1 from information_schema.columns
    where table_schema='storage' and table_name='objects' and column_name='bucket_id'
  ) then
    execute 'drop trigger if exists database_safety_storage_watermark_v2 on storage.objects';
    execute 'create trigger database_safety_storage_watermark_v2 after insert or update or delete on storage.objects for each row execute function public.touch_database_safety_storage_watermark_v2()';
  end if;
end;
$$;

-- Trigger/sequence helpers are owner-only. Existing PostgREST-facing v2
-- signatures remain backend-only; legacy destructive contracts stay disabled.
revoke all on function public.database_safety_watermark_lock_key_v3() from public,anon,authenticated,service_role;
revoke all on function public.database_safety_current_watermarks_v3() from public,anon,authenticated,service_role;
revoke all on function public.database_safety_capture_watermarks_v3() from public,anon,authenticated,service_role;
revoke all on function public.touch_database_safety_watermark() from public,anon,authenticated,service_role;
revoke all on function public.touch_database_safety_storage_watermark_v2() from public,anon,authenticated,service_role;

revoke all on function public.database_safety_table_catalog_v2() from public,anon,authenticated,service_role;
revoke all on function public.database_safety_storage_catalog_v2() from public,anon,authenticated,service_role;
revoke all on function public.database_safety_catalog_version_v2() from public,anon,authenticated,service_role;
revoke all on function public.assert_database_safety_backend_actor_v2(uuid) from public,anon,authenticated,service_role;
revoke all on function public.database_safety_catalog_preflight_v2() from public,anon,authenticated,service_role;
revoke all on function public.database_safety_counts_v2(text) from public,anon,authenticated,service_role;
revoke all on function public.database_safety_current_snapshot_v2(uuid) from public,anon,authenticated,service_role;
revoke all on function public.database_safety_dry_run_v2(uuid) from public,anon,authenticated,service_role;
revoke all on function public.begin_database_backup_manifest_v2(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.record_database_backup_created_v2(uuid,uuid,text,bigint,text,text,text,text,bigint,integer,text,bigint,bigint,text[],text) from public,anon,authenticated,service_role;
revoke all on function public.verify_database_backup_manifest_v2(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.fail_database_backup_manifest_v2(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.mark_database_backup_downloaded_v2(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.arm_database_destruction_v2(uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.cancel_database_destruction_v2(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fail_database_destruction_v2(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.execute_database_business_purge_v2(uuid,uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function public.claim_database_storage_cleanup_v2(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.finish_database_storage_cleanup_v2(uuid,uuid,boolean,integer,text) from public,anon,authenticated,service_role;

grant execute on function public.database_safety_table_catalog_v2() to service_role;
grant execute on function public.database_safety_storage_catalog_v2() to service_role;
grant execute on function public.database_safety_catalog_version_v2() to service_role;
grant execute on function public.assert_database_safety_backend_actor_v2(uuid) to service_role;
grant execute on function public.database_safety_catalog_preflight_v2() to service_role;
grant execute on function public.database_safety_counts_v2(text) to service_role;
grant execute on function public.database_safety_current_snapshot_v2(uuid) to service_role;
grant execute on function public.database_safety_dry_run_v2(uuid) to service_role;
grant execute on function public.begin_database_backup_manifest_v2(uuid,text) to service_role;
grant execute on function public.record_database_backup_created_v2(uuid,uuid,text,bigint,text,text,text,text,bigint,integer,text,bigint,bigint,text[],text) to service_role;
grant execute on function public.verify_database_backup_manifest_v2(uuid,uuid,text) to service_role;
grant execute on function public.fail_database_backup_manifest_v2(uuid,uuid,text) to service_role;
grant execute on function public.mark_database_backup_downloaded_v2(uuid,uuid,text) to service_role;
grant execute on function public.arm_database_destruction_v2(uuid,uuid,text,text,text) to service_role;
grant execute on function public.cancel_database_destruction_v2(uuid,uuid) to service_role;
grant execute on function public.fail_database_destruction_v2(uuid,uuid,text) to service_role;
grant execute on function public.execute_database_business_purge_v2(uuid,uuid,text,text) to service_role;
grant execute on function public.claim_database_storage_cleanup_v2(uuid,uuid) to service_role;
grant execute on function public.finish_database_storage_cleanup_v2(uuid,uuid,boolean,integer,text) to service_role;

revoke all on function public.database_safety_current_snapshot() from public,anon,authenticated,service_role;
revoke all on function public.database_safety_dry_run() from public,anon,authenticated,service_role;
revoke all on function public.register_database_backup_manifest(text,text,bigint,integer,text,text,text,bigint,boolean) from public,anon,authenticated,service_role;
revoke all on function public.mark_database_backup_downloaded(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.arm_database_destruction(uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.cancel_database_destruction(uuid) from public,anon,authenticated,service_role;
revoke all on function public.fail_database_destruction(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.execute_database_business_purge(uuid,text,text) from public,anon,authenticated,service_role;

comment on sequence public.database_safety_data_version_seq is
  'R7 non-transactional monotonic business-data watermark; gaps after rollback are fail-closed.';
comment on sequence public.database_safety_storage_version_seq is
  'R7 non-transactional monotonic business-Storage watermark; gaps after rollback are fail-closed.';
comment on column public.database_safety_state.data_version is
  'R7 initialization baseline only; authoritative value is database_safety_data_version_seq.';
comment on column public.database_safety_state.storage_version is
  'R7 initialization baseline only; authoritative value is database_safety_storage_version_seq.';

reset lock_timeout;
commit;
