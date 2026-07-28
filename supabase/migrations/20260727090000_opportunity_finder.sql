-- Quiksol Phase 7.2: isolated two-file Opportunity Finder.
-- Review and apply separately. The application never executes this migration.

create table if not exists public.opportunity_finder_jobs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id),
  idempotency_key text,
  status text not null default 'uploading'
    check (status in (
      'uploading', 'queued', 'profiling', 'awaiting_roles', 'parsing',
      'matching', 'completed', 'completed_with_warnings', 'failed', 'cancelled'
    )),
  current_stage text not null default 'uploading'
    check (current_stage in (
      'uploading', 'inspecting_sheets', 'detecting_headers', 'confirming_roles',
      'normalizing_mpn', 'grouping_quantities', 'finding_matches',
      'generating_opportunities', 'completed'
    )),
  progress_percent numeric(5,2) not null default 0
    check (progress_percent >= 0 and progress_percent <= 100),
  file_a_id uuid,
  file_b_id uuid,
  file_a_role text,
  file_b_role text,
  total_rows_a int not null default 0,
  total_rows_b int not null default 0,
  processed_rows int not null default 0,
  matched_mpns int not null default 0,
  result_count int not null default 0,
  warning_count int not null default 0,
  missing_mpn_rows int not null default 0,
  invalid_quantity_rows int not null default 0,
  summary_json jsonb not null default '{}'::jsonb,
  error_code text,
  cancel_requested boolean not null default false,
  attempts int not null default 0,
  max_attempts int not null default 3,
  locked_at timestamptz,
  locked_by text,
  heartbeat_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  cancelled_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.opportunity_finder_files (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.opportunity_finder_jobs(id) on delete cascade,
  side text not null check (side in ('A', 'B')),
  original_file_name text not null,
  storage_bucket text not null default 'opportunity-finder',
  storage_path text not null,
  mime_type text,
  size_bytes bigint not null check (size_bytes > 0),
  detected_type text not null default 'unknown'
    check (detected_type in (
      'demand', 'stock', 'excess', 'supplier_offer', 'received_history',
      'sales_history', 'financial', 'unknown'
    )),
  selected_role text
    check (selected_role is null or selected_role in (
      'demand', 'stock', 'excess', 'supplier_offer', 'received_history',
      'sales_history', 'ignore'
    )),
  classification_score numeric not null default 0,
  classification_reasons jsonb not null default '[]'::jsonb,
  sheet_profiles jsonb not null default '[]'::jsonb,
  sheet_count int not null default 0,
  row_count int not null default 0,
  parse_status text not null default 'pending_upload'
    check (parse_status in (
      'pending_upload', 'uploaded', 'profiling', 'profiled',
      'parsing', 'parsed', 'failed', 'cancelled'
    )),
  uploaded_at timestamptz,
  profiled_at timestamptz,
  parsed_at timestamptz,
  file_expires_at timestamptz not null default (now() + interval '72 hours'),
  storage_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (job_id, side),
  unique (storage_bucket, storage_path)
);

alter table public.opportunity_finder_jobs
  drop constraint if exists opportunity_finder_jobs_file_a_fk;
alter table public.opportunity_finder_jobs
  add constraint opportunity_finder_jobs_file_a_fk
  foreign key (file_a_id) references public.opportunity_finder_files(id) on delete set null;

alter table public.opportunity_finder_jobs
  drop constraint if exists opportunity_finder_jobs_file_b_fk;
alter table public.opportunity_finder_jobs
  add constraint opportunity_finder_jobs_file_b_fk
  foreign key (file_b_id) references public.opportunity_finder_files(id) on delete set null;

create table if not exists public.opportunity_finder_rows (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.opportunity_finder_jobs(id) on delete cascade,
  file_id uuid not null references public.opportunity_finder_files(id) on delete cascade,
  side text not null check (side in ('A', 'B')),
  sheet_name text not null,
  source_row int not null,
  original_index int not null,
  record_role text not null
    check (record_role in (
      'demand', 'stock', 'excess', 'supplier_offer',
      'received_history', 'sales_history', 'ignore'
    )),
  raw_mpn text not null,
  display_mpn text not null,
  normalized_mpn text not null,
  review_key text not null,
  manufacturer text,
  customer_context text,
  supplier_context text,
  required_qty numeric,
  available_qty numeric,
  excess_qty numeric,
  required_date date,
  unit_of_measure text,
  quality_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (file_id, sheet_name, source_row)
);

create table if not exists public.opportunity_finder_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.opportunity_finder_jobs(id) on delete cascade,
  opportunity_type text not null
    check (opportunity_type in (
      'full_sale', 'partial_sale', 'sourcing_needed', 'excess_resale',
      'supplier_offer_match', 'supply_without_demand', 'historical_signal',
      'review_required'
    )),
  exact_match boolean not null default true,
  display_mpn text not null,
  normalized_mpn text not null,
  manufacturer text,
  customer_context text,
  supplier_context text,
  required_qty numeric,
  available_qty numeric,
  allocated_qty numeric,
  shortage_qty numeric,
  coverage_percent numeric,
  required_date date,
  unit_of_measure text,
  demand_file_id uuid references public.opportunity_finder_files(id) on delete set null,
  demand_file_name text,
  demand_sheet_name text,
  supply_file_id uuid references public.opportunity_finder_files(id) on delete set null,
  supply_file_name text,
  supply_sheet_name text,
  demand_source_rows int not null default 0,
  supply_source_rows int not null default 0,
  reason_code text not null,
  action_code text not null,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.opportunity_finder_possible_matches (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.opportunity_finder_jobs(id) on delete cascade,
  demand_display_mpn text not null,
  supply_display_mpn text not null,
  demand_normalized_mpn text not null,
  supply_normalized_mpn text not null,
  review_key text not null,
  demand_file_id uuid not null references public.opportunity_finder_files(id) on delete cascade,
  supply_file_id uuid not null references public.opportunity_finder_files(id) on delete cascade,
  reason_code text not null default 'symbol_variant',
  created_at timestamptz not null default now(),
  unique (job_id, demand_normalized_mpn, supply_normalized_mpn)
);

create index if not exists opportunity_finder_jobs_owner_created_idx
  on public.opportunity_finder_jobs (created_by, created_at desc);
create unique index if not exists opportunity_finder_jobs_owner_idempotency_uidx
  on public.opportunity_finder_jobs (created_by, idempotency_key)
  where idempotency_key is not null;
create index if not exists opportunity_finder_jobs_queue_idx
  on public.opportunity_finder_jobs (status, next_retry_at, created_at);
create index if not exists opportunity_finder_jobs_expiry_idx
  on public.opportunity_finder_jobs (expires_at);
create index if not exists opportunity_finder_files_job_idx
  on public.opportunity_finder_files (job_id, side);
create index if not exists opportunity_finder_files_expiry_idx
  on public.opportunity_finder_files (file_expires_at)
  where storage_deleted_at is null;
create index if not exists opportunity_finder_rows_job_mpn_idx
  on public.opportunity_finder_rows (job_id, normalized_mpn);
create index if not exists opportunity_finder_rows_job_role_mpn_date_idx
  on public.opportunity_finder_rows (
    job_id, record_role, normalized_mpn, required_date, original_index
  );
create index if not exists opportunity_finder_rows_job_review_idx
  on public.opportunity_finder_rows (job_id, review_key);
create index if not exists opportunity_finder_results_job_type_idx
  on public.opportunity_finder_results (job_id, opportunity_type, created_at);
create index if not exists opportunity_finder_results_job_mpn_idx
  on public.opportunity_finder_results (job_id, normalized_mpn);
create index if not exists opportunity_finder_possible_job_idx
  on public.opportunity_finder_possible_matches (job_id, review_key);

drop trigger if exists opportunity_finder_jobs_set_updated_at on public.opportunity_finder_jobs;
create trigger opportunity_finder_jobs_set_updated_at
before update on public.opportunity_finder_jobs
for each row execute function public.set_updated_at();

alter table public.opportunity_finder_jobs enable row level security;
alter table public.opportunity_finder_files enable row level security;
alter table public.opportunity_finder_rows enable row level security;
alter table public.opportunity_finder_results enable row level security;
alter table public.opportunity_finder_possible_matches enable row level security;

drop policy if exists opportunity_finder_jobs_select_own on public.opportunity_finder_jobs;
create policy opportunity_finder_jobs_select_own on public.opportunity_finder_jobs
for select using (created_by = auth.uid() and public.is_active_profile());

drop policy if exists opportunity_finder_jobs_insert_own on public.opportunity_finder_jobs;
create policy opportunity_finder_jobs_insert_own on public.opportunity_finder_jobs
for insert with check (created_by = auth.uid() and public.is_active_profile());

drop policy if exists opportunity_finder_jobs_update_own on public.opportunity_finder_jobs;
create policy opportunity_finder_jobs_update_own on public.opportunity_finder_jobs
for update using (created_by = auth.uid() and public.is_active_profile())
with check (created_by = auth.uid() and public.is_active_profile());

drop policy if exists opportunity_finder_jobs_delete_own on public.opportunity_finder_jobs;
create policy opportunity_finder_jobs_delete_own on public.opportunity_finder_jobs
for delete using (created_by = auth.uid() and public.is_active_profile());

drop policy if exists opportunity_finder_files_select_own on public.opportunity_finder_files;
create policy opportunity_finder_files_select_own on public.opportunity_finder_files
for select using (
  exists (
    select 1 from public.opportunity_finder_jobs job
    where job.id = job_id and job.created_by = auth.uid()
  )
);

drop policy if exists opportunity_finder_files_insert_own on public.opportunity_finder_files;
create policy opportunity_finder_files_insert_own on public.opportunity_finder_files
for insert with check (
  exists (
    select 1 from public.opportunity_finder_jobs job
    where job.id = job_id and job.created_by = auth.uid()
  )
);

drop policy if exists opportunity_finder_files_update_own on public.opportunity_finder_files;
create policy opportunity_finder_files_update_own on public.opportunity_finder_files
for update using (
  exists (
    select 1 from public.opportunity_finder_jobs job
    where job.id = job_id and job.created_by = auth.uid()
  )
) with check (
  exists (
    select 1 from public.opportunity_finder_jobs job
    where job.id = job_id and job.created_by = auth.uid()
  )
);

-- Canonical rows intentionally have no authenticated-user policy. Only the
-- service-role worker can read or write this temporary normalized staging data.

drop policy if exists opportunity_finder_results_select_own on public.opportunity_finder_results;
create policy opportunity_finder_results_select_own on public.opportunity_finder_results
for select using (
  exists (
    select 1 from public.opportunity_finder_jobs job
    where job.id = job_id and job.created_by = auth.uid()
  )
);

drop policy if exists opportunity_finder_possible_select_own on public.opportunity_finder_possible_matches;
create policy opportunity_finder_possible_select_own on public.opportunity_finder_possible_matches
for select using (
  exists (
    select 1 from public.opportunity_finder_jobs job
    where job.id = job_id and job.created_by = auth.uid()
  )
);

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
create policy opportunity_finder_storage_insert_own on storage.objects
for insert with check (
  bucket_id = 'opportunity-finder'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_active_profile()
);

drop policy if exists opportunity_finder_storage_delete_own on storage.objects;
create policy opportunity_finder_storage_delete_own on storage.objects
for delete using (
  bucket_id = 'opportunity-finder'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_active_profile()
);

create or replace function public.claim_opportunity_finder_job(
  worker_id_input text,
  stale_after interval default interval '30 minutes'
)
returns setof public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with recovered as (
    update public.opportunity_finder_jobs
    set
      status = case when attempts >= max_attempts then 'failed' else 'queued' end,
      error_code = case when attempts >= max_attempts then 'WORKER_HEARTBEAT_EXPIRED' else null end,
      locked_at = null,
      locked_by = null,
      next_retry_at = case when attempts >= max_attempts then null else now() end,
      updated_at = now()
    where status in ('profiling', 'parsing', 'matching')
      and coalesce(heartbeat_at, locked_at, updated_at) < now() - stale_after
    returning id
  ),
  next_job as (
    select id
    from public.opportunity_finder_jobs
    where status = 'queued'
      and attempts < max_attempts
      and cancel_requested = false
      and (next_retry_at is null or next_retry_at <= now())
    order by created_at asc
    for update skip locked
    limit 1
  )
  update public.opportunity_finder_jobs job
  set
    status = case
      when job.current_stage in ('inspecting_sheets', 'detecting_headers') then 'profiling'
      else 'parsing'
    end,
    attempts = job.attempts + 1,
    locked_at = now(),
    locked_by = worker_id_input,
    heartbeat_at = now(),
    started_at = coalesce(job.started_at, now()),
    error_code = null,
    updated_at = now()
  from next_job
  where job.id = next_job.id
  returning job.*;
end;
$$;

revoke all on function public.claim_opportunity_finder_job(text, interval) from public;
grant execute on function public.claim_opportunity_finder_job(text, interval) to service_role;
