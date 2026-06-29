-- Quiksol enterprise MVP hardening: password recovery, admin email center,
-- internal chat, avatars, persistent rate limits and performance indexes.
-- This migration is idempotent and is intended to run after the existing
-- platform, observability and email-alert migrations.

create extension if not exists pgcrypto;

alter table public.profiles add column if not exists avatar_path text;

create table if not exists public.password_reset_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  code_hash text not null,
  verification_token_hash text,
  expires_at timestamptz not null,
  verified_at timestamptz,
  used_at timestamptz,
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 5 check (max_attempts between 1 and 10),
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists password_reset_codes_email_created_idx
  on public.password_reset_codes (lower(email), created_at desc);
create index if not exists password_reset_codes_expires_idx
  on public.password_reset_codes (expires_at);
alter table public.password_reset_codes enable row level security;
-- No client policies: password recovery data is server/service-role only.

create table if not exists public.api_rate_limits (
  key_hash text primary key,
  action text not null,
  request_count int not null default 0,
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists api_rate_limits_updated_idx
  on public.api_rate_limits (updated_at);
alter table public.api_rate_limits enable row level security;
-- No client policies: rate-limit state is server/service-role only.

create or replace function public.consume_api_rate_limit(
  input_key_hash text,
  input_action text,
  input_limit int,
  input_window_seconds int,
  input_block_seconds int default 60
)
returns table (allowed boolean, remaining int, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.api_rate_limits%rowtype;
  current_time timestamptz := now();
begin
  if input_limit < 1 or input_window_seconds < 1 or length(input_key_hash) < 16 then
    raise exception 'invalid_rate_limit_parameters';
  end if;

  select * into current_row
  from public.api_rate_limits
  where key_hash = input_key_hash
  for update;

  if not found then
    insert into public.api_rate_limits (key_hash, action, request_count, window_started_at, updated_at)
    values (input_key_hash, input_action, 1, current_time, current_time);
    return query select true, greatest(input_limit - 1, 0), current_time + make_interval(secs => input_window_seconds);
    return;
  end if;

  if current_row.blocked_until is not null and current_row.blocked_until > current_time then
    return query select false, 0, current_row.blocked_until;
    return;
  end if;

  if current_row.window_started_at + make_interval(secs => input_window_seconds) <= current_time then
    update public.api_rate_limits
    set action = input_action,
        request_count = 1,
        window_started_at = current_time,
        blocked_until = null,
        updated_at = current_time
    where key_hash = input_key_hash;
    return query select true, greatest(input_limit - 1, 0), current_time + make_interval(secs => input_window_seconds);
    return;
  end if;

  if current_row.request_count >= input_limit then
    update public.api_rate_limits
    set blocked_until = greatest(
          coalesce(blocked_until, current_time),
          current_time + make_interval(secs => greatest(input_block_seconds, 1))
        ),
        updated_at = current_time
    where key_hash = input_key_hash
    returning blocked_until into current_row.blocked_until;
    return query select false, 0, current_row.blocked_until;
    return;
  end if;

  update public.api_rate_limits
  set request_count = request_count + 1,
      action = input_action,
      updated_at = current_time
  where key_hash = input_key_hash
  returning request_count into current_row.request_count;

  return query select
    true,
    greatest(input_limit - current_row.request_count, 0),
    current_row.window_started_at + make_interval(secs => input_window_seconds);
end;
$$;

revoke all on function public.consume_api_rate_limit(text, text, int, int, int) from public;
grant execute on function public.consume_api_rate_limit(text, text, int, int, int) to service_role;

create table if not exists public.admin_email_messages (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  body text not null,
  sender_user_id uuid references public.profiles(id) on delete set null,
  recipients jsonb not null default '[]'::jsonb,
  recipient_count int not null default 0,
  status text not null default 'pending' check (status in ('sent', 'failed', 'pending', 'skipped')),
  provider text,
  provider_message_id text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists admin_email_messages_sender_idx
  on public.admin_email_messages (sender_user_id, created_at desc);
create index if not exists admin_email_messages_status_idx
  on public.admin_email_messages (status, created_at desc);

alter table public.admin_email_messages enable row level security;

drop policy if exists admin_email_messages_select_admin on public.admin_email_messages;
create policy admin_email_messages_select_admin on public.admin_email_messages
for select using (public.is_admin());

drop policy if exists admin_email_messages_insert_admin on public.admin_email_messages;
create policy admin_email_messages_insert_admin on public.admin_email_messages
for insert with check (public.is_admin() and sender_user_id = auth.uid());

drop policy if exists admin_email_messages_update_admin on public.admin_email_messages;
create policy admin_email_messages_update_admin on public.admin_email_messages
for update using (public.is_admin()) with check (public.is_admin());

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('direct', 'group', 'all_company')),
  name text,
  description text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists chat_single_all_company_idx
  on public.chat_conversations (type) where type = 'all_company';
create index if not exists chat_conversations_updated_idx
  on public.chat_conversations (updated_at desc);

create table if not exists public.chat_conversation_members (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  unique (conversation_id, user_id)
);

create index if not exists chat_members_user_idx
  on public.chat_conversation_members (user_id, conversation_id);
create index if not exists chat_members_conversation_idx
  on public.chat_conversation_members (conversation_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  body text,
  message_type text not null default 'text' check (message_type in ('text', 'file', 'record_reference', 'upload_reference', 'system')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  check (body is not null or message_type <> 'text')
);

create index if not exists chat_messages_conversation_created_idx
  on public.chat_messages (conversation_id, created_at desc);
create index if not exists chat_messages_sender_idx
  on public.chat_messages (sender_id, created_at desc);

create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  file_name text not null,
  file_path text not null,
  file_type text not null,
  file_size bigint not null check (file_size >= 0),
  storage_bucket text not null default 'chat-attachments',
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists chat_attachments_message_idx
  on public.chat_attachments (message_id);
create index if not exists chat_attachments_uploader_idx
  on public.chat_attachments (uploaded_by, created_at desc);

drop trigger if exists chat_conversations_set_updated_at on public.chat_conversations;
create trigger chat_conversations_set_updated_at
before update on public.chat_conversations
for each row execute function public.set_updated_at();

create or replace function public.is_conversation_member(target_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.chat_conversation_members member
    where member.conversation_id = target_conversation_id
      and member.user_id = auth.uid()
  );
$$;

create or replace function public.can_manage_conversation(target_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1
    from public.chat_conversation_members member
    where member.conversation_id = target_conversation_id
      and member.user_id = auth.uid()
      and member.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_conversation_member(uuid) from public;
revoke all on function public.can_manage_conversation(uuid) from public;
grant execute on function public.is_conversation_member(uuid) to authenticated;
grant execute on function public.can_manage_conversation(uuid) to authenticated;

alter table public.chat_conversations enable row level security;
alter table public.chat_conversation_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_attachments enable row level security;

drop policy if exists chat_conversations_select_member on public.chat_conversations;
create policy chat_conversations_select_member on public.chat_conversations
for select using (public.is_conversation_member(id));

drop policy if exists chat_conversations_update_manager on public.chat_conversations;
create policy chat_conversations_update_manager on public.chat_conversations
for update using (public.can_manage_conversation(id))
with check (public.can_manage_conversation(id));

drop policy if exists chat_members_select_member on public.chat_conversation_members;
create policy chat_members_select_member on public.chat_conversation_members
for select using (public.is_conversation_member(conversation_id));

drop policy if exists chat_members_insert_manager on public.chat_conversation_members;
create policy chat_members_insert_manager on public.chat_conversation_members
for insert with check (public.can_manage_conversation(conversation_id));

drop policy if exists chat_members_update_manager_or_self on public.chat_conversation_members;
create policy chat_members_update_manager_or_self on public.chat_conversation_members
for update using (public.can_manage_conversation(conversation_id) or user_id = auth.uid())
with check (public.can_manage_conversation(conversation_id) or user_id = auth.uid());

drop policy if exists chat_members_delete_manager on public.chat_conversation_members;
create policy chat_members_delete_manager on public.chat_conversation_members
for delete using (public.can_manage_conversation(conversation_id) and user_id <> auth.uid());

drop policy if exists chat_messages_select_member on public.chat_messages;
create policy chat_messages_select_member on public.chat_messages
for select using (public.is_conversation_member(conversation_id));

drop policy if exists chat_messages_insert_member on public.chat_messages;
create policy chat_messages_insert_member on public.chat_messages
for insert with check (
  public.is_conversation_member(conversation_id)
  and sender_id = auth.uid()
  and length(coalesce(body, '')) <= 8000
);

drop policy if exists chat_messages_update_sender on public.chat_messages;
create policy chat_messages_update_sender on public.chat_messages
for update using (sender_id = auth.uid() and deleted_at is null)
with check (sender_id = auth.uid());

drop policy if exists chat_attachments_select_member on public.chat_attachments;
create policy chat_attachments_select_member on public.chat_attachments
for select using (
  exists (
    select 1 from public.chat_messages message
    where message.id = message_id
      and public.is_conversation_member(message.conversation_id)
  )
);

drop policy if exists chat_attachments_insert_member on public.chat_attachments;
create policy chat_attachments_insert_member on public.chat_attachments
for insert with check (
  uploaded_by = auth.uid()
  and exists (
    select 1 from public.chat_messages message
    where message.id = message_id
      and public.is_conversation_member(message.conversation_id)
  )
);

create or replace function public.list_chat_users(search_text text default null)
returns table (
  id uuid,
  full_name text,
  email text,
  role text,
  department text,
  region text,
  avatar_path text
)
language sql
stable
security definer
set search_path = public
as $$
  select profile.id, profile.full_name, profile.email, profile.role,
         profile.department, profile.region, profile.avatar_path
  from public.profiles profile
  where profile.is_active = true
    and public.is_active_profile()
    and (
      nullif(trim(search_text), '') is null
      or profile.full_name ilike '%' || trim(search_text) || '%'
      or profile.email ilike '%' || trim(search_text) || '%'
      or coalesce(profile.department, '') ilike '%' || trim(search_text) || '%'
      or coalesce(profile.region, '') ilike '%' || trim(search_text) || '%'
    )
  order by profile.full_name
  limit 100;
$$;

revoke all on function public.list_chat_users(text) from public;
grant execute on function public.list_chat_users(text) to authenticated;

create or replace function public.create_chat_conversation(
  conversation_type text,
  conversation_name text,
  conversation_description text,
  participant_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_conversation_id uuid;
  participant_id uuid;
  active_participants int;
begin
  if not public.is_active_profile() then
    raise exception 'inactive_user';
  end if;

  if conversation_type not in ('direct', 'group') then
    raise exception 'invalid_conversation_type';
  end if;

  if conversation_type = 'group' and not public.is_admin() then
    raise exception 'admin_required';
  end if;

  select count(*) into active_participants
  from public.profiles
  where id = any(coalesce(participant_ids, '{}'::uuid[]))
    and is_active = true
    and id <> auth.uid();

  if conversation_type = 'direct' and active_participants <> 1 then
    raise exception 'direct_chat_requires_one_participant';
  end if;

  if conversation_type = 'group' and (active_participants < 1 or active_participants > 99) then
    raise exception 'group_participant_count_invalid';
  end if;

  if conversation_type = 'direct' then
    select conversation.id into new_conversation_id
    from public.chat_conversations conversation
    join public.chat_conversation_members mine
      on mine.conversation_id = conversation.id and mine.user_id = auth.uid()
    join public.chat_conversation_members theirs
      on theirs.conversation_id = conversation.id
      and theirs.user_id = (select id from public.profiles where id = any(participant_ids) and id <> auth.uid() limit 1)
    where conversation.type = 'direct'
      and (select count(*) from public.chat_conversation_members count_member where count_member.conversation_id = conversation.id) = 2
    limit 1;

    if new_conversation_id is not null then
      return new_conversation_id;
    end if;
  end if;

  insert into public.chat_conversations (type, name, description, created_by)
  values (
    conversation_type,
    case when conversation_type = 'group' then nullif(trim(conversation_name), '') else null end,
    case when conversation_type = 'group' then nullif(trim(conversation_description), '') else null end,
    auth.uid()
  )
  returning id into new_conversation_id;

  insert into public.chat_conversation_members (conversation_id, user_id, role)
  values (new_conversation_id, auth.uid(), 'owner');

  foreach participant_id in array coalesce(participant_ids, '{}'::uuid[]) loop
    if participant_id <> auth.uid() and exists (
      select 1 from public.profiles where id = participant_id and is_active = true
    ) then
      insert into public.chat_conversation_members (conversation_id, user_id, role)
      values (new_conversation_id, participant_id, 'member')
      on conflict (conversation_id, user_id) do nothing;
    end if;
  end loop;

  return new_conversation_id;
end;
$$;

revoke all on function public.create_chat_conversation(text, text, text, uuid[]) from public;
grant execute on function public.create_chat_conversation(text, text, text, uuid[]) to authenticated;

create or replace function public.set_my_avatar_path(new_avatar_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_profile() then
    raise exception 'inactive_user';
  end if;

  if new_avatar_path is not null
     and new_avatar_path not like auth.uid()::text || '/%' then
    raise exception 'invalid_avatar_path';
  end if;

  update public.profiles
  set avatar_path = new_avatar_path, updated_at = now()
  where id = auth.uid();
end;
$$;

revoke all on function public.set_my_avatar_path(text) from public;
grant execute on function public.set_my_avatar_path(text) to authenticated;

create or replace function public.add_profile_to_company_chat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  company_conversation_id uuid;
begin
  if new.is_active then
    select id into company_conversation_id
    from public.chat_conversations where type = 'all_company' limit 1;

    if company_conversation_id is not null then
      insert into public.chat_conversation_members (conversation_id, user_id, role)
      values (company_conversation_id, new.id, 'member')
      on conflict (conversation_id, user_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profile_add_to_company_chat on public.profiles;
create trigger profile_add_to_company_chat
after insert or update of is_active on public.profiles
for each row execute function public.add_profile_to_company_chat();

do $$
declare
  company_conversation_id uuid;
begin
  insert into public.chat_conversations (type, name, description, created_by)
  values ('all_company', 'Todos', 'Canal general de la empresa', null)
  on conflict do nothing;

  select id into company_conversation_id
  from public.chat_conversations where type = 'all_company' limit 1;

  insert into public.chat_conversation_members (conversation_id, user_id, role)
  select company_conversation_id, profile.id,
         case when profile.role = 'admin' then 'admin' else 'member' end
  from public.profiles profile
  where profile.is_active = true
  on conflict (conversation_id, user_id) do nothing;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  false,
  15728640,
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

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists chat_attachments_storage_select_member on storage.objects;
create policy chat_attachments_storage_select_member on storage.objects
for select using (
  bucket_id = 'chat-attachments'
  and public.is_conversation_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists chat_attachments_storage_insert_member on storage.objects;
create policy chat_attachments_storage_insert_member on storage.objects
for insert with check (
  bucket_id = 'chat-attachments'
  and public.is_conversation_member(((storage.foldername(name))[1])::uuid)
  and auth.uid()::text = (storage.foldername(name))[2]
);

drop policy if exists chat_attachments_storage_delete_owner on storage.objects;
create policy chat_attachments_storage_delete_owner on storage.objects
for delete using (
  bucket_id = 'chat-attachments'
  and auth.uid()::text = (storage.foldername(name))[2]
);

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects
for insert with check (
  bucket_id = 'avatars'
  and auth.uid()::text = (storage.foldername(name))[1]
  and public.is_active_profile()
);

drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects
for update using (
  bucket_id = 'avatars'
  and auth.uid()::text = (storage.foldername(name))[1]
)
with check (
  bucket_id = 'avatars'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists avatars_delete_own_or_admin on storage.objects;
create policy avatars_delete_own_or_admin on storage.objects
for delete using (
  bucket_id = 'avatars'
  and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin())
);

-- Public bucket reads are handled by Supabase Storage public object access.

create index if not exists upload_batches_owner_created_idx
  on public.upload_batches (uploaded_by, created_at desc);
create index if not exists upload_batches_category_created_idx
  on public.upload_batches (detected_category, created_at desc);
create index if not exists business_records_upload_batch_created_idx
  on public.business_records (upload_batch_id, created_at desc);
create index if not exists business_records_mpn_gp_idx
  on public.business_records (mpn, gp_rate) where archived_at is null;
create index if not exists business_records_supplier_mpn_idx
  on public.business_records (supplier, mpn) where archived_at is null;
create index if not exists business_records_customer_gp_idx
  on public.business_records (customer, gp_rate) where archived_at is null;
create index if not exists import_errors_type_created_idx
  on public.import_errors (error_type, created_at desc);
create index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));
create index if not exists profiles_active_department_region_idx
  on public.profiles (is_active, department, region);

create or replace function public.get_employee_activity_directory()
returns table (
  id uuid,
  full_name text,
  email text,
  role text,
  department text,
  region text,
  is_active boolean,
  avatar_path text,
  created_at timestamptz,
  updated_at timestamptz,
  upload_count bigint,
  record_count bigint,
  last_upload timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select profile.id, profile.full_name, profile.email, profile.role, profile.department,
         profile.region, profile.is_active, profile.avatar_path, profile.created_at, profile.updated_at,
         (select count(*) from public.upload_batches batch where batch.uploaded_by = profile.id) as upload_count,
         (select count(*) from public.business_records record where record.uploaded_by = profile.id and record.archived_at is null) as record_count,
         (select max(batch.created_at) from public.upload_batches batch where batch.uploaded_by = profile.id) as last_upload
  from public.profiles profile
  where public.is_admin()
  order by profile.full_name;
$$;

revoke all on function public.get_employee_activity_directory() from public;
grant execute on function public.get_employee_activity_directory() to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end;
$$;
