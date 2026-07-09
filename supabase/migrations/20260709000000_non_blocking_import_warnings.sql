-- Treat row-level data issues as warnings, keep imports moving, and store
-- capped enterprise diagnostics for large files.

alter table public.upload_batches
  drop constraint if exists upload_batches_status_check;

alter table public.upload_batches
  add constraint upload_batches_status_check
  check (status in ('pending', 'pending_upload', 'uploading', 'uploaded', 'queued', 'retrying', 'processing', 'completed', 'completed_with_warnings', 'failed', 'cancelled', 'archived'));

alter table public.upload_batches
  add column if not exists warning_count int not null default 0,
  add column if not exists rows_with_warnings int not null default 0,
  add column if not exists technical_error_count int not null default 0,
  add column if not exists suppressed_error_count int not null default 0;

alter table public.import_jobs
  drop constraint if exists import_jobs_status_check;

alter table public.import_jobs
  add constraint import_jobs_status_check
  check (status in ('pending_upload', 'uploaded', 'queued', 'retrying', 'processing', 'completed', 'completed_with_warnings', 'failed', 'cancelled'));

alter table public.import_jobs
  add column if not exists warning_count int not null default 0,
  add column if not exists rows_with_warnings int not null default 0,
  add column if not exists technical_error_count int not null default 0,
  add column if not exists suppressed_error_count int not null default 0;

create table if not exists public.import_job_error_summary (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.import_jobs(id) on delete cascade,
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  error_type text not null,
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  message text not null,
  occurrence_count int not null default 0,
  sample_row_number int,
  sample_raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, error_type, severity, message)
);

create index if not exists import_job_error_summary_job_idx
  on public.import_job_error_summary (job_id);

alter table public.import_job_error_summary enable row level security;

drop policy if exists import_job_error_summary_select_allowed on public.import_job_error_summary;
create policy import_job_error_summary_select_allowed on public.import_job_error_summary
for select using (
  public.is_admin()
  or exists (
    select 1 from public.import_jobs job
    where job.id = import_job_error_summary.job_id
      and job.uploaded_by = auth.uid()
  )
);

drop policy if exists import_job_error_summary_insert_owner_or_admin on public.import_job_error_summary;
create policy import_job_error_summary_insert_owner_or_admin on public.import_job_error_summary
for insert with check (
  public.is_admin()
  or exists (
    select 1 from public.import_jobs job
    where job.id = import_job_error_summary.job_id
      and job.uploaded_by = auth.uid()
  )
);

drop policy if exists upload_batches_update_admin_or_owner_processing on public.upload_batches;
create policy upload_batches_update_admin_or_owner_processing on public.upload_batches
for update using (
  public.is_admin()
  or (uploaded_by = auth.uid() and status in ('pending', 'pending_upload', 'uploading', 'uploaded', 'queued', 'processing', 'completed_with_warnings', 'failed', 'cancelled'))
) with check (
  public.is_admin()
  or (uploaded_by = auth.uid() and status <> 'archived')
);
