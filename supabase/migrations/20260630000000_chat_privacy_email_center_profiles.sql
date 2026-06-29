-- Chat privacy hardening, employee profile fields and manual email attachments.

alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists job_title text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_bio_length'
  ) then
    alter table public.profiles
      add constraint profiles_bio_length check (bio is null or char_length(bio) <= 500) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_job_title_length'
  ) then
    alter table public.profiles
      add constraint profiles_job_title_length check (job_title is null or char_length(job_title) <= 120) not valid;
  end if;
end;
$$;

create index if not exists profiles_job_title_idx on public.profiles (job_title);

create or replace function public.update_my_profile_public(new_bio text, new_job_title text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_profile public.profiles;
begin
  if not public.is_active_profile() then
    raise exception 'inactive_user';
  end if;

  if new_bio is not null and char_length(new_bio) > 500 then
    raise exception 'bio_too_long';
  end if;

  if new_job_title is not null and char_length(new_job_title) > 120 then
    raise exception 'job_title_too_long';
  end if;

  update public.profiles
  set
    bio = nullif(trim(new_bio), ''),
    job_title = nullif(trim(new_job_title), ''),
    updated_at = now()
  where id = auth.uid()
  returning * into updated_profile;

  return updated_profile;
end;
$$;

revoke all on function public.update_my_profile_public(text, text) from public;
grant execute on function public.update_my_profile_public(text, text) to authenticated;

create or replace function public.list_employee_directory(search_text text default null)
returns table (
  id uuid,
  full_name text,
  email text,
  role text,
  department text,
  region text,
  avatar_path text,
  bio text,
  job_title text,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select profile.id, profile.full_name, profile.email, profile.role,
         profile.department, profile.region, profile.avatar_path,
         profile.bio, profile.job_title, profile.is_active,
         profile.created_at, profile.updated_at
  from public.profiles profile
  where profile.is_active = true
    and public.is_active_profile()
    and (
      nullif(trim(search_text), '') is null
      or profile.full_name ilike '%' || trim(search_text) || '%'
      or profile.email ilike '%' || trim(search_text) || '%'
      or coalesce(profile.department, '') ilike '%' || trim(search_text) || '%'
      or coalesce(profile.region, '') ilike '%' || trim(search_text) || '%'
      or coalesce(profile.job_title, '') ilike '%' || trim(search_text) || '%'
    )
  order by profile.full_name
  limit 500;
$$;

revoke all on function public.list_employee_directory(text) from public;
grant execute on function public.list_employee_directory(text) to authenticated;

drop function if exists public.list_chat_users(text);
create function public.list_chat_users(search_text text default null)
returns table (
  id uuid,
  full_name text,
  email text,
  role text,
  department text,
  region text,
  avatar_path text,
  bio text,
  job_title text
)
language sql
stable
security definer
set search_path = public
as $$
  select profile.id, profile.full_name, profile.email, profile.role,
         profile.department, profile.region, profile.avatar_path,
         profile.bio, profile.job_title
  from public.profiles profile
  where profile.is_active = true
    and public.is_active_profile()
    and (
      nullif(trim(search_text), '') is null
      or profile.full_name ilike '%' || trim(search_text) || '%'
      or profile.email ilike '%' || trim(search_text) || '%'
      or coalesce(profile.department, '') ilike '%' || trim(search_text) || '%'
      or coalesce(profile.region, '') ilike '%' || trim(search_text) || '%'
      or coalesce(profile.job_title, '') ilike '%' || trim(search_text) || '%'
    )
  order by profile.full_name
  limit 100;
$$;

revoke all on function public.list_chat_users(text) from public;
grant execute on function public.list_chat_users(text) to authenticated;

-- Keep normal chat private. Admin audit uses service role through /admin/chat-audit,
-- so normal RLS does not expose every conversation inside /chat.
drop policy if exists chat_conversations_select_member on public.chat_conversations;
create policy chat_conversations_select_member on public.chat_conversations
for select using (public.is_conversation_member(id));

drop policy if exists chat_members_select_member on public.chat_conversation_members;
create policy chat_members_select_member on public.chat_conversation_members
for select using (public.is_conversation_member(conversation_id));

drop policy if exists chat_messages_select_member on public.chat_messages;
create policy chat_messages_select_member on public.chat_messages
for select using (public.is_conversation_member(conversation_id));

drop policy if exists chat_attachments_select_member on public.chat_attachments;
create policy chat_attachments_select_member on public.chat_attachments
for select using (
  exists (
    select 1 from public.chat_messages message
    where message.id = message_id
      and public.is_conversation_member(message.conversation_id)
  )
);

create table if not exists public.admin_email_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.admin_email_messages(id) on delete cascade,
  file_name text not null,
  file_path text not null,
  file_type text not null,
  file_size bigint not null,
  storage_bucket text not null default 'email-attachments',
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists admin_email_attachments_message_idx
  on public.admin_email_attachments (message_id);
create index if not exists admin_email_attachments_uploaded_by_idx
  on public.admin_email_attachments (uploaded_by, created_at desc);

alter table public.admin_email_attachments enable row level security;

drop policy if exists admin_email_attachments_select_admin on public.admin_email_attachments;
create policy admin_email_attachments_select_admin on public.admin_email_attachments
for select using (public.is_admin());

drop policy if exists admin_email_attachments_insert_admin on public.admin_email_attachments;
create policy admin_email_attachments_insert_admin on public.admin_email_attachments
for insert with check (public.is_admin());

drop policy if exists admin_email_attachments_delete_admin on public.admin_email_attachments;
create policy admin_email_attachments_delete_admin on public.admin_email_attachments
for delete using (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'email-attachments',
  'email-attachments',
  false,
  26214400,
  array[
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists email_attachments_storage_select_admin on storage.objects;
create policy email_attachments_storage_select_admin on storage.objects
for select using (
  bucket_id = 'email-attachments'
  and public.is_admin()
);

drop policy if exists email_attachments_storage_insert_admin on storage.objects;
create policy email_attachments_storage_insert_admin on storage.objects
for insert with check (
  bucket_id = 'email-attachments'
  and public.is_admin()
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists email_attachments_storage_delete_admin on storage.objects;
create policy email_attachments_storage_delete_admin on storage.objects
for delete using (
  bucket_id = 'email-attachments'
  and public.is_admin()
);
