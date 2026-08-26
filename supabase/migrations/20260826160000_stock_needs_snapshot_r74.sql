-- R7.4: persistent, versioned Stock Needs snapshots.
--
-- This migration is additive. It preserves get_stock_needs_page_v1, queues
-- snapshot scopes without rebuilding them inline, and exposes all mutation of
-- private snapshot state through fenced service-role RPCs.

begin;

create table public.business_stock_needs_scopes (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('company', 'team', 'owner', 'upload')),
  scope_key text not null unique,
  owner_id uuid references public.profiles(id) on delete cascade,
  upload_batch_id uuid references public.upload_batches(id) on delete cascade,
  department text,
  region text,
  enabled boolean not null default true,
  required_version bigint not null default 1 check (required_version > 0),
  published_version bigint check (published_version is null or published_version > 0),
  active_data_scope_id uuid,
  active_generation bigint check (active_generation is null or active_generation > 0),
  retained_generations bigint[] not null default '{}'::bigint[]
    check (cardinality(retained_generations) <= 2),
  snapshot_status text not null default 'queued'
    check (snapshot_status in ('dirty', 'queued', 'rebuilding', 'retrying', 'ready', 'failed')),
  build_id uuid,
  build_required_version bigint check (build_required_version is null or build_required_version > 0),
  build_generation bigint not null default 0 check (build_generation >= 0),
  build_fence_token bigint not null default 0 check (build_fence_token >= 0),
  build_locked_by text,
  build_lease_expires_at timestamptz,
  build_heartbeat_at timestamptz,
  build_next_retry_at timestamptz,
  build_attempts integer not null default 0,
  build_max_attempts integer not null default 8 check (build_max_attempts between 1 and 32),
  build_evaluation_at timestamptz,
  build_source_fingerprint text,
  build_source_watermark timestamptz,
  build_cursor_mpn text,
  build_last_chunk_sequence integer not null default -1 check (build_last_chunk_sequence >= -1),
  build_last_chunk_result jsonb,
  build_rows_built bigint not null default 0 check (build_rows_built >= 0),
  build_sources_built bigint not null default 0 check (build_sources_built >= 0),
  build_peak_chunk_rows integer not null default 0 check (build_peak_chunk_rows >= 0),
  build_peak_payload_bytes bigint not null default 0 check (build_peak_payload_bytes >= 0),
  build_in_stock bigint not null default 0 check (build_in_stock >= 0),
  build_partial_stock bigint not null default 0 check (build_partial_stock >= 0),
  build_no_stock bigint not null default 0 check (build_no_stock >= 0),
  build_overstock bigint not null default 0 check (build_overstock >= 0),
  build_unknown bigint not null default 0 check (build_unknown >= 0),
  build_total_required_qty numeric not null default 0,
  build_total_stock_qty numeric not null default 0,
  build_has_missing_profiles boolean not null default false,
  total_items bigint not null default 0 check (total_items >= 0),
  total_in_stock bigint not null default 0 check (total_in_stock >= 0),
  total_partial_stock bigint not null default 0 check (total_partial_stock >= 0),
  total_no_stock bigint not null default 0 check (total_no_stock >= 0),
  total_overstock bigint not null default 0 check (total_overstock >= 0),
  total_unknown bigint not null default 0 check (total_unknown >= 0),
  total_required_qty numeric not null default 0,
  total_stock_qty numeric not null default 0,
  has_missing_profiles boolean not null default false,
  published_source_fingerprint text,
  published_source_watermark timestamptz,
  published_at timestamptz,
  last_published_build_id uuid,
  last_published_generation bigint,
  last_published_fence_token bigint,
  last_published_result jsonb,
  last_failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope_type = 'company' and owner_id is null and upload_batch_id is null and department is null and region is null)
    or (scope_type = 'team' and owner_id is null and upload_batch_id is null and (department is not null or region is not null))
    or (scope_type = 'owner' and owner_id is not null and upload_batch_id is null and department is null and region is null)
    or (scope_type = 'upload' and owner_id is null and upload_batch_id is not null and department is null and region is null)
  ),
  check (build_source_fingerprint is null or build_source_fingerprint ~ '^[0-9a-f]{64}$'),
  check (published_source_fingerprint is null or published_source_fingerprint ~ '^[0-9a-f]{64}$')
);

alter table public.business_stock_needs_scopes
  add constraint business_stock_needs_scopes_active_data_scope_fk
  foreign key (active_data_scope_id) references public.business_stock_needs_scopes(id) on delete set null;

create table public.business_stock_needs_snapshot_rows (
  data_scope_id uuid not null references public.business_stock_needs_scopes(id) on delete cascade,
  generation bigint not null check (generation > 0),
  chunk_sequence integer not null check (chunk_sequence >= 0),
  normalized_mpn text not null,
  display_mpn text not null,
  customer_name text,
  supplier_name text,
  manufacturer_name text,
  demand_qty numeric,
  stock_qty numeric,
  shortage_qty numeric not null,
  coverage_status text not null check (coverage_status in ('in_stock', 'partial_stock', 'no_stock', 'overstock', 'unknown')),
  coverage_rank smallint not null check (coverage_rank between 0 and 4),
  coverage_ordinal bigint not null check (coverage_ordinal > 0),
  required_date text,
  lead_time text,
  import_statuses text[] not null default '{}',
  missing_profile boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (data_scope_id, generation, normalized_mpn)
);

create table public.business_stock_needs_snapshot_sources (
  data_scope_id uuid not null,
  generation bigint not null,
  normalized_mpn text not null,
  source_rank smallint not null check (source_rank between 1 and 5),
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  file_name text not null,
  detected_template text,
  import_status text not null,
  upload_created_at timestamptz not null,
  primary key (data_scope_id, generation, normalized_mpn, source_rank),
  unique (data_scope_id, generation, normalized_mpn, upload_batch_id),
  foreign key (data_scope_id, generation, normalized_mpn)
    references public.business_stock_needs_snapshot_rows(data_scope_id, generation, normalized_mpn)
    on delete cascade
);

create index business_stock_needs_scopes_claim_idx
  on public.business_stock_needs_scopes
  (snapshot_status, build_next_retry_at, updated_at, id)
  where enabled;
create index business_stock_needs_snapshot_default_page_idx
  on public.business_stock_needs_snapshot_rows
  (data_scope_id, generation, coverage_rank, coverage_ordinal)
  include (
    normalized_mpn, display_mpn, customer_name, supplier_name,
    manufacturer_name, demand_qty, stock_qty, shortage_qty,
    coverage_status, required_date, lead_time, missing_profile
  );
create index business_stock_needs_snapshot_mpn_trgm_idx
  on public.business_stock_needs_snapshot_rows using gin (normalized_mpn gin_trgm_ops);
create index business_stock_needs_snapshot_customer_trgm_idx
  on public.business_stock_needs_snapshot_rows using gin (customer_name gin_trgm_ops)
  where customer_name is not null;
create index business_stock_needs_snapshot_supplier_trgm_idx
  on public.business_stock_needs_snapshot_rows using gin (supplier_name gin_trgm_ops)
  where supplier_name is not null;
create index business_stock_needs_snapshot_manufacturer_trgm_idx
  on public.business_stock_needs_snapshot_rows using gin (manufacturer_name gin_trgm_ops)
  where manufacturer_name is not null;
create index business_stock_needs_snapshot_statuses_idx
  on public.business_stock_needs_snapshot_rows using gin (import_statuses);
create index business_stock_needs_snapshot_sources_page_idx
  on public.business_stock_needs_snapshot_sources
  (data_scope_id, generation, normalized_mpn, source_rank);

alter table public.business_stock_needs_scopes enable row level security;
alter table public.business_stock_needs_scopes force row level security;
alter table public.business_stock_needs_snapshot_rows enable row level security;
alter table public.business_stock_needs_snapshot_rows force row level security;
alter table public.business_stock_needs_snapshot_sources enable row level security;
alter table public.business_stock_needs_snapshot_sources force row level security;

revoke all on table public.business_stock_needs_scopes from public, anon, authenticated, service_role;
revoke all on table public.business_stock_needs_snapshot_rows from public, anon, authenticated, service_role;
revoke all on table public.business_stock_needs_snapshot_sources from public, anon, authenticated, service_role;

create or replace function public.stock_needs_team_scope_key_v1(input_department text, input_region text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $$
  select 'team:' || encode(extensions.digest(
    convert_to(coalesce(input_department, '') || chr(31) || coalesce(input_region, ''), 'UTF8'),
    'sha256'
  ), 'hex');
$$;

create or replace function public.ensure_stock_needs_scopes_v1()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.business_stock_needs_scopes(scope_type, scope_key)
  values ('company', 'company')
  on conflict (scope_key) do update set enabled = true, updated_at = clock_timestamp();

  insert into public.business_stock_needs_scopes(scope_type, scope_key, owner_id)
  select 'owner', 'owner:' || profile.id::text, profile.id
  from public.profiles profile
  where profile.is_active
  on conflict (scope_key) do update
    set owner_id = excluded.owner_id, enabled = true, updated_at = clock_timestamp();

  insert into public.business_stock_needs_scopes(scope_type, scope_key, department, region)
  select distinct 'team', public.stock_needs_team_scope_key_v1(profile.department, profile.region),
    profile.department, profile.region
  from public.profiles profile
  where profile.is_active and profile.role = 'manager'
    and (profile.department is not null or profile.region is not null)
  on conflict (scope_key) do update
    set department = excluded.department, region = excluded.region,
        enabled = true, updated_at = clock_timestamp();

  insert into public.business_stock_needs_scopes(scope_type, scope_key, upload_batch_id)
  select 'upload', 'upload:' || upload.id::text, upload.id
  from public.upload_batches upload
  where upload.archived_at is null
    and upload.status in ('completed', 'completed_with_warnings')
  on conflict (scope_key) do update
    set upload_batch_id = excluded.upload_batch_id, enabled = true,
        updated_at = clock_timestamp();

  update public.business_stock_needs_scopes scope
  set enabled = case scope.scope_type
      when 'company' then true
      when 'owner' then exists (
        select 1 from public.profiles profile
        where profile.id = scope.owner_id and profile.is_active
      )
      when 'team' then exists (
        select 1 from public.profiles profile
        where profile.is_active and profile.role = 'manager'
          and profile.department is not distinct from scope.department
          and profile.region is not distinct from scope.region
      )
      when 'upload' then exists (
        select 1 from public.upload_batches upload
        where upload.id = scope.upload_batch_id
          and upload.archived_at is null
          and upload.status in ('completed', 'completed_with_warnings')
      )
    end,
    updated_at = clock_timestamp();
end;
$$;

create or replace function public.stock_needs_scope_uploads_v1(input_scope_id uuid)
returns table(
  upload_batch_id uuid,
  owner_id uuid,
  original_file_name text,
  detected_category text,
  import_status text,
  upload_created_at timestamptz,
  detected_template text,
  missing_profile boolean,
  data_version bigint,
  summary_version bigint,
  dirty boolean,
  rebuild_status text,
  rebuilt_at timestamptz,
  version_updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    upload.id, upload.uploaded_by, upload.original_file_name,
    upload.detected_category, upload.status, upload.created_at,
    profile.detected_template, profile.upload_batch_id is null,
    version.data_version, version.summary_version, version.dirty,
    version.rebuild_status, version.rebuilt_at, version.updated_at
  from public.business_stock_needs_scopes scope
  join public.upload_batches upload on upload.archived_at is null
    and upload.status in ('completed', 'completed_with_warnings')
  left join public.business_upload_versions version on version.upload_batch_id = upload.id
  left join public.file_schema_profiles profile on profile.upload_batch_id = upload.id
  left join public.profiles target on target.id = upload.uploaded_by
  where scope.id = input_scope_id and scope.enabled
    and case scope.scope_type
      when 'company' then true
      when 'owner' then upload.uploaded_by = scope.owner_id
      when 'upload' then upload.id = scope.upload_batch_id
      when 'team' then
        (scope.department is not null and target.department = scope.department)
        or (scope.region is not null and target.region = scope.region)
      else false
    end;
$$;

create or replace function public.stock_needs_scope_source_state_v1(input_scope_id uuid)
returns table(
  source_ready boolean,
  has_failed boolean,
  source_count bigint,
  source_fingerprint text,
  source_watermark timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with source as materialized (
    select * from public.stock_needs_scope_uploads_v1(input_scope_id)
  )
  select
    count(*) filter (
      where data_version is null or dirty is distinct from false
        or summary_version is distinct from data_version
        or rebuild_status is distinct from 'ready'
    ) = 0,
    coalesce(bool_or(rebuild_status = 'failed'), false),
    count(*)::bigint,
    encode(extensions.digest(convert_to(coalesce(string_agg(
      concat_ws(chr(31), upload_batch_id::text, owner_id::text,
        data_version::text, summary_version::text, dirty::text,
        original_file_name, detected_category, import_status,
        upload_created_at::text, coalesce(detected_template, ''), missing_profile::text)
      , chr(30) order by upload_batch_id), ''), 'UTF8'), 'sha256'), 'hex'),
    max(coalesce(rebuilt_at, version_updated_at))
  from source;
$$;

create or replace function public.queue_stock_needs_snapshots_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected_owner uuid;
  affected_upload uuid;
begin
  perform public.ensure_stock_needs_scopes_v1();

  if tg_table_name = 'profiles' then
    update public.business_stock_needs_scopes scope
    set required_version = scope.required_version + 1,
        snapshot_status = 'queued', build_id = null,
        build_fence_token = scope.build_fence_token + 1,
        build_locked_by = null, build_lease_expires_at = null,
        build_next_retry_at = null, build_attempts = 0,
        last_failure_code = null, updated_at = clock_timestamp()
    where scope.enabled;
  else
    if tg_table_name = 'business_upload_versions' then
      affected_owner := case when tg_op = 'DELETE' then old.owner_id else new.owner_id end;
      affected_upload := case when tg_op = 'DELETE' then old.upload_batch_id else new.upload_batch_id end;
    elsif tg_table_name = 'upload_batches' then
      affected_owner := case when tg_op = 'DELETE' then old.uploaded_by else new.uploaded_by end;
      affected_upload := case when tg_op = 'DELETE' then old.id else new.id end;
    elsif tg_table_name = 'file_schema_profiles' then
      affected_upload := case when tg_op = 'DELETE' then old.upload_batch_id else new.upload_batch_id end;
      select upload.uploaded_by into affected_owner
      from public.upload_batches upload where upload.id = affected_upload;
    end if;

    update public.business_stock_needs_scopes scope
    set required_version = scope.required_version + 1,
        snapshot_status = 'queued', build_id = null,
        build_fence_token = scope.build_fence_token + 1,
        build_locked_by = null, build_lease_expires_at = null,
        build_next_retry_at = null, build_attempts = 0,
        last_failure_code = null, updated_at = clock_timestamp()
    where scope.enabled and (
      scope.scope_type = 'company'
      or (scope.scope_type = 'owner' and scope.owner_id = affected_owner)
      or (scope.scope_type = 'upload' and scope.upload_batch_id = affected_upload)
      or (scope.scope_type = 'team' and exists (
        select 1 from public.profiles target
        where target.id = affected_owner and (
          (scope.department is not null and target.department = scope.department)
          or (scope.region is not null and target.region = scope.region)
        )
      ))
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger business_stock_needs_version_queue_v1
after insert or delete or update of owner_id, data_version, summary_version, dirty, rebuild_status
on public.business_upload_versions
for each row execute function public.queue_stock_needs_snapshots_v1();
create trigger business_stock_needs_upload_queue_v1
after insert or delete or update of uploaded_by, original_file_name, detected_category, status, archived_at, created_at
on public.upload_batches
for each row execute function public.queue_stock_needs_snapshots_v1();
create trigger business_stock_needs_profile_queue_v1
after insert or delete or update of role, is_active, department, region
on public.profiles
for each row execute function public.queue_stock_needs_snapshots_v1();
create trigger business_stock_needs_profile_metadata_queue_v1
after insert or delete or update of detected_template
on public.file_schema_profiles
for each row execute function public.queue_stock_needs_snapshots_v1();

select public.ensure_stock_needs_scopes_v1();

create or replace function public.claim_stock_needs_snapshot_rebuild_v1(
  input_worker_id text,
  input_lease_seconds integer default 120
)
returns table(
  scope_id uuid,
  rebuild_id uuid,
  build_generation bigint,
  fence_token bigint,
  lease_expires_at timestamptz,
  evaluation_at timestamptz,
  next_chunk_sequence integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  candidate public.business_stock_needs_scopes%rowtype;
  source_state record;
  now_value timestamptz := clock_timestamp();
  lease_seconds integer := least(greatest(coalesce(input_lease_seconds, 120), 30), 900);
  next_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'STOCK_SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;
  if input_worker_id is null or length(input_worker_id) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'STOCK_SNAPSHOT_WORKER_ID_INVALID';
  end if;

  update public.business_stock_needs_scopes scope
  set snapshot_status = 'failed', build_id = null,
      build_fence_token = scope.build_fence_token + 1,
      build_locked_by = null, build_lease_expires_at = null,
      build_next_retry_at = null,
      last_failure_code = 'STOCK_SNAPSHOT_LEASE_EXPIRED_MAX_ATTEMPTS',
      updated_at = now_value
  where scope.id in (
    select terminal.id
    from public.business_stock_needs_scopes terminal
    where terminal.enabled and terminal.snapshot_status = 'rebuilding'
      and coalesce(terminal.build_lease_expires_at, '-infinity'::timestamptz) <= now_value
      and terminal.build_attempts >= terminal.build_max_attempts
    order by terminal.updated_at, terminal.id
    for update skip locked limit 100
  );

  -- Equivalent visibility sets reuse one immutable published generation. The
  -- source fingerprint includes the complete authorized upload/version and
  -- public metadata manifest, so this never broadens a caller's scope.
  with reusable as (
    select queued_scope.id,
      donor.active_data_scope_id, donor.active_generation,
      donor.total_items, donor.total_in_stock, donor.total_partial_stock,
      donor.total_no_stock, donor.total_overstock, donor.total_unknown,
      donor.total_required_qty, donor.total_stock_qty,
      donor.has_missing_profiles, donor.published_source_watermark,
      source.source_fingerprint
    from public.business_stock_needs_scopes queued_scope
    cross join lateral public.stock_needs_scope_source_state_v1(queued_scope.id) source
    join lateral (
      select ready.*
      from public.business_stock_needs_scopes ready
      where ready.id <> queued_scope.id and ready.enabled
        and ready.snapshot_status = 'ready'
        and ready.published_version = ready.required_version
        and ready.published_source_fingerprint = source.source_fingerprint
        and ready.active_data_scope_id is not null
        and ready.active_generation is not null
      order by ready.published_at desc nulls last, ready.id
      limit 1
    ) donor on true
    where queued_scope.enabled and source.source_ready
      and queued_scope.snapshot_status in ('queued', 'retrying')
    order by queued_scope.updated_at, queued_scope.id
    limit 100
  )
  update public.business_stock_needs_scopes reused_scope
  set snapshot_status = 'ready', published_version = reused_scope.required_version,
      active_data_scope_id = reusable.active_data_scope_id,
      active_generation = reusable.active_generation,
      total_items = reusable.total_items,
      total_in_stock = reusable.total_in_stock,
      total_partial_stock = reusable.total_partial_stock,
      total_no_stock = reusable.total_no_stock,
      total_overstock = reusable.total_overstock,
      total_unknown = reusable.total_unknown,
      total_required_qty = reusable.total_required_qty,
      total_stock_qty = reusable.total_stock_qty,
      has_missing_profiles = reusable.has_missing_profiles,
      published_source_fingerprint = reusable.source_fingerprint,
      published_source_watermark = reusable.published_source_watermark,
      published_at = now_value, build_id = null,
      build_locked_by = null, build_lease_expires_at = null,
      build_next_retry_at = null, build_attempts = 0,
      last_failure_code = null, updated_at = now_value
  from reusable where reused_scope.id = reusable.id;

  select scope.* into candidate
  from public.business_stock_needs_scopes scope
  cross join lateral public.stock_needs_scope_source_state_v1(scope.id) source
  where scope.enabled and source.source_ready
    and (
      scope.snapshot_status = 'queued'
      or (scope.snapshot_status = 'retrying'
        and coalesce(scope.build_next_retry_at, '-infinity'::timestamptz) <= now_value)
      or (scope.snapshot_status = 'rebuilding'
        and coalesce(scope.build_lease_expires_at, '-infinity'::timestamptz) <= now_value
        and scope.build_attempts < scope.build_max_attempts)
    )
  order by scope.updated_at, scope.id
  for update of scope skip locked
  limit 1;

  if not found then return; end if;
  select * into source_state from public.stock_needs_scope_source_state_v1(candidate.id);

  if candidate.snapshot_status in ('rebuilding', 'retrying')
     and candidate.build_required_version = candidate.required_version
     and candidate.build_source_fingerprint = source_state.source_fingerprint
     and candidate.build_id is not null then
    update public.business_stock_needs_scopes scope
    set snapshot_status = 'rebuilding',
        build_fence_token = scope.build_fence_token + 1,
        build_locked_by = input_worker_id,
        build_lease_expires_at = now_value + make_interval(secs => lease_seconds),
        build_heartbeat_at = now_value,
        build_next_retry_at = null,
        build_attempts = scope.build_attempts + 1,
        updated_at = now_value
    where scope.id = candidate.id
    returning scope.id, scope.build_id, scope.build_generation,
      scope.build_fence_token, scope.build_lease_expires_at,
      scope.build_evaluation_at, scope.build_last_chunk_sequence + 1
    into scope_id, rebuild_id, build_generation, fence_token,
      lease_expires_at, evaluation_at, next_chunk_sequence;
    return next;
    return;
  end if;

  next_id := gen_random_uuid();
  update public.business_stock_needs_scopes scope
  set snapshot_status = 'rebuilding', build_id = next_id,
      build_required_version = scope.required_version,
      build_generation = scope.build_generation + 1,
      build_fence_token = scope.build_fence_token + 1,
      build_locked_by = input_worker_id,
      build_lease_expires_at = now_value + make_interval(secs => lease_seconds),
      build_heartbeat_at = now_value, build_next_retry_at = null,
      build_attempts = 1, build_evaluation_at = now_value,
      build_source_fingerprint = source_state.source_fingerprint,
      build_source_watermark = source_state.source_watermark,
      build_cursor_mpn = null, build_last_chunk_sequence = -1,
      build_last_chunk_result = null, build_rows_built = 0,
      build_sources_built = 0, build_peak_chunk_rows = 0,
      build_peak_payload_bytes = 0, build_in_stock = 0,
      build_partial_stock = 0, build_no_stock = 0,
      build_overstock = 0, build_unknown = 0,
      build_total_required_qty = 0, build_total_stock_qty = 0,
      build_has_missing_profiles = false, last_failure_code = null,
      updated_at = now_value
  where scope.id = candidate.id
  returning scope.id, scope.build_id, scope.build_generation,
    scope.build_fence_token, scope.build_lease_expires_at,
    scope.build_evaluation_at, 0
  into scope_id, rebuild_id, build_generation, fence_token,
    lease_expires_at, evaluation_at, next_chunk_sequence;
  return next;
end;
$$;

create or replace function public.heartbeat_stock_needs_snapshot_rebuild_v1(
  input_scope_id uuid,
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
    raise exception using errcode = '42501', message = 'STOCK_SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;
  update public.business_stock_needs_scopes scope
  set build_heartbeat_at = now_value,
      build_lease_expires_at = now_value + make_interval(secs => lease_seconds),
      updated_at = now_value
  where scope.id = input_scope_id and scope.snapshot_status = 'rebuilding'
    and scope.build_locked_by = input_worker_id and scope.build_id = input_rebuild_id
    and scope.build_generation = input_generation
    and scope.build_fence_token = input_fence_token
    and scope.build_required_version = scope.required_version
    and scope.build_lease_expires_at > now_value
  returning scope.build_lease_expires_at into next_expiry;
  if next_expiry is null then
    raise exception using errcode = '55000', message = 'STOCK_SNAPSHOT_WORKER_FENCED';
  end if;
  return next_expiry;
end;
$$;

create or replace function public.stage_stock_needs_snapshot_chunk_v1(
  input_scope_id uuid,
  input_worker_id text,
  input_rebuild_id uuid,
  input_generation bigint,
  input_fence_token bigint,
  input_chunk_sequence integer,
  input_limit integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_scope public.business_stock_needs_scopes%rowtype;
  chunk_limit integer := least(greatest(coalesce(input_limit, 1000), 1), 2000);
  inserted_rows integer := 0;
  inserted_sources integer := 0;
  chunk_cursor text;
  chunk_bytes bigint := 0;
  count_in_stock bigint := 0;
  count_partial bigint := 0;
  count_no_stock bigint := 0;
  count_overstock bigint := 0;
  count_unknown bigint := 0;
  chunk_required numeric := 0;
  chunk_stock numeric := 0;
  chunk_missing boolean := false;
  result jsonb;
  now_value timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'STOCK_SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;
  select scope.* into locked_scope
  from public.business_stock_needs_scopes scope
  where scope.id = input_scope_id for update;
  if not found or locked_scope.snapshot_status <> 'rebuilding'
     or locked_scope.build_locked_by is distinct from input_worker_id
     or locked_scope.build_id is distinct from input_rebuild_id
     or locked_scope.build_generation <> input_generation
     or locked_scope.build_fence_token <> input_fence_token
     or locked_scope.build_required_version is distinct from locked_scope.required_version
     or locked_scope.build_lease_expires_at is null
     or locked_scope.build_lease_expires_at <= now_value then
    raise exception using errcode = '55000', message = 'STOCK_SNAPSHOT_WORKER_FENCED';
  end if;
  if input_chunk_sequence = locked_scope.build_last_chunk_sequence then
    return locked_scope.build_last_chunk_result;
  end if;
  if input_chunk_sequence <> locked_scope.build_last_chunk_sequence + 1 then
    raise exception using errcode = '22023', message = 'STOCK_SNAPSHOT_CHUNK_SEQUENCE_INVALID';
  end if;

  with visible_uploads as materialized (
    select * from public.stock_needs_scope_uploads_v1(input_scope_id)
  ), next_keys as materialized (
    select summary.normalized_mpn
    from public.business_mpn_summaries summary
    join visible_uploads visible on visible.upload_batch_id = summary.upload_batch_id
      and visible.summary_version = summary.data_version and not visible.dirty
    where locked_scope.build_cursor_mpn is null
       or summary.normalized_mpn > locked_scope.build_cursor_mpn
    group by summary.normalized_mpn
    order by summary.normalized_mpn
    limit chunk_limit
  ), grouped as (
    select
      summary.normalized_mpn,
      min(summary.display_mpn) as display_mpn,
      (array_agg(summary.stock_customer_name order by visible.upload_created_at desc, visible.upload_batch_id desc)
        filter (where summary.stock_customer_name is not null))[1] as customer_name,
      (array_agg(summary.stock_supplier_name order by visible.upload_created_at desc, visible.upload_batch_id desc)
        filter (where summary.stock_supplier_name is not null))[1] as supplier_name,
      (array_agg(summary.stock_manufacturer_name order by visible.upload_created_at desc, visible.upload_batch_id desc)
        filter (where summary.stock_manufacturer_name is not null))[1] as manufacturer_name,
      nullif(sum(summary.stock_required_qty), 0) as demand_qty,
      nullif(sum(summary.stock_available_qty), 0) as stock_qty,
      (array_agg(summary.required_date order by visible.upload_created_at desc, visible.upload_batch_id desc)
        filter (where summary.required_date is not null))[1] as required_date,
      (array_agg(summary.lead_time order by visible.upload_created_at desc, visible.upload_batch_id desc)
        filter (where summary.lead_time is not null))[1] as lead_time,
      array_agg(distinct visible.import_status order by visible.import_status) as import_statuses,
      bool_or(visible.missing_profile) as missing_profile
    from next_keys key
    join public.business_mpn_summaries summary on summary.normalized_mpn = key.normalized_mpn
    join visible_uploads visible on visible.upload_batch_id = summary.upload_batch_id
      and visible.summary_version = summary.data_version and not visible.dirty
    group by summary.normalized_mpn
  ), classified as (
    select grouped.*,
      greatest(coalesce(demand_qty, 0) - coalesce(stock_qty, 0), 0) as shortage_qty,
      case
        when demand_qty is null and coalesce(stock_qty, 0) > 0 then 'overstock'
        when demand_qty is null then 'unknown'
        when coalesce(stock_qty, 0) <= 0 then 'no_stock'
        when stock_qty < demand_qty then 'partial_stock'
        when stock_qty > demand_qty then 'overstock'
        else 'in_stock'
      end as coverage_status
    from grouped
  ), numbered as (
    select classified.*,
      case coverage_status when 'no_stock' then 0 when 'partial_stock' then 1
        when 'unknown' then 2 when 'in_stock' then 3 else 4 end::smallint as coverage_rank,
      row_number() over (partition by coverage_status order by normalized_mpn) as chunk_ordinal
    from classified
  )
  insert into public.business_stock_needs_snapshot_rows(
    data_scope_id, generation, chunk_sequence, normalized_mpn, display_mpn,
    customer_name, supplier_name, manufacturer_name, demand_qty, stock_qty,
    shortage_qty, coverage_status, coverage_rank, coverage_ordinal,
    required_date, lead_time, import_statuses, missing_profile
  )
  select input_scope_id, input_generation, input_chunk_sequence,
    numbered.normalized_mpn, numbered.display_mpn, numbered.customer_name,
    numbered.supplier_name, numbered.manufacturer_name, numbered.demand_qty,
    numbered.stock_qty, numbered.shortage_qty, numbered.coverage_status,
    numbered.coverage_rank,
    numbered.chunk_ordinal + case numbered.coverage_status
      when 'in_stock' then locked_scope.build_in_stock
      when 'partial_stock' then locked_scope.build_partial_stock
      when 'no_stock' then locked_scope.build_no_stock
      when 'overstock' then locked_scope.build_overstock
      else locked_scope.build_unknown end,
    numbered.required_date, numbered.lead_time, numbered.import_statuses,
    numbered.missing_profile
  from numbered
  order by numbered.normalized_mpn;
  get diagnostics inserted_rows = row_count;

  if inserted_rows = 0 then
    return jsonb_build_object(
      'done', true, 'chunkSequence', input_chunk_sequence,
      'rowsBuilt', locked_scope.build_rows_built,
      'sourcesBuilt', locked_scope.build_sources_built,
      'cursorMpn', locked_scope.build_cursor_mpn
    );
  end if;

  with visible_uploads as materialized (
    select * from public.stock_needs_scope_uploads_v1(input_scope_id)
  ), ranked as (
    select row_data.normalized_mpn, visible.upload_batch_id,
      visible.original_file_name, coalesce(visible.detected_template, visible.detected_category) as detected_template,
      visible.import_status, visible.upload_created_at,
      row_number() over (
        partition by row_data.normalized_mpn
        order by visible.upload_created_at desc, visible.upload_batch_id desc
      ) as source_rank
    from public.business_stock_needs_snapshot_rows row_data
    join public.business_mpn_summaries summary
      on summary.normalized_mpn = row_data.normalized_mpn
    join visible_uploads visible on visible.upload_batch_id = summary.upload_batch_id
      and visible.summary_version = summary.data_version and not visible.dirty
    where row_data.data_scope_id = input_scope_id
      and row_data.generation = input_generation
      and row_data.chunk_sequence = input_chunk_sequence
  )
  insert into public.business_stock_needs_snapshot_sources(
    data_scope_id, generation, normalized_mpn, source_rank, upload_batch_id,
    file_name, detected_template, import_status, upload_created_at
  )
  select input_scope_id, input_generation, ranked.normalized_mpn,
    ranked.source_rank::smallint, ranked.upload_batch_id,
    ranked.original_file_name, ranked.detected_template,
    ranked.import_status, ranked.upload_created_at
  from ranked where ranked.source_rank <= 5;
  get diagnostics inserted_sources = row_count;

  select max(row_data.normalized_mpn),
    count(*) filter (where coverage_status = 'in_stock'),
    count(*) filter (where coverage_status = 'partial_stock'),
    count(*) filter (where coverage_status = 'no_stock'),
    count(*) filter (where coverage_status = 'overstock'),
    count(*) filter (where coverage_status = 'unknown'),
    coalesce(sum(demand_qty), 0), coalesce(sum(stock_qty), 0),
    coalesce(bool_or(missing_profile), false)
  into chunk_cursor, count_in_stock, count_partial, count_no_stock,
    count_overstock, count_unknown, chunk_required, chunk_stock, chunk_missing
  from public.business_stock_needs_snapshot_rows row_data
  where row_data.data_scope_id = input_scope_id
    and row_data.generation = input_generation
    and row_data.chunk_sequence = input_chunk_sequence;

  select coalesce(sum(pg_column_size(row_data)), 0) + coalesce((
    select sum(pg_column_size(source_data))
    from public.business_stock_needs_snapshot_sources source_data
    where source_data.data_scope_id = input_scope_id
      and source_data.generation = input_generation
      and exists (
        select 1 from public.business_stock_needs_snapshot_rows chunk_row
        where chunk_row.data_scope_id = input_scope_id
          and chunk_row.generation = input_generation
          and chunk_row.chunk_sequence = input_chunk_sequence
          and chunk_row.normalized_mpn = source_data.normalized_mpn
      )
  ), 0)
  into chunk_bytes
  from public.business_stock_needs_snapshot_rows row_data
  where row_data.data_scope_id = input_scope_id
    and row_data.generation = input_generation
    and row_data.chunk_sequence = input_chunk_sequence;

  result := jsonb_build_object(
    'done', false, 'chunkSequence', input_chunk_sequence,
    'chunkRows', inserted_rows, 'chunkSources', inserted_sources,
    'chunkBytes', chunk_bytes, 'cursorMpn', chunk_cursor,
    'rowsBuilt', locked_scope.build_rows_built + inserted_rows,
    'sourcesBuilt', locked_scope.build_sources_built + inserted_sources
  );

  update public.business_stock_needs_scopes scope
  set build_cursor_mpn = chunk_cursor,
      build_last_chunk_sequence = input_chunk_sequence,
      build_last_chunk_result = result,
      build_rows_built = scope.build_rows_built + inserted_rows,
      build_sources_built = scope.build_sources_built + inserted_sources,
      build_peak_chunk_rows = greatest(scope.build_peak_chunk_rows, inserted_rows),
      build_peak_payload_bytes = greatest(scope.build_peak_payload_bytes, chunk_bytes),
      build_in_stock = scope.build_in_stock + count_in_stock,
      build_partial_stock = scope.build_partial_stock + count_partial,
      build_no_stock = scope.build_no_stock + count_no_stock,
      build_overstock = scope.build_overstock + count_overstock,
      build_unknown = scope.build_unknown + count_unknown,
      build_total_required_qty = scope.build_total_required_qty + chunk_required,
      build_total_stock_qty = scope.build_total_stock_qty + chunk_stock,
      build_has_missing_profiles = scope.build_has_missing_profiles or chunk_missing,
      updated_at = now_value
  where scope.id = input_scope_id;
  return result;
end;
$$;

create or replace function public.publish_stock_needs_snapshot_rebuild_v1(
  input_scope_id uuid,
  input_worker_id text,
  input_rebuild_id uuid,
  input_generation bigint,
  input_fence_token bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_scope public.business_stock_needs_scopes%rowtype;
  source_state record;
  actual_rows bigint;
  actual_sources bigint;
  result jsonb;
  now_value timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'STOCK_SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;
  select scope.* into locked_scope
  from public.business_stock_needs_scopes scope
  where scope.id = input_scope_id for update;
  if locked_scope.snapshot_status = 'ready'
     and locked_scope.last_published_build_id = input_rebuild_id
     and locked_scope.last_published_generation = input_generation then
    return locked_scope.last_published_result;
  end if;
  if not found or locked_scope.snapshot_status <> 'rebuilding'
     or locked_scope.build_locked_by is distinct from input_worker_id
     or locked_scope.build_id is distinct from input_rebuild_id
     or locked_scope.build_generation <> input_generation
     or locked_scope.build_fence_token <> input_fence_token
     or locked_scope.build_required_version is distinct from locked_scope.required_version
     or locked_scope.build_lease_expires_at is null
     or locked_scope.build_lease_expires_at <= now_value then
    raise exception using errcode = '55000', message = 'STOCK_SNAPSHOT_WORKER_FENCED';
  end if;

  select * into source_state from public.stock_needs_scope_source_state_v1(input_scope_id);
  if not source_state.source_ready
     or source_state.source_fingerprint is distinct from locked_scope.build_source_fingerprint then
    raise exception using errcode = '55000', message = 'STOCK_SNAPSHOT_SOURCE_FENCED';
  end if;
  select count(*) into actual_rows
  from public.business_stock_needs_snapshot_rows row_data
  where row_data.data_scope_id = input_scope_id and row_data.generation = input_generation;
  select count(*) into actual_sources
  from public.business_stock_needs_snapshot_sources source_data
  where source_data.data_scope_id = input_scope_id and source_data.generation = input_generation;
  if actual_rows <> locked_scope.build_rows_built
     or actual_sources <> locked_scope.build_sources_built
     or locked_scope.build_rows_built <> locked_scope.build_in_stock
       + locked_scope.build_partial_stock + locked_scope.build_no_stock
       + locked_scope.build_overstock + locked_scope.build_unknown then
    raise exception using errcode = '22023', message = 'STOCK_SNAPSHOT_PUBLISH_COUNT_MISMATCH';
  end if;
  if exists (
    select 1 from public.business_stock_needs_snapshot_sources source_data
    where source_data.data_scope_id = input_scope_id and source_data.generation = input_generation
    group by source_data.normalized_mpn having count(*) > 5
  ) then
    raise exception using errcode = '22023', message = 'STOCK_SNAPSHOT_SOURCE_LIMIT_BROKEN';
  end if;
  if current_setting('quiksol.stock_snapshot_fail_before_publish', true) = input_rebuild_id::text then
    raise exception using errcode = 'P0001', message = 'STOCK_SNAPSHOT_PUBLISH_INJECTED_FAILURE';
  end if;

  result := jsonb_build_object(
    'status', 'ready', 'scopeId', input_scope_id,
    'generation', input_generation, 'version', locked_scope.build_required_version,
    'rows', actual_rows, 'sources', actual_sources,
    'sourceFingerprint', locked_scope.build_source_fingerprint
  );
  update public.business_stock_needs_scopes scope
  set snapshot_status = 'ready', published_version = locked_scope.build_required_version,
      active_data_scope_id = input_scope_id, active_generation = input_generation,
      retained_generations = case
        when locked_scope.last_published_generation is null
          or locked_scope.last_published_generation = input_generation then array[input_generation]
        else array[input_generation, locked_scope.last_published_generation]
      end,
      total_items = locked_scope.build_rows_built,
      total_in_stock = locked_scope.build_in_stock,
      total_partial_stock = locked_scope.build_partial_stock,
      total_no_stock = locked_scope.build_no_stock,
      total_overstock = locked_scope.build_overstock,
      total_unknown = locked_scope.build_unknown,
      total_required_qty = locked_scope.build_total_required_qty,
      total_stock_qty = locked_scope.build_total_stock_qty,
      has_missing_profiles = locked_scope.build_has_missing_profiles,
      published_source_fingerprint = locked_scope.build_source_fingerprint,
      published_source_watermark = locked_scope.build_source_watermark,
      published_at = now_value, last_published_build_id = input_rebuild_id,
      last_published_generation = input_generation,
      last_published_fence_token = input_fence_token,
      last_published_result = result, build_id = null,
      build_locked_by = null, build_lease_expires_at = null,
      build_next_retry_at = null, last_failure_code = null,
      updated_at = now_value
  where scope.id = input_scope_id;
  return result;
end;
$$;

create or replace function public.fail_stock_needs_snapshot_rebuild_v1(
  input_scope_id uuid,
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
  locked_scope public.business_stock_needs_scopes%rowtype;
  next_status text;
  next_retry timestamptz;
  safe_code text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'STOCK_SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;
  select scope.* into locked_scope from public.business_stock_needs_scopes scope
  where scope.id = input_scope_id for update;
  if not found or locked_scope.snapshot_status <> 'rebuilding'
     or locked_scope.build_locked_by is distinct from input_worker_id
     or locked_scope.build_id is distinct from input_rebuild_id
     or locked_scope.build_generation <> input_generation
     or locked_scope.build_fence_token <> input_fence_token then
    raise exception using errcode = '55000', message = 'STOCK_SNAPSHOT_WORKER_FENCED';
  end if;
  safe_code := left(regexp_replace(coalesce(nullif(input_error_code, ''),
    'STOCK_SNAPSHOT_REBUILD_FAILED'), '[^A-Za-z0-9_.-]', '', 'g'), 80);
  if coalesce(input_retryable, false) and locked_scope.build_attempts < locked_scope.build_max_attempts then
    next_status := 'retrying';
    next_retry := clock_timestamp() + make_interval(secs => least(900::double precision,
      (5 * power(2::numeric, greatest(locked_scope.build_attempts - 1, 0)))::double precision));
  else
    next_status := 'failed';
    next_retry := null;
  end if;
  update public.business_stock_needs_scopes scope
  set snapshot_status = next_status,
      build_id = case when next_status = 'retrying' then scope.build_id else null end,
      build_fence_token = scope.build_fence_token + 1,
      build_locked_by = null, build_lease_expires_at = null,
      build_next_retry_at = next_retry, last_failure_code = safe_code,
      updated_at = clock_timestamp()
  where scope.id = input_scope_id;
  return jsonb_build_object('status', next_status, 'retryAfter', next_retry,
    'attempts', locked_scope.build_attempts,
    'maxAttempts', locked_scope.build_max_attempts, 'errorCode', safe_code);
end;
$$;

create or replace function public.cleanup_stock_needs_snapshot_generations_v1(
  input_batch_limit integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  batch_limit integer := least(greatest(coalesce(input_batch_limit, 1000), 1), 2000);
  deleted_rows bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'STOCK_SNAPSHOT_SERVICE_ROLE_REQUIRED';
  end if;

  with doomed as materialized (
    select row_data.ctid
    from public.business_stock_needs_snapshot_rows row_data
    join public.business_stock_needs_scopes physical_scope
      on physical_scope.id = row_data.data_scope_id
    where not (row_data.generation = any(physical_scope.retained_generations))
      and not (
        physical_scope.snapshot_status in ('rebuilding', 'retrying')
        and physical_scope.build_generation = row_data.generation
      )
      and not exists (
        select 1 from public.business_stock_needs_scopes reader_scope
        where reader_scope.active_data_scope_id = row_data.data_scope_id
          and reader_scope.active_generation = row_data.generation
      )
    order by row_data.created_at, row_data.data_scope_id,
      row_data.generation, row_data.normalized_mpn
    for update of row_data skip locked
    limit batch_limit
  ), removed as (
    delete from public.business_stock_needs_snapshot_rows row_data
    using doomed
    where row_data.ctid = doomed.ctid
    returning 1
  )
  select count(*) into deleted_rows from removed;

  return jsonb_build_object(
    'rowsDeleted', deleted_rows,
    'done', deleted_rows < batch_limit,
    'batchLimit', batch_limit
  );
end;
$$;

create or replace function public.stock_needs_scope_id_for_actor_v1(input_upload_batch_id uuid default null)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor public.profiles%rowtype;
  resolved_id uuid;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    if input_upload_batch_id is null then
      select id into resolved_id from public.business_stock_needs_scopes
      where scope_key = 'company' and enabled;
    else
      select scope.id into resolved_id
      from public.business_stock_needs_scopes scope
      join public.upload_batches upload on upload.id = scope.upload_batch_id
      where scope.scope_key = 'upload:' || input_upload_batch_id::text and scope.enabled
        and upload.archived_at is null
        and upload.status in ('completed', 'completed_with_warnings');
    end if;
    return resolved_id;
  end if;
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
    raise exception using errcode = '42501', message = 'STOCK_SNAPSHOT_AUTHENTICATED_ACTOR_REQUIRED';
  end if;
  select profile.* into actor from public.profiles profile
  where profile.id = auth.uid() and profile.is_active;
  if not found or actor.role not in ('employee', 'manager', 'admin', 'super_admin_dev') then
    raise exception using errcode = '42501', message = 'STOCK_SNAPSHOT_ACTOR_INVALID';
  end if;
  if input_upload_batch_id is not null then
    if not exists (
      select 1 from public.upload_batches upload
      where upload.id = input_upload_batch_id and upload.archived_at is null
        and upload.status in ('completed', 'completed_with_warnings')
        and public.can_read_upload(upload.uploaded_by)
    ) then
      raise exception using errcode = '42501', message = 'STOCK_SNAPSHOT_SCOPE_FORBIDDEN';
    end if;
    select id into resolved_id from public.business_stock_needs_scopes
    where scope_key = 'upload:' || input_upload_batch_id::text and enabled;
  elsif actor.role in ('admin', 'super_admin_dev') then
    select id into resolved_id from public.business_stock_needs_scopes
    where scope_key = 'company' and enabled;
  elsif actor.role = 'manager' and (actor.department is not null or actor.region is not null) then
    select id into resolved_id from public.business_stock_needs_scopes
    where scope_key = public.stock_needs_team_scope_key_v1(actor.department, actor.region) and enabled;
  else
    select id into resolved_id from public.business_stock_needs_scopes
    where scope_key = 'owner:' || actor.id::text and enabled;
  end if;
  return resolved_id;
end;
$$;

create or replace function public.get_stock_needs_snapshot_state_v1(p_upload_batch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  resolved_id uuid;
  scope public.business_stock_needs_scopes%rowtype;
  source_state record;
  effective_status text;
  ready boolean;
  retry_seconds integer;
begin
  resolved_id := public.stock_needs_scope_id_for_actor_v1(p_upload_batch_id);
  if resolved_id is null then
    return jsonb_build_object('summaryReady', false, 'status', 'contract_unavailable',
      'currentVersion', null, 'requiredVersion', null, 'retryAfterSeconds', 60,
      'pendingCount', 1, 'totalScopes', 1, 'missingVersionCount', 1);
  end if;
  select item.* into scope from public.business_stock_needs_scopes item where item.id = resolved_id;
  select * into source_state from public.stock_needs_scope_source_state_v1(resolved_id);
  effective_status := case
    when source_state.has_failed then 'failed'
    when not source_state.source_ready then 'queued'
    when scope.snapshot_status = 'ready' and scope.published_version is distinct from scope.required_version then 'stale'
    else scope.snapshot_status
  end;
  ready := effective_status = 'ready'
    and scope.published_version = scope.required_version
    and scope.active_data_scope_id is not null and scope.active_generation is not null;
  retry_seconds := case
    when ready then 0
    when effective_status = 'failed' then 30
    when effective_status = 'retrying' and scope.build_next_retry_at is not null
      then greatest(1, ceil(extract(epoch from scope.build_next_retry_at - clock_timestamp()))::integer)
    else 3 end;
  return jsonb_build_object(
    'summaryReady', ready, 'status', case when ready then 'ready' else effective_status end,
    'currentVersion', scope.published_version, 'requiredVersion', scope.required_version,
    'retryAfterSeconds', retry_seconds, 'pendingCount', case when ready then 0 else 1 end,
    'totalScopes', 1, 'missingVersionCount', case when scope.published_version is null then 1 else 0 end,
    'generation', scope.active_generation
  );
end;
$$;

create or replace function public.get_stock_needs_snapshot_page_v1(
  p_limit integer default 50,
  p_offset integer default 0,
  p_q text default null,
  p_customer text default null,
  p_supplier text default null,
  p_manufacturer text default null,
  p_status text default null,
  p_coverage text default null,
  p_upload_batch_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  resolved_id uuid;
  scope public.business_stock_needs_scopes%rowtype;
  state jsonb;
  actor_role text;
  safe_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  safe_offset integer := greatest(coalesce(p_offset, 0), 0);
  unfiltered boolean;
  payload jsonb;
begin
  resolved_id := public.stock_needs_scope_id_for_actor_v1(p_upload_batch_id);
  state := public.get_stock_needs_snapshot_state_v1(p_upload_batch_id);
  if coalesce((state->>'summaryReady')::boolean, false) is not true then
    return state;
  end if;
  select item.* into scope from public.business_stock_needs_scopes item where item.id = resolved_id;
  select case when auth.role() = 'service_role' then 'super_admin_dev' else profile.role end
  into actor_role
  from (select 1) singleton
  left join public.profiles profile on profile.id = auth.uid();
  unfiltered := p_q is null and p_customer is null and p_supplier is null
    and p_manufacturer is null and p_status is null and p_coverage is null;

  if unfiltered then
    with page as materialized (
      select row_data.* from public.business_stock_needs_snapshot_rows row_data
      where row_data.data_scope_id = scope.active_data_scope_id
        and row_data.generation = scope.active_generation and row_data.coverage_rank = 0
        and row_data.coverage_ordinal > safe_offset::bigint
        and row_data.coverage_ordinal <= (safe_offset + safe_limit)::bigint
      union all
      select row_data.* from public.business_stock_needs_snapshot_rows row_data
      where row_data.data_scope_id = scope.active_data_scope_id
        and row_data.generation = scope.active_generation and row_data.coverage_rank = 1
        and row_data.coverage_ordinal > greatest(safe_offset::bigint - scope.total_no_stock, 0)
        and row_data.coverage_ordinal <= greatest((safe_offset + safe_limit)::bigint - scope.total_no_stock, 0)
      union all
      select row_data.* from public.business_stock_needs_snapshot_rows row_data
      where row_data.data_scope_id = scope.active_data_scope_id
        and row_data.generation = scope.active_generation and row_data.coverage_rank = 2
        and row_data.coverage_ordinal > greatest(safe_offset::bigint - scope.total_no_stock - scope.total_partial_stock, 0)
        and row_data.coverage_ordinal <= greatest((safe_offset + safe_limit)::bigint - scope.total_no_stock - scope.total_partial_stock, 0)
      union all
      select row_data.* from public.business_stock_needs_snapshot_rows row_data
      where row_data.data_scope_id = scope.active_data_scope_id
        and row_data.generation = scope.active_generation and row_data.coverage_rank = 3
        and row_data.coverage_ordinal > greatest(safe_offset::bigint - scope.total_no_stock - scope.total_partial_stock - scope.total_unknown, 0)
        and row_data.coverage_ordinal <= greatest((safe_offset + safe_limit)::bigint - scope.total_no_stock - scope.total_partial_stock - scope.total_unknown, 0)
      union all
      select row_data.* from public.business_stock_needs_snapshot_rows row_data
      where row_data.data_scope_id = scope.active_data_scope_id
        and row_data.generation = scope.active_generation and row_data.coverage_rank = 4
        and row_data.coverage_ordinal > greatest(safe_offset::bigint - scope.total_no_stock - scope.total_partial_stock - scope.total_unknown - scope.total_in_stock, 0)
        and row_data.coverage_ordinal <= greatest((safe_offset + safe_limit)::bigint - scope.total_no_stock - scope.total_partial_stock - scope.total_unknown - scope.total_in_stock, 0)
    ), page_sources as (
      select page.normalized_mpn, source_page.source_uploads
      from page
      cross join lateral (
        select jsonb_agg(jsonb_build_object(
          'uploadBatchId', source_data.upload_batch_id,
          'fileName', source_data.file_name,
          'detectedTemplate', source_data.detected_template,
          'importStatus', source_data.import_status
        ) order by source_data.source_rank) as source_uploads
        from (
          select source_data.*
          from public.business_stock_needs_snapshot_sources source_data
          where source_data.data_scope_id = scope.active_data_scope_id
            and source_data.generation = scope.active_generation
            and source_data.normalized_mpn = page.normalized_mpn
          order by source_data.source_rank limit 5
        ) source_data
      ) source_page
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(jsonb_build_object(
        'mpn', page.display_mpn,
        'customerName', case when actor_role = 'employee' then null else page.customer_name end,
        'manufacturerName', case when actor_role = 'employee' then null else page.manufacturer_name end,
        'supplierName', case when actor_role = 'employee' then null else page.supplier_name end,
        'requiredQty', page.demand_qty, 'stockQty', page.stock_qty,
        'availableQty', page.stock_qty, 'shortageQty', page.shortage_qty,
        'coverageStatus', page.coverage_status, 'requiredDate', page.required_date,
        'leadTime', page.lead_time,
        'sourceUploads', coalesce(page_sources.source_uploads, '[]'::jsonb),
        'warnings', '[]'::jsonb
      ) order by page.coverage_rank, page.coverage_ordinal)
        from page left join page_sources using (normalized_mpn)), '[]'::jsonb),
      'totals', jsonb_build_object(
        'totalItems', scope.total_items, 'inStock', scope.total_in_stock,
        'partialStock', scope.total_partial_stock, 'noStock', scope.total_no_stock,
        'overstock', scope.total_overstock, 'unknown', scope.total_unknown,
        'totalRequiredQty', scope.total_required_qty, 'totalStockQty', scope.total_stock_qty
      ),
      'meta', jsonb_build_object('limit', safe_limit, 'offset', safe_offset,
        'returnedItems', (select count(*) from page), 'scannedRecords', 0,
        'missingProfileCount', 0, 'missingProfileUploadIds', '[]'::jsonb,
        'hasMissingProfiles', scope.has_missing_profiles),
      'summaryReady', true
    ) into payload;
    return payload;
  end if;

  with page as materialized (
    select row_data.*
    from public.business_stock_needs_snapshot_rows row_data
    where row_data.data_scope_id = scope.active_data_scope_id
      and row_data.generation = scope.active_generation
      and (p_q is null or row_data.normalized_mpn like '%' || public.normalize_business_mpn_v1(p_q) || '%')
      and (p_customer is null or (
        actor_role <> 'employee' and row_data.customer_name ilike '%' || p_customer || '%'
      ))
      and case when p_supplier is not null and p_manufacturer is not null and p_supplier = p_manufacturer
        then actor_role <> 'employee' and (
          coalesce(row_data.supplier_name ilike '%' || p_supplier || '%', false)
          or coalesce(row_data.manufacturer_name ilike '%' || p_manufacturer || '%', false)
        )
        else (p_supplier is null or (
          actor_role <> 'employee' and row_data.supplier_name ilike '%' || p_supplier || '%'
        )) and (p_manufacturer is null or (
          actor_role <> 'employee' and row_data.manufacturer_name ilike '%' || p_manufacturer || '%'
        )) end
      and (p_status is null or row_data.import_statuses @> array[p_status])
      and (p_coverage is null or row_data.coverage_status = p_coverage)
    order by row_data.coverage_rank, row_data.coverage_ordinal
    limit safe_limit offset safe_offset
  ), totals as (
    select count(*)::bigint as total_items,
      count(*) filter (where coverage_status = 'in_stock')::bigint as in_stock,
      count(*) filter (where coverage_status = 'partial_stock')::bigint as partial_stock,
      count(*) filter (where coverage_status = 'no_stock')::bigint as no_stock,
      count(*) filter (where coverage_status = 'overstock')::bigint as overstock,
      count(*) filter (where coverage_status = 'unknown')::bigint as unknown,
      coalesce(sum(demand_qty), 0) as total_required_qty,
      coalesce(sum(stock_qty), 0) as total_stock_qty,
      coalesce(bool_or(missing_profile), false) as has_missing_profiles
    from public.business_stock_needs_snapshot_rows row_data
    where row_data.data_scope_id = scope.active_data_scope_id
      and row_data.generation = scope.active_generation
      and (p_q is null or row_data.normalized_mpn like '%' || public.normalize_business_mpn_v1(p_q) || '%')
      and (p_customer is null or (
        actor_role <> 'employee' and row_data.customer_name ilike '%' || p_customer || '%'
      ))
      and case when p_supplier is not null and p_manufacturer is not null and p_supplier = p_manufacturer
        then actor_role <> 'employee' and (
          coalesce(row_data.supplier_name ilike '%' || p_supplier || '%', false)
          or coalesce(row_data.manufacturer_name ilike '%' || p_manufacturer || '%', false)
        )
        else (p_supplier is null or (
          actor_role <> 'employee' and row_data.supplier_name ilike '%' || p_supplier || '%'
        )) and (p_manufacturer is null or (
          actor_role <> 'employee' and row_data.manufacturer_name ilike '%' || p_manufacturer || '%'
        )) end
      and (p_status is null or row_data.import_statuses @> array[p_status])
      and (p_coverage is null or row_data.coverage_status = p_coverage)
  ), page_sources as (
    select page.normalized_mpn, source_page.source_uploads
    from page
    cross join lateral (
      select jsonb_agg(jsonb_build_object(
        'uploadBatchId', source_data.upload_batch_id,
        'fileName', source_data.file_name,
        'detectedTemplate', source_data.detected_template,
        'importStatus', source_data.import_status
      ) order by source_data.source_rank) as source_uploads
      from (
        select source_data.*
        from public.business_stock_needs_snapshot_sources source_data
        where source_data.data_scope_id = scope.active_data_scope_id
          and source_data.generation = scope.active_generation
          and source_data.normalized_mpn = page.normalized_mpn
        order by source_data.source_rank limit 5
      ) source_data
    ) source_page
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'mpn', page.display_mpn,
      'customerName', case when actor_role = 'employee' then null else page.customer_name end,
      'manufacturerName', case when actor_role = 'employee' then null else page.manufacturer_name end,
      'supplierName', case when actor_role = 'employee' then null else page.supplier_name end,
      'requiredQty', page.demand_qty, 'stockQty', page.stock_qty,
      'availableQty', page.stock_qty, 'shortageQty', page.shortage_qty,
      'coverageStatus', page.coverage_status, 'requiredDate', page.required_date,
      'leadTime', page.lead_time,
      'sourceUploads', coalesce(page_sources.source_uploads, '[]'::jsonb),
      'warnings', '[]'::jsonb
    ) order by page.coverage_rank, page.coverage_ordinal)
      from page left join page_sources using (normalized_mpn)), '[]'::jsonb),
    'totals', (select jsonb_build_object(
      'totalItems', total_items, 'inStock', in_stock,
      'partialStock', partial_stock, 'noStock', no_stock,
      'overstock', overstock, 'unknown', unknown,
      'totalRequiredQty', total_required_qty, 'totalStockQty', total_stock_qty
    ) from totals),
    'meta', jsonb_build_object('limit', safe_limit, 'offset', safe_offset,
      'returnedItems', (select count(*) from page), 'scannedRecords', 0,
      'missingProfileCount', 0, 'missingProfileUploadIds', '[]'::jsonb,
      'hasMissingProfiles', (select has_missing_profiles from totals)),
    'summaryReady', true
  ) into payload;
  return payload;
end;
$$;

-- The R7.4 tables are private even to authenticated/service-role PostgREST.
-- Backend workers and user reads use only the narrowly granted RPCs below.
revoke all on function public.stock_needs_team_scope_key_v1(text, text) from public, anon, authenticated, service_role;
revoke all on function public.ensure_stock_needs_scopes_v1() from public, anon, authenticated, service_role;
revoke all on function public.stock_needs_scope_uploads_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_needs_scope_source_state_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.queue_stock_needs_snapshots_v1() from public, anon, authenticated, service_role;
revoke all on function public.stock_needs_scope_id_for_actor_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_stock_needs_snapshot_rebuild_v1(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_stock_needs_snapshot_rebuild_v1(uuid, text, uuid, bigint, bigint, integer) from public, anon, authenticated, service_role;
revoke all on function public.stage_stock_needs_snapshot_chunk_v1(uuid, text, uuid, bigint, bigint, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.publish_stock_needs_snapshot_rebuild_v1(uuid, text, uuid, bigint, bigint) from public, anon, authenticated, service_role;
revoke all on function public.fail_stock_needs_snapshot_rebuild_v1(uuid, text, uuid, bigint, bigint, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.cleanup_stock_needs_snapshot_generations_v1(integer) from public, anon, authenticated, service_role;
revoke all on function public.get_stock_needs_snapshot_state_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_stock_needs_snapshot_page_v1(integer, integer, text, text, text, text, text, text, uuid) from public, anon, authenticated, service_role;

grant execute on function public.claim_stock_needs_snapshot_rebuild_v1(text, integer) to service_role;
grant execute on function public.heartbeat_stock_needs_snapshot_rebuild_v1(uuid, text, uuid, bigint, bigint, integer) to service_role;
grant execute on function public.stage_stock_needs_snapshot_chunk_v1(uuid, text, uuid, bigint, bigint, integer, integer) to service_role;
grant execute on function public.publish_stock_needs_snapshot_rebuild_v1(uuid, text, uuid, bigint, bigint) to service_role;
grant execute on function public.fail_stock_needs_snapshot_rebuild_v1(uuid, text, uuid, bigint, bigint, text, boolean) to service_role;
grant execute on function public.cleanup_stock_needs_snapshot_generations_v1(integer) to service_role;
grant execute on function public.get_stock_needs_snapshot_state_v1(uuid) to authenticated, service_role;
grant execute on function public.get_stock_needs_snapshot_page_v1(integer, integer, text, text, text, text, text, text, uuid) to authenticated, service_role;

alter function public.get_stock_needs_snapshot_state_v1(uuid) owner to postgres;
alter function public.get_stock_needs_snapshot_page_v1(integer, integer, text, text, text, text, text, text, uuid) owner to postgres;

comment on function public.get_stock_needs_snapshot_page_v1(integer, integer, text, text, text, text, text, text, uuid) is
  'R7.4 role-scoped Stock Needs snapshot reader. Resolves a canonical ready generation and never falls back to a global rollup.';

create or replace function public.database_safety_table_catalog_v2()
returns table(schema_name text, table_name text, category text, planned_action text, delete_order integer, reason text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select original.schema_name, original.table_name,
    case when original.table_name in ('password_reset_codes','api_rate_limits','observability_log_outbox')
      then 'SYSTEM_EPHEMERAL' else original.category end,
    case when original.schema_name='public' and original.table_name in (
      'password_reset_codes','api_rate_limits','observability_log_outbox',
      'audit_logs','security_events','system_logs','client_logs','performance_logs'
    ) then 'PRESERVE' else original.planned_action end,
    case when original.schema_name='public' and original.table_name in (
      'password_reset_codes','api_rate_limits','observability_log_outbox',
      'audit_logs','security_events','system_logs','client_logs','performance_logs'
    ) then null else original.delete_order end,
    case
      when original.table_name='password_reset_codes' then 'Authentication recovery state is preserved.'
      when original.table_name='api_rate_limits' then 'Security rate-limit state is preserved and does not stale business backups.'
      when original.table_name='observability_log_outbox' then 'Observability delivery state is preserved.'
      when original.table_name in ('audit_logs','security_events','system_logs','client_logs','performance_logs')
        then 'Security and observability evidence is preserved.'
      when original.table_name='database_safety_state'
        then 'Database Safety configuration; authoritative watermarks are sequence-backed.'
      else original.reason end
  from public.database_safety_table_catalog() original
  union all select 'public','import_job_staging_rows','OPERATIONAL_DATA','DELETE',5,'Transient import staging can contain business data.'
  union all select 'public','worker_runtime_heartbeats','SYSTEM_EPHEMERAL','PRESERVE',null,'Worker liveness contains no business payload and is preserved.'
  union all select 'public','business_summary_mpn_stage','BUSINESS_DATA','DELETE',5,'Version-fenced staged MPN summary aggregates.'
  union all select 'public','business_summary_entity_stage','BUSINESS_DATA','DELETE',5,'Version-fenced staged opportunity entities.'
  union all select 'public','business_stock_needs_scopes','OPERATIONAL_DATA','DELETE',20,'Versioned Stock Needs scope readiness and fenced build state.'
  union all select 'public','business_stock_needs_snapshot_rows','BUSINESS_DATA','DELETE',5,'Published and hidden staged Stock Needs snapshot rows.'
  union all select 'public','business_stock_needs_snapshot_sources','BUSINESS_DATA','DELETE',4,'Bounded authorized source provenance for Stock Needs pages.';
$$;

create or replace function public.database_safety_catalog_version_v2()
returns text language sql immutable security definer set search_path = pg_catalog
as $$ select '20260826160000-r74-v1'::text $$;

update public.database_safety_state
set catalog_version = '20260826160000-r74-v1', updated_at = clock_timestamp()
where singleton;

create trigger database_safety_watermark
after insert or update or delete or truncate on public.business_stock_needs_scopes
for each statement execute function public.touch_database_safety_watermark();
create trigger database_safety_watermark
after insert or update or delete or truncate on public.business_stock_needs_snapshot_rows
for each statement execute function public.touch_database_safety_watermark();
create trigger database_safety_watermark
after insert or update or delete or truncate on public.business_stock_needs_snapshot_sources
for each statement execute function public.touch_database_safety_watermark();

revoke all on function public.database_safety_table_catalog_v2() from public, anon, authenticated, service_role;
revoke all on function public.database_safety_catalog_version_v2() from public, anon, authenticated, service_role;
grant execute on function public.database_safety_table_catalog_v2() to service_role;
grant execute on function public.database_safety_catalog_version_v2() to service_role;

commit;
