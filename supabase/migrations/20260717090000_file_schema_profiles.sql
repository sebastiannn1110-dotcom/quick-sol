-- Structural file profiles for presentation-safe AI answers.
-- Stores column names, inferred types, mappings and counts only; no row values.

create table if not exists public.file_schema_profiles (
  id uuid primary key default gen_random_uuid(),
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  file_type text,
  sheet_count int not null default 0,
  row_count int not null default 0,
  column_count int not null default 0,
  columns_json jsonb not null default '[]'::jsonb,
  detected_template text not null default 'general',
  detected_mappings_json jsonb not null default '{}'::jsonb,
  data_quality_summary_json jsonb not null default '{}'::jsonb,
  warnings_json jsonb not null default '[]'::jsonb,
  confidence_score numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (upload_batch_id)
);

create index if not exists file_schema_profiles_upload_batch_idx
  on public.file_schema_profiles (upload_batch_id);

create index if not exists file_schema_profiles_template_idx
  on public.file_schema_profiles (detected_template);

drop trigger if exists file_schema_profiles_set_updated_at on public.file_schema_profiles;
create trigger file_schema_profiles_set_updated_at
before update on public.file_schema_profiles
for each row execute function public.set_updated_at();

alter table public.file_schema_profiles enable row level security;

drop policy if exists file_schema_profiles_select_allowed on public.file_schema_profiles;
create policy file_schema_profiles_select_allowed on public.file_schema_profiles
for select using (
  exists (
    select 1
    from public.upload_batches batch
    where batch.id = file_schema_profiles.upload_batch_id
      and public.can_read_upload(batch.uploaded_by)
  )
);

drop policy if exists file_schema_profiles_insert_allowed on public.file_schema_profiles;
create policy file_schema_profiles_insert_allowed on public.file_schema_profiles
for insert with check (
  exists (
    select 1
    from public.upload_batches batch
    where batch.id = file_schema_profiles.upload_batch_id
      and public.can_read_upload(batch.uploaded_by)
  )
);

drop policy if exists file_schema_profiles_update_allowed on public.file_schema_profiles;
create policy file_schema_profiles_update_allowed on public.file_schema_profiles
for update using (
  exists (
    select 1
    from public.upload_batches batch
    where batch.id = file_schema_profiles.upload_batch_id
      and public.can_read_upload(batch.uploaded_by)
  )
) with check (
  exists (
    select 1
    from public.upload_batches batch
    where batch.id = file_schema_profiles.upload_batch_id
      and public.can_read_upload(batch.uploaded_by)
  )
);
