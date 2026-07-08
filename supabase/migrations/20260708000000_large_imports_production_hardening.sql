-- Production hardening for large imports: resumable upload metadata, safe worker
-- locking, retry visibility, stale recovery, and search indexes.

alter table public.upload_batches
  drop constraint if exists upload_batches_status_check;

alter table public.upload_batches
  add constraint upload_batches_status_check
  check (status in ('pending', 'pending_upload', 'uploading', 'uploaded', 'queued', 'retrying', 'processing', 'completed', 'failed', 'cancelled', 'archived'));

alter table public.upload_batches
  add column if not exists upload_strategy text not null default 'standard'
    check (upload_strategy in ('standard', 'resumable')),
  add column if not exists upload_speed_bps bigint,
  add column if not exists upload_eta_seconds int,
  add column if not exists worker_last_heartbeat_at timestamptz;

alter table public.import_jobs
  drop constraint if exists import_jobs_status_check;

alter table public.import_jobs
  add constraint import_jobs_status_check
  check (status in ('pending_upload', 'uploaded', 'queued', 'retrying', 'processing', 'completed', 'failed', 'cancelled'));

alter table public.import_jobs
  add column if not exists heartbeat_at timestamptz,
  add column if not exists next_retry_at timestamptz,
  add column if not exists last_error text,
  add column if not exists worker_id text,
  add column if not exists cancel_requested boolean not null default false,
  add column if not exists upload_strategy text not null default 'standard'
    check (upload_strategy in ('standard', 'resumable')),
  add column if not exists duration_ms bigint;

create index if not exists upload_batches_upload_batch_id_idx
  on public.business_records (upload_batch_id);
create index if not exists business_records_status_created_idx
  on public.upload_batches (status, created_at desc);
create index if not exists import_jobs_retry_idx
  on public.import_jobs (status, next_retry_at, created_at);
create index if not exists import_jobs_heartbeat_idx
  on public.import_jobs (status, heartbeat_at);
create index if not exists business_records_mpn_created_idx
  on public.business_records (mpn, created_at desc);
create index if not exists business_records_supplier_created_idx
  on public.business_records (supplier, created_at desc);
create index if not exists business_records_customer_created_idx
  on public.business_records (customer, created_at desc);
create index if not exists business_records_category_created_idx
  on public.business_records (category, created_at desc);
create index if not exists business_records_uploaded_batch_idx
  on public.business_records (uploaded_by, upload_batch_id);

create or replace function public.claim_import_job(worker_id_input text, stale_after interval default interval '30 minutes')
returns setof public.import_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with recovered as (
    update public.import_jobs
    set
      status = case when attempts + 1 >= max_attempts then 'failed' else 'queued' end,
      last_error = coalesce(last_error, error_message, 'Recovered stale processing job.'),
      error_message = case when attempts + 1 >= max_attempts then coalesce(error_message, 'Worker heartbeat expired.') else null end,
      locked_at = null,
      locked_by = null,
      worker_id = null,
      next_retry_at = case when attempts + 1 >= max_attempts then next_retry_at else now() end,
      finished_at = case when attempts + 1 >= max_attempts then now() else finished_at end,
      updated_at = now()
    where status = 'processing'
      and coalesce(heartbeat_at, locked_at, updated_at) < now() - stale_after
    returning id
  ),
  next_job as (
    select id
    from public.import_jobs
    where status in ('queued', 'retrying')
      and attempts < max_attempts
      and (next_retry_at is null or next_retry_at <= now())
    order by created_at asc
    for update skip locked
    limit 1
  )
  update public.import_jobs job
  set
    status = 'processing',
    attempts = job.attempts + 1,
    locked_at = now(),
    locked_by = worker_id_input,
    worker_id = worker_id_input,
    heartbeat_at = now(),
    started_at = coalesce(job.started_at, now()),
    error_message = null,
    updated_at = now()
  from next_job
  where job.id = next_job.id
  returning job.*;
end;
$$;

revoke all on function public.claim_import_job(text, interval) from public;
grant execute on function public.claim_import_job(text, interval) to service_role;
