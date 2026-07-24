-- Quiksol Phase 7.1: account clients and UUID upload assignments.
-- Review and apply separately. This migration is not executed by the application.

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  industry text,
  region text,
  website text,
  logo_path text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid not null references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.client_private_details (
  client_id uuid primary key references public.clients(id) on delete cascade,
  identification_image_path text,
  internal_notes text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_upload_assignments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  upload_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  assigned_by uuid not null references public.profiles(id),
  assigned_at timestamptz not null default now(),
  unique (upload_batch_id)
);

create index if not exists clients_status_name_idx
  on public.clients (status, name);

create index if not exists clients_created_by_idx
  on public.clients (created_by);

create index if not exists client_upload_assignments_client_idx
  on public.client_upload_assignments (client_id, assigned_at desc);

create index if not exists client_upload_assignments_upload_idx
  on public.client_upload_assignments (upload_batch_id);

drop trigger if exists clients_set_updated_at on public.clients;
create trigger clients_set_updated_at
before update on public.clients
for each row execute function public.set_updated_at();

create or replace function public.can_manage_clients()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('admin', 'manager')
      and is_active = true
  );
$$;

alter table public.clients enable row level security;
alter table public.client_private_details enable row level security;
alter table public.client_upload_assignments enable row level security;

drop policy if exists clients_select_authenticated on public.clients;
create policy clients_select_authenticated on public.clients
for select using (
  public.is_active_profile()
  and (archived_at is null or public.can_manage_clients())
);

drop policy if exists clients_insert_manager on public.clients;
create policy clients_insert_manager on public.clients
for insert with check (
  public.can_manage_clients()
  and created_by = auth.uid()
);

drop policy if exists clients_update_manager on public.clients;
create policy clients_update_manager on public.clients
for update using (public.can_manage_clients())
with check (public.can_manage_clients());

drop policy if exists client_private_details_select_manager on public.client_private_details;
create policy client_private_details_select_manager on public.client_private_details
for select using (public.can_manage_clients());

drop policy if exists client_private_details_insert_manager on public.client_private_details;
create policy client_private_details_insert_manager on public.client_private_details
for insert with check (public.can_manage_clients());

drop policy if exists client_private_details_update_manager on public.client_private_details;
create policy client_private_details_update_manager on public.client_private_details
for update using (public.can_manage_clients())
with check (public.can_manage_clients());

drop policy if exists client_upload_assignments_select_scoped on public.client_upload_assignments;
create policy client_upload_assignments_select_scoped on public.client_upload_assignments
for select using (
  public.is_active_profile()
  and exists (
    select 1
    from public.upload_batches batch
    where batch.id = upload_batch_id
      and batch.archived_at is null
      and public.can_read_upload(batch.uploaded_by)
  )
);

drop policy if exists client_upload_assignments_insert_manager on public.client_upload_assignments;
create policy client_upload_assignments_insert_manager on public.client_upload_assignments
for insert with check (
  public.can_manage_clients()
  and assigned_by = auth.uid()
  and exists (
    select 1
    from public.upload_batches batch
    where batch.id = upload_batch_id
      and batch.archived_at is null
      and public.can_read_upload(batch.uploaded_by)
  )
);

drop policy if exists client_upload_assignments_update_manager on public.client_upload_assignments;
create policy client_upload_assignments_update_manager on public.client_upload_assignments
for update using (
  public.can_manage_clients()
  and exists (
    select 1
    from public.upload_batches batch
    where batch.id = upload_batch_id
      and batch.archived_at is null
      and public.can_read_upload(batch.uploaded_by)
  )
)
with check (
  public.can_manage_clients()
  and exists (
    select 1
    from public.upload_batches batch
    where batch.id = upload_batch_id
      and batch.archived_at is null
      and public.can_read_upload(batch.uploaded_by)
  )
);

drop policy if exists client_upload_assignments_delete_manager on public.client_upload_assignments;
create policy client_upload_assignments_delete_manager on public.client_upload_assignments
for delete using (
  public.can_manage_clients()
  and exists (
    select 1
    from public.upload_batches batch
    where batch.id = upload_batch_id
      and batch.archived_at is null
      and public.can_read_upload(batch.uploaded_by)
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-assets',
  'client-assets',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists client_assets_select_allowed on storage.objects;
create policy client_assets_select_allowed on storage.objects
for select using (
  bucket_id = 'client-assets'
  and public.is_active_profile()
  and (
    (storage.foldername(name))[2] = 'logo'
    or public.can_manage_clients()
  )
);

drop policy if exists client_assets_insert_manager on storage.objects;
create policy client_assets_insert_manager on storage.objects
for insert with check (
  bucket_id = 'client-assets'
  and public.can_manage_clients()
);

drop policy if exists client_assets_update_manager on storage.objects;
create policy client_assets_update_manager on storage.objects
for update using (
  bucket_id = 'client-assets'
  and public.can_manage_clients()
)
with check (
  bucket_id = 'client-assets'
  and public.can_manage_clients()
);

drop policy if exists client_assets_delete_manager on storage.objects;
create policy client_assets_delete_manager on storage.objects
for delete using (
  bucket_id = 'client-assets'
  and public.can_manage_clients()
);
