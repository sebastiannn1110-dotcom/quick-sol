-- Quiksol Data Intelligence Platform
-- Run this migration in Supabase SQL editor or through Supabase CLI.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  role text not null default 'employee' check (role in ('admin', 'manager', 'employee')),
  department text,
  region text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.upload_batches (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references public.profiles(id),
  original_file_name text not null,
  stored_file_path text,
  file_type text,
  file_size bigint,
  selected_category text,
  detected_category text,
  status text not null default 'pending' check (status in ('pending', 'uploading', 'processing', 'completed', 'failed', 'archived')),
  total_sheets int not null default 0,
  total_rows int not null default 0,
  valid_rows int not null default 0,
  invalid_rows int not null default 0,
  error_count int not null default 0,
  data_quality_score numeric,
  notes text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  archived_at timestamptz
);

create table if not exists public.upload_sheets (
  id uuid primary key default gen_random_uuid(),
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  sheet_name text,
  detected_header_row int,
  total_rows int not null default 0,
  valid_rows int not null default 0,
  invalid_rows int not null default 0,
  detected_category text,
  created_at timestamptz not null default now()
);

create table if not exists public.business_records (
  id uuid primary key default gen_random_uuid(),
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  upload_sheet_id uuid references public.upload_sheets(id) on delete set null,
  uploaded_by uuid not null references public.profiles(id),
  category text,
  row_index int,
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  searchable_text text,
  has_errors boolean not null default false,
  errors jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  line_id text,
  client text,
  customer text,
  supplier text,
  supplier_name text,
  mpn text,
  mpn_quoted text,
  manufacturer text,
  clean_mfg text,
  description text,
  generic text,
  po text,
  qty numeric,
  req_qty numeric,
  cost numeric,
  price numeric,
  total_price numeric,
  gp_rate numeric,
  gp numeric,
  commission numeric,
  potential_amount_usd numeric,
  target_to_vendor numeric,
  best_price_offered numeric,
  date_code text,
  moq numeric,
  spq numeric,
  on_hand numeric,
  lead_time_weeks numeric,
  transit_time_weeks numeric,
  earliest_shipping_date date,
  shipping_point_country text,
  delivery_point text,
  comments text
);

create table if not exists public.import_errors (
  id uuid primary key default gen_random_uuid(),
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  upload_sheet_id uuid references public.upload_sheets(id) on delete cascade,
  business_record_id uuid references public.business_records(id) on delete set null,
  row_index int,
  column_name text,
  error_type text,
  message text,
  raw_value text,
  severity text check (severity in ('low', 'medium', 'high', 'critical')),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  actor_email text,
  action text not null,
  entity_type text,
  entity_id uuid,
  ip_address text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.security_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  event_type text not null,
  severity text check (severity in ('low', 'medium', 'high', 'critical')),
  route text,
  ip_address text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_department_idx on public.profiles(department);
create index if not exists profiles_region_idx on public.profiles(region);
create index if not exists upload_batches_uploaded_by_idx on public.upload_batches(uploaded_by);
create index if not exists upload_batches_status_idx on public.upload_batches(status);
create index if not exists upload_batches_created_at_idx on public.upload_batches(created_at desc);
create index if not exists upload_sheets_batch_idx on public.upload_sheets(upload_batch_id);
create index if not exists business_records_uploaded_by_idx on public.business_records(uploaded_by);
create index if not exists business_records_category_idx on public.business_records(category);
create index if not exists business_records_customer_idx on public.business_records(customer);
create index if not exists business_records_supplier_idx on public.business_records(supplier);
create index if not exists business_records_mpn_idx on public.business_records(mpn);
create index if not exists business_records_manufacturer_idx on public.business_records(manufacturer);
create index if not exists business_records_po_idx on public.business_records(po);
create index if not exists business_records_created_at_idx on public.business_records(created_at desc);
create index if not exists business_records_has_errors_idx on public.business_records(has_errors);
create index if not exists business_records_searchable_text_idx on public.business_records using gin(to_tsvector('simple', coalesce(searchable_text, '')));
create index if not exists import_errors_upload_batch_idx on public.import_errors(upload_batch_id);
create index if not exists audit_logs_actor_id_idx on public.audit_logs(actor_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);
create index if not exists security_events_severity_idx on public.security_events(severity);
create index if not exists security_events_created_at_idx on public.security_events(created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role, department, region)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1), 'Quiksol User'),
    coalesce(new.email, ''),
    coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'employee'),
    new.raw_user_meta_data->>'department',
    new.raw_user_meta_data->>'region'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and is_active = true;
$$;

create or replace function public.current_profile_department()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select department from public.profiles where id = auth.uid() and is_active = true;
$$;

create or replace function public.current_profile_region()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select region from public.profiles where id = auth.uid() and is_active = true;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active = true
  );
$$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'manager' and is_active = true
  );
$$;

create or replace function public.is_active_profile()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active = true
  );
$$;

create or replace function public.can_read_profile(target_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or target_id = auth.uid()
    or (
      public.is_manager()
      and exists (
        select 1
        from public.profiles target
        where target.id = target_id
          and (
            target.department = public.current_profile_department()
            or target.region = public.current_profile_region()
          )
      )
    );
$$;

create or replace function public.can_read_upload(upload_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or upload_owner = auth.uid()
    or (
      public.is_manager()
      and exists (
        select 1
        from public.profiles target
        where target.id = upload_owner
          and (
            target.department = public.current_profile_department()
            or target.region = public.current_profile_region()
          )
      )
    );
$$;

alter table public.profiles enable row level security;
alter table public.upload_batches enable row level security;
alter table public.upload_sheets enable row level security;
alter table public.business_records enable row level security;
alter table public.import_errors enable row level security;
alter table public.audit_logs enable row level security;
alter table public.security_events enable row level security;

drop policy if exists profiles_select_allowed on public.profiles;
create policy profiles_select_allowed on public.profiles
for select using (public.can_read_profile(id));

drop policy if exists profiles_insert_admin on public.profiles;
create policy profiles_insert_admin on public.profiles
for insert with check (public.is_admin());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists upload_batches_select_allowed on public.upload_batches;
create policy upload_batches_select_allowed on public.upload_batches
for select using (public.can_read_upload(uploaded_by));

drop policy if exists upload_batches_insert_own on public.upload_batches;
create policy upload_batches_insert_own on public.upload_batches
for insert with check (uploaded_by = auth.uid() and public.is_active_profile());

drop policy if exists upload_batches_update_admin_or_owner_processing on public.upload_batches;
create policy upload_batches_update_admin_or_owner_processing on public.upload_batches
for update using (
  public.is_admin()
  or (uploaded_by = auth.uid() and status in ('pending', 'uploading', 'processing', 'failed'))
) with check (
  public.is_admin()
  or (uploaded_by = auth.uid() and uploaded_by = auth.uid() and status <> 'archived')
);

drop policy if exists upload_sheets_select_allowed on public.upload_sheets;
create policy upload_sheets_select_allowed on public.upload_sheets
for select using (
  exists (
    select 1 from public.upload_batches b
    where b.id = upload_batch_id and public.can_read_upload(b.uploaded_by)
  )
);

drop policy if exists upload_sheets_insert_owner on public.upload_sheets;
create policy upload_sheets_insert_owner on public.upload_sheets
for insert with check (
  exists (
    select 1 from public.upload_batches b
    where b.id = upload_batch_id and b.uploaded_by = auth.uid() and public.is_active_profile()
  )
);

drop policy if exists business_records_select_allowed on public.business_records;
create policy business_records_select_allowed on public.business_records
for select using (public.can_read_upload(uploaded_by));

drop policy if exists business_records_insert_own on public.business_records;
create policy business_records_insert_own on public.business_records
for insert with check (uploaded_by = auth.uid() and public.is_active_profile());

drop policy if exists business_records_update_admin_archive on public.business_records;
create policy business_records_update_admin_archive on public.business_records
for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists import_errors_select_allowed on public.import_errors;
create policy import_errors_select_allowed on public.import_errors
for select using (
  exists (
    select 1 from public.upload_batches b
    where b.id = upload_batch_id and public.can_read_upload(b.uploaded_by)
  )
);

drop policy if exists import_errors_insert_owner on public.import_errors;
create policy import_errors_insert_owner on public.import_errors
for insert with check (
  exists (
    select 1 from public.upload_batches b
    where b.id = upload_batch_id and b.uploaded_by = auth.uid() and public.is_active_profile()
  )
);

drop policy if exists audit_logs_select_admin on public.audit_logs;
create policy audit_logs_select_admin on public.audit_logs
for select using (public.is_admin());

drop policy if exists security_events_select_admin on public.security_events;
create policy security_events_select_admin on public.security_events
for select using (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'excel-uploads',
  'excel-uploads',
  false,
  52428800,
  array[
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists excel_uploads_select_own_or_admin on storage.objects;
create policy excel_uploads_select_own_or_admin on storage.objects
for select using (
  bucket_id = 'excel-uploads'
  and (
    public.is_admin()
    or (auth.uid()::text = (storage.foldername(name))[1])
  )
);

drop policy if exists excel_uploads_insert_own_folder on storage.objects;
create policy excel_uploads_insert_own_folder on storage.objects
for insert with check (
  bucket_id = 'excel-uploads'
  and auth.uid()::text = (storage.foldername(name))[1]
  and public.is_active_profile()
);

drop policy if exists excel_uploads_update_admin on storage.objects;
create policy excel_uploads_update_admin on storage.objects
for update using (bucket_id = 'excel-uploads' and public.is_admin())
with check (bucket_id = 'excel-uploads' and public.is_admin());

drop policy if exists excel_uploads_delete_admin on storage.objects;
create policy excel_uploads_delete_admin on storage.objects
for delete using (bucket_id = 'excel-uploads' and public.is_admin());
