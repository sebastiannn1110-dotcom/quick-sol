-- Background import jobs and progress tracking for large Excel/CSV uploads.

alter table public.upload_batches
  drop constraint if exists upload_batches_status_check;

alter table public.upload_batches
  add constraint upload_batches_status_check
  check (status in ('pending', 'pending_upload', 'uploading', 'uploaded', 'queued', 'processing', 'completed', 'failed', 'cancelled', 'archived'));

alter table public.upload_batches
  add column if not exists storage_bucket text default 'excel-uploads',
  add column if not exists upload_progress_percent numeric not null default 0,
  add column if not exists processing_progress_percent numeric not null default 0,
  add column if not exists processed_rows int not null default 0,
  add column if not exists successful_rows int not null default 0,
  add column if not exists failed_rows int not null default 0,
  add column if not exists error_message text,
  add column if not exists queued_at timestamptz,
  add column if not exists processing_started_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists idempotency_key text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'excel-uploads',
  'excel-uploads',
  false,
  null,
  array[
    'text/csv',
    'application/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  status text not null default 'pending_upload'
    check (status in ('pending_upload', 'uploaded', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
  storage_bucket text not null default 'excel-uploads',
  storage_path text not null,
  original_file_name text not null,
  mime_type text,
  size_bytes bigint,
  selected_category text,
  department text,
  region text,
  notes text,
  total_rows int not null default 0,
  processed_rows int not null default 0,
  successful_rows int not null default 0,
  failed_rows int not null default 0,
  progress_percent numeric not null default 0,
  error_message text,
  attempts int not null default 0,
  max_attempts int not null default 3,
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  finished_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.import_job_errors (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.import_jobs(id) on delete cascade,
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  row_number int,
  error_message text not null,
  raw_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists upload_batches_status_progress_idx
  on public.upload_batches (status, created_at desc);
create index if not exists upload_batches_idempotency_key_idx
  on public.upload_batches (idempotency_key) where idempotency_key is not null;
create unique index if not exists upload_batches_owner_idempotency_key_uidx
  on public.upload_batches (uploaded_by, idempotency_key)
  where idempotency_key is not null and archived_at is null;
create index if not exists import_jobs_status_created_idx
  on public.import_jobs (status, created_at);
create index if not exists import_jobs_upload_batch_idx
  on public.import_jobs (upload_batch_id);
create index if not exists import_job_errors_job_idx
  on public.import_job_errors (job_id);

drop policy if exists upload_batches_update_admin_or_owner_processing on public.upload_batches;
create policy upload_batches_update_admin_or_owner_processing on public.upload_batches
for update using (
  public.is_admin()
  or (uploaded_by = auth.uid() and status in ('pending', 'pending_upload', 'uploading', 'uploaded', 'queued', 'processing', 'failed', 'cancelled'))
) with check (
  public.is_admin()
  or (uploaded_by = auth.uid() and uploaded_by = auth.uid() and status <> 'archived')
);

alter table public.import_jobs enable row level security;
alter table public.import_job_errors enable row level security;

drop policy if exists import_jobs_select_allowed on public.import_jobs;
create policy import_jobs_select_allowed on public.import_jobs
for select using (public.is_admin() or uploaded_by = auth.uid());

drop policy if exists import_jobs_insert_own on public.import_jobs;
create policy import_jobs_insert_own on public.import_jobs
for insert with check (uploaded_by = auth.uid() or public.is_admin());

drop policy if exists import_jobs_update_owner_or_admin on public.import_jobs;
create policy import_jobs_update_owner_or_admin on public.import_jobs
for update using (public.is_admin() or uploaded_by = auth.uid())
with check (public.is_admin() or uploaded_by = auth.uid());

drop policy if exists import_job_errors_select_allowed on public.import_job_errors;
create policy import_job_errors_select_allowed on public.import_job_errors
for select using (
  public.is_admin()
  or exists (
    select 1 from public.import_jobs job
    where job.id = import_job_errors.job_id
      and job.uploaded_by = auth.uid()
  )
);

drop policy if exists import_job_errors_insert_owner_or_admin on public.import_job_errors;
create policy import_job_errors_insert_owner_or_admin on public.import_job_errors
for insert with check (
  public.is_admin()
  or exists (
    select 1 from public.import_jobs job
    where job.id = import_job_errors.job_id
      and job.uploaded_by = auth.uid()
  )
);
