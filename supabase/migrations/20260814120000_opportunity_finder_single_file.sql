-- Opportunity Finder: additive one-file comparisons against an immutable,
-- RLS-authorized QuikSol dataset snapshot. This migration is intentionally
-- local-only until reviewed and applied by an operator.

alter table public.business_upload_versions
  add column if not exists opportunity_entity_version bigint;

create table if not exists public.business_opportunity_entities (
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  data_version bigint not null check (data_version > 0),
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
  primary key (upload_batch_id, data_version, source_record_id, entity_kind)
);

create index if not exists business_opportunity_entities_lookup_idx
  on public.business_opportunity_entities
  (data_version, upload_batch_id, normalized_mpn, entity_kind, source_record_id);
create index if not exists business_opportunity_entities_owner_lookup_idx
  on public.business_opportunity_entities
  (owner_id, normalized_mpn, data_version);

alter table public.business_opportunity_entities enable row level security;
alter table public.business_opportunity_entities force row level security;
create policy business_opportunity_entities_select_scoped
  on public.business_opportunity_entities for select to authenticated
  using (public.can_read_upload(owner_id));
revoke all on public.business_opportunity_entities from public, anon, authenticated;
grant select on public.business_opportunity_entities to authenticated;
grant select, insert, update, delete on public.business_opportunity_entities to service_role;

create or replace function public.replace_business_upload_opportunity_entities_v1(
  target_upload_batch_id uuid,
  expected_data_version bigint,
  entity_rows jsonb
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_version public.business_upload_versions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if jsonb_typeof(entity_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'opportunity_entity_rows_must_be_array';
  end if;
  select version.* into locked_version
  from public.business_upload_versions version
  where version.upload_batch_id = target_upload_batch_id
  for update;
  if not found or locked_version.data_version <> expected_data_version then
    raise exception using errcode = '40001', message = 'opportunity_entity_version_stale';
  end if;

  insert into public.business_opportunity_entities (
    upload_batch_id, owner_id, data_version, source_record_id, entity_kind, entity_key,
    normalized_mpn, display_mpn, manufacturer_name, customer_name, supplier_name,
    required_qty, available_qty, excess_qty, required_date, unit_of_measure,
    lead_time_weeks, moq, spq, date_code, coo, condition,
    expires_at, is_active_demand, is_live_supply, warnings
  )
  select target_upload_batch_id, locked_version.owner_id, expected_data_version,
    (row->>'source_record_id')::uuid, row->>'entity_kind', row->>'entity_key',
    row->>'normalized_mpn', row->>'display_mpn', nullif(row->>'manufacturer_name', ''),
    nullif(row->>'customer_name', ''), nullif(row->>'supplier_name', ''),
    nullif(row->>'required_qty', '')::numeric, nullif(row->>'available_qty', '')::numeric,
    nullif(row->>'excess_qty', '')::numeric, nullif(row->>'required_date', '')::date,
    nullif(row->>'unit_of_measure', ''), nullif(row->>'lead_time_weeks', '')::numeric,
    nullif(row->>'moq', '')::numeric, nullif(row->>'spq', '')::numeric,
    nullif(row->>'date_code', ''), nullif(row->>'coo', ''), nullif(row->>'condition', ''),
    nullif(row->>'expires_at', '')::timestamptz,
    coalesce((row->>'is_active_demand')::boolean, true),
    coalesce((row->>'is_live_supply')::boolean, true),
    coalesce(array(select jsonb_array_elements_text(row->'warnings')), '{}')
  from jsonb_array_elements(entity_rows) row
  on conflict (upload_batch_id, data_version, source_record_id, entity_kind) do update set
    entity_key = excluded.entity_key,
    normalized_mpn = excluded.normalized_mpn,
    display_mpn = excluded.display_mpn,
    manufacturer_name = excluded.manufacturer_name,
    customer_name = excluded.customer_name,
    supplier_name = excluded.supplier_name,
    required_qty = excluded.required_qty,
    available_qty = excluded.available_qty,
    excess_qty = excluded.excess_qty,
    required_date = excluded.required_date,
    unit_of_measure = excluded.unit_of_measure,
    lead_time_weeks = excluded.lead_time_weeks,
    moq = excluded.moq,
    spq = excluded.spq,
    date_code = excluded.date_code,
    coo = excluded.coo,
    condition = excluded.condition,
    expires_at = excluded.expires_at,
    is_active_demand = excluded.is_active_demand,
    is_live_supply = excluded.is_live_supply,
    warnings = excluded.warnings;

  update public.business_upload_versions
  set opportunity_entity_version = expected_data_version,
      updated_at = now()
  where upload_batch_id = target_upload_batch_id and data_version = expected_data_version;
  return expected_data_version;
end;
$$;

revoke all on function public.replace_business_upload_opportunity_entities_v1(uuid,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_business_upload_opportunity_entities_v1(uuid,bigint,jsonb)
  to service_role;

-- Existing clean summaries need a one-time local background rebuild before the
-- one-file mode is available. No raw data is read by user requests.
update public.business_upload_versions
set dirty = true
where opportunity_entity_version is distinct from data_version;

alter table public.opportunity_finder_jobs
  add column if not exists comparison_mode text not null default 'two_files',
  add column if not exists uploaded_role text,
  add column if not exists opposite_dataset_role text,
  add column if not exists dataset_version text,
  add column if not exists dataset_scope text,
  add column if not exists dataset_manifest jsonb not null default '[]'::jsonb,
  add column if not exists dataset_snapshot_id uuid,
  add column if not exists dataset_snapshot_at timestamptz,
  add column if not exists snapshot_status text not null default 'not_required',
  add column if not exists existing_entity_count integer not null default 0,
  add column if not exists existing_mpn_count integer not null default 0,
  add column if not exists performance_metrics jsonb not null default '{}'::jsonb;

alter table public.opportunity_finder_jobs
  add constraint opportunity_finder_jobs_comparison_mode_check
    check (comparison_mode in ('single_file', 'two_files')),
  add constraint opportunity_finder_jobs_uploaded_role_check
    check (uploaded_role is null or uploaded_role in (
      'demand', 'stock', 'excess', 'supplier_offer', 'received_history',
      'purchase_history', 'quote_history', 'sales_history'
    )),
  add constraint opportunity_finder_jobs_opposite_role_check
    check (opposite_dataset_role is null or opposite_dataset_role in ('demand', 'stock')),
  add constraint opportunity_finder_jobs_dataset_version_check
    check (dataset_version is null or dataset_version ~ '^[0-9a-f]{64}$'),
  add constraint opportunity_finder_jobs_dataset_scope_check
    check (dataset_scope is null or dataset_scope in ('own', 'team', 'company')),
  add constraint opportunity_finder_jobs_snapshot_status_check
    check (snapshot_status in ('not_required', 'pending', 'ready', 'failed')),
  add constraint opportunity_finder_jobs_existing_counts_check
    check (existing_entity_count >= 0 and existing_mpn_count >= 0);

alter table public.opportunity_finder_files
  add column if not exists source_kind text not null default 'uploaded';

alter table public.opportunity_finder_files
  add constraint opportunity_finder_files_source_kind_check
    check (source_kind in ('uploaded', 'platform_snapshot'));

create table if not exists public.opportunity_finder_dataset_snapshots (
  id uuid primary key,
  job_id uuid not null unique references public.opportunity_finder_jobs(id) on delete cascade,
  tenant_id uuid not null references public.opportunity_finder_tenants(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  uploaded_role text not null check (uploaded_role in (
    'demand', 'stock', 'excess', 'supplier_offer', 'received_history',
    'purchase_history', 'quote_history', 'sales_history'
  )),
  opposite_dataset_role text not null check (opposite_dataset_role in ('demand', 'stock')),
  dataset_version text not null check (dataset_version ~ '^[0-9a-f]{64}$'),
  dataset_scope text not null check (dataset_scope in ('own', 'team', 'company')),
  manifest jsonb not null,
  entity_count integer not null default 0 check (entity_count >= 0),
  mpn_count integer not null default 0 check (mpn_count >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.opportunity_finder_dataset_snapshot_rows (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.opportunity_finder_dataset_snapshots(id) on delete cascade,
  job_id uuid not null references public.opportunity_finder_jobs(id) on delete cascade,
  virtual_file_id uuid not null references public.opportunity_finder_files(id) on delete cascade,
  role text not null check (role in ('demand', 'stock', 'excess', 'supplier_offer')),
  source_key text not null,
  source_upload_id uuid not null,
  source_data_version bigint not null check (source_data_version > 0),
  normalized_mpn text not null,
  display_mpn text not null,
  manufacturer text,
  customer_context text,
  supplier_context text,
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
  quality_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (snapshot_id, source_key)
);

alter table public.opportunity_finder_jobs
  add constraint opportunity_finder_jobs_dataset_snapshot_fk
    foreign key (dataset_snapshot_id)
    references public.opportunity_finder_dataset_snapshots(id)
    on delete set null
    deferrable initially deferred;

create index if not exists opportunity_finder_snapshot_rows_job_role_mpn_idx
  on public.opportunity_finder_dataset_snapshot_rows (job_id, role, normalized_mpn, id);
create index if not exists opportunity_finder_snapshots_tenant_owner_created_idx
  on public.opportunity_finder_dataset_snapshots (tenant_id, created_by, created_at desc);

alter table public.opportunity_finder_dataset_snapshots enable row level security;
alter table public.opportunity_finder_dataset_snapshots force row level security;
alter table public.opportunity_finder_dataset_snapshot_rows enable row level security;
alter table public.opportunity_finder_dataset_snapshot_rows force row level security;

create policy opportunity_finder_dataset_snapshots_owner_select
  on public.opportunity_finder_dataset_snapshots for select to authenticated
  using (
    tenant_id = auth.uid()
    and created_by = auth.uid()
    and exists (
      select 1 from public.opportunity_finder_jobs job
      where job.id = job_id
        and job.tenant_id = auth.uid()
        and job.created_by = auth.uid()
    )
  );

create policy opportunity_finder_dataset_snapshot_rows_owner_select
  on public.opportunity_finder_dataset_snapshot_rows for select to authenticated
  using (
    exists (
      select 1 from public.opportunity_finder_jobs job
      where job.id = job_id
        and job.tenant_id = auth.uid()
        and job.created_by = auth.uid()
    )
  );

revoke all on public.opportunity_finder_dataset_snapshots from public, anon, authenticated;
revoke all on public.opportunity_finder_dataset_snapshot_rows from public, anon, authenticated;
grant select on public.opportunity_finder_dataset_snapshots to authenticated;
grant select on public.opportunity_finder_dataset_snapshot_rows to authenticated;
grant select, insert, update, delete on public.opportunity_finder_dataset_snapshots to service_role;
grant select, insert, update, delete on public.opportunity_finder_dataset_snapshot_rows to service_role;

create or replace function public.confirm_opportunity_finder_single_file(
  job_id uuid,
  actor_id uuid,
  uploaded_file_id uuid,
  uploaded_role text,
  valid_until timestamptz default null
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_actor_id alias for $2;
  input_file_id alias for $3;
  input_role alias for $4;
  input_valid_until alias for $5;
  locked_job public.opportunity_finder_jobs%rowtype;
  uploaded_file public.opportunity_finder_files%rowtype;
  virtual_file public.opportunity_finder_files%rowtype;
  opposite_role text;
  updated_job public.opportunity_finder_jobs%rowtype;
begin
  if input_role not in (
    'demand', 'stock', 'excess', 'supplier_offer', 'received_history',
    'purchase_history', 'quote_history', 'sales_history'
  ) then
    raise exception using errcode = '22023', message = 'opportunity_single_role_invalid';
  end if;
  if input_role = 'supplier_offer' and (input_valid_until is null or input_valid_until <= now()) then
    raise exception using errcode = '22023', message = 'opportunity_offer_validity_required';
  end if;

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;
  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;
  if locked_job.comparison_mode <> 'single_file' or locked_job.status <> 'awaiting_roles' then
    raise exception using errcode = '55000', message = 'opportunity_job_not_awaiting_single_role';
  end if;

  select file.* into uploaded_file
  from public.opportunity_finder_files file
  where file.id = input_file_id and file.job_id = input_job_id and file.source_kind = 'uploaded'
  for update;
  if not found or uploaded_file.storage_deleted_at is not null then
    raise exception using errcode = '55000', message = 'opportunity_source_files_unavailable';
  end if;
  select file.* into virtual_file
  from public.opportunity_finder_files file
  where file.job_id = input_job_id and file.source_kind = 'platform_snapshot'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'opportunity_virtual_file_missing';
  end if;

  opposite_role := case when input_role = 'demand' then 'stock' else 'demand' end;
  update public.opportunity_finder_files
  set selected_role = input_role,
      validity_override_expires_at = case when input_role = 'supplier_offer' then input_valid_until else null end
  where id = uploaded_file.id;
  update public.opportunity_finder_files
  set selected_role = opposite_role,
      detected_type = opposite_role,
      parse_status = 'parsed'
  where id = virtual_file.id;

  update public.opportunity_finder_jobs job
  set file_a_id = uploaded_file.id,
      file_b_id = virtual_file.id,
      file_a_role = input_role,
      file_b_role = opposite_role,
      uploaded_role = input_role,
      opposite_dataset_role = opposite_role,
      snapshot_status = 'pending',
      status = 'queued',
      current_stage = 'normalizing_mpn',
      progress_percent = 27,
      attempts = 0,
      error_code = null,
      updated_at = now()
  where job.id = input_job_id
  returning job.* into updated_job;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id, input_job_id, input_actor_id,
    'single_file_role_confirmed', 'opportunity_finder_job', input_job_id,
    jsonb_build_object('uploadedRole', input_role, 'oppositeDatasetRole', opposite_role)
  );
  return updated_job;
end;
$$;

revoke all on function public.confirm_opportunity_finder_single_file(uuid,uuid,uuid,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.confirm_opportunity_finder_single_file(uuid,uuid,uuid,text,timestamptz)
  to service_role;

create or replace function public.get_opportunity_finder_uploaded_mpns(job_id uuid)
returns table(normalized_mpn text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select distinct row.normalized_mpn
  from public.opportunity_finder_jobs job
  join public.opportunity_finder_files file
    on file.job_id = job.id and file.source_kind = 'uploaded'
  join public.opportunity_finder_rows row
    on row.job_id = job.id and row.file_id = file.id
  where job.id = $1
    and job.comparison_mode = 'single_file'
    and job.created_by = auth.uid()
    and job.tenant_id = auth.uid()
    and row.normalized_mpn <> ''
  order by row.normalized_mpn;
$$;

revoke all on function public.get_opportunity_finder_uploaded_mpns(uuid)
  from public, anon;
grant execute on function public.get_opportunity_finder_uploaded_mpns(uuid)
  to authenticated;

create or replace function public.persist_opportunity_finder_dataset_snapshot(
  job_id uuid,
  actor_id uuid,
  snapshot_id uuid,
  dataset_version text,
  dataset_scope text,
  manifest jsonb,
  rows jsonb,
  idempotency_key text,
  lookup_metrics jsonb default '{}'::jsonb
)
returns table(committed_job_id uuid, reused boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_actor_id alias for $2;
  input_snapshot_id alias for $3;
  input_dataset_version alias for $4;
  input_dataset_scope alias for $5;
  input_manifest alias for $6;
  input_rows alias for $7;
  input_idempotency_key alias for $8;
  input_metrics alias for $9;
  locked_job public.opportunity_finder_jobs%rowtype;
  virtual_file_id uuid;
  existing_job_id uuid;
  row_count integer;
  mpn_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if input_dataset_version !~ '^[0-9a-f]{64}$'
     or input_dataset_scope not in ('own', 'team', 'company')
     or jsonb_typeof(input_manifest) <> 'array'
     or jsonb_typeof(input_rows) <> 'array'
     or input_idempotency_key is null then
    raise exception using errcode = '22023', message = 'opportunity_snapshot_payload_invalid';
  end if;

  select job.* into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;
  if not found or locked_job.created_by <> input_actor_id then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;
  if locked_job.comparison_mode <> 'single_file'
     or locked_job.status <> 'awaiting_roles'
     or locked_job.snapshot_status <> 'pending'
     or locked_job.dataset_version is distinct from input_dataset_version
     or locked_job.dataset_scope is distinct from input_dataset_scope
     or locked_job.dataset_manifest is distinct from input_manifest then
    raise exception using errcode = '40001', message = 'opportunity_snapshot_job_changed';
  end if;

  select job.id into existing_job_id
  from public.opportunity_finder_jobs job
  where job.tenant_id = locked_job.tenant_id
    and job.created_by = input_actor_id
    and job.idempotency_key = input_idempotency_key
    and job.id <> input_job_id
  order by job.created_at desc
  limit 1;
  if existing_job_id is not null then
    update public.opportunity_finder_jobs
    set status = 'cancelled', cancel_requested = true, cancelled_at = now(),
        error_code = 'COMPARISON_ALREADY_EXISTS', updated_at = now()
    where id = input_job_id;
    return query select existing_job_id, true;
    return;
  end if;

  select file.id into virtual_file_id
  from public.opportunity_finder_files file
  where file.job_id = input_job_id and file.source_kind = 'platform_snapshot'
  for update;
  if virtual_file_id is null then
    raise exception using errcode = '55000', message = 'opportunity_virtual_file_missing';
  end if;

  row_count := jsonb_array_length(input_rows);
  select count(distinct value->>'normalized_mpn')::integer into mpn_count
  from jsonb_array_elements(input_rows);
  insert into public.opportunity_finder_dataset_snapshots (
    id, job_id, tenant_id, created_by, uploaded_role, opposite_dataset_role,
    dataset_version, dataset_scope, manifest, entity_count, mpn_count
  ) values (
    input_snapshot_id, input_job_id, locked_job.tenant_id, input_actor_id,
    locked_job.uploaded_role, locked_job.opposite_dataset_role,
    input_dataset_version, input_dataset_scope, input_manifest, row_count, mpn_count
  );

  insert into public.opportunity_finder_dataset_snapshot_rows (
    snapshot_id, job_id, virtual_file_id, role, source_key, source_upload_id,
    source_data_version, normalized_mpn, display_mpn, manufacturer,
    customer_context, supplier_context, required_qty, available_qty, excess_qty,
    required_date, unit_of_measure, lead_time_weeks, moq, spq, date_code, coo,
    condition, expires_at, is_active_demand,
    is_live_supply, quality_flags
  )
  select
    input_snapshot_id, input_job_id, virtual_file_id,
    item->>'role', item->>'source_key', (item->>'source_upload_id')::uuid,
    (item->>'source_data_version')::bigint, item->>'normalized_mpn', item->>'display_mpn',
    nullif(item->>'manufacturer', ''), nullif(item->>'customer_context', ''),
    nullif(item->>'supplier_context', ''), nullif(item->>'required_qty', '')::numeric,
    nullif(item->>'available_qty', '')::numeric, nullif(item->>'excess_qty', '')::numeric,
    nullif(item->>'required_date', '')::date, nullif(item->>'unit_of_measure', ''),
    nullif(item->>'lead_time_weeks', '')::numeric,
    nullif(item->>'moq', '')::numeric, nullif(item->>'spq', '')::numeric,
    nullif(item->>'date_code', ''), nullif(item->>'coo', ''), nullif(item->>'condition', ''),
    nullif(item->>'expires_at', '')::timestamptz,
    coalesce((item->>'is_active_demand')::boolean, true),
    coalesce((item->>'is_live_supply')::boolean, true),
    coalesce(item->'quality_flags', '[]'::jsonb)
  from jsonb_array_elements(input_rows) item;

  -- The virtual descriptor has no Storage object. Marking it deleted prevents
  -- retention workers from ever attempting to remove a synthetic path.
  update public.opportunity_finder_files
  set storage_deleted_at = now()
  where id = virtual_file_id;

  update public.opportunity_finder_jobs
  set idempotency_key = input_idempotency_key,
      dataset_snapshot_id = input_snapshot_id,
      dataset_snapshot_at = now(),
      snapshot_status = 'ready',
      existing_entity_count = row_count,
      existing_mpn_count = mpn_count,
      performance_metrics = coalesce(performance_metrics, '{}'::jsonb) || input_metrics,
      status = 'queued', current_stage = 'finding_matches', progress_percent = 58,
      attempts = 0, error_code = null, next_retry_at = null,
      locked_at = null, locked_by = null, heartbeat_at = null, lock_token = null,
      updated_at = now()
  where id = input_job_id;

  insert into public.opportunity_finder_audit_events (
    tenant_id, job_id, actor_user_id, event_type, entity_type, entity_id, safe_metadata
  ) values (
    locked_job.tenant_id, input_job_id, input_actor_id,
    'single_file_dataset_snapshotted', 'opportunity_finder_dataset_snapshot', input_snapshot_id,
    jsonb_build_object('datasetVersion', input_dataset_version, 'entityCount', row_count, 'mpnCount', mpn_count)
  );
  return query select input_job_id, false;
end;
$$;

revoke all on function public.persist_opportunity_finder_dataset_snapshot(uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_opportunity_finder_dataset_snapshot(uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb)
  to service_role;

create or replace function public.record_opportunity_finder_performance(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  processing_fence bigint,
  metrics jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' or jsonb_typeof(metrics) <> 'object' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  update public.opportunity_finder_jobs job
  set performance_metrics = coalesce(job.performance_metrics, '{}'::jsonb) || metrics,
      updated_at = now()
  where job.id = $1
    and (
      (job.locked_by = $2 and job.lock_token = $3 and job.processing_fence = $4)
      or (job.committed_lock_token = $3 and job.committed_fence = $4)
    );
  if not found then
    raise exception using errcode = '40001', message = 'opportunity_performance_fence_lost';
  end if;
end;
$$;

revoke all on function public.record_opportunity_finder_performance(uuid,text,uuid,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_opportunity_finder_performance(uuid,text,uuid,bigint,jsonb)
  to service_role;

comment on column public.opportunity_finder_jobs.dataset_manifest is
  'Immutable RLS-authorized upload/version manifest captured when a one-file comparison is created.';
comment on table public.opportunity_finder_dataset_snapshot_rows is
  'Minimal immutable candidate universe; never stores raw_data or normalized_data payloads.';
