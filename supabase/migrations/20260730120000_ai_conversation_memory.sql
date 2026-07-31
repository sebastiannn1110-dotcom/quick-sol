-- Additive Phase 11 migration. Intentionally safe to stage without executing.
-- Conversation ownership is absolute: authenticated admins receive no policy
-- exception and can only access rows where auth.uid() = user_id.

create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'New conversation'
    check (char_length(title) between 1 and 120),
  language text not null default 'es'
    check (language in ('es', 'en', 'zh')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retention_expires_at timestamptz not null default (now() + interval '90 days'),
  deleted_at timestamptz,
  check (retention_expires_at > created_at)
);

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  language text not null default 'es'
    check (language in ('es', 'en', 'zh')),
  intent text
    check (intent is null or char_length(intent) between 1 and 80),
  source_type text not null default 'user'
    check (
      source_type in (
        'user',
        'assistant',
        'authorized_database',
        'opportunity_finder',
        'stock_needs',
        'latest_upload'
      )
    ),
  content text not null
    check (char_length(content) between 1 and 8000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint ai_messages_content_no_uuid check (
    content !~* '\m[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\M'
  ),
  constraint ai_messages_content_no_email check (
    content !~* '\m[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\M'
  )
);

comment on table public.ai_conversations is
  'Private AI conversation metadata. Owner-only RLS applies equally to admins, managers, and employees.';
comment on table public.ai_messages is
  'Private user/assistant text only. Tool payloads and commercial record identifiers must never be persisted.';
comment on column public.ai_messages.content is
  'Sanitized display text only; never raw_data, normalized_data, raw_value, tool payloads, emails, or UUIDs.';

create index if not exists ai_conversations_owner_updated_idx
  on public.ai_conversations(user_id, updated_at desc)
  where deleted_at is null;
create index if not exists ai_conversations_retention_idx
  on public.ai_conversations(retention_expires_at)
  where deleted_at is null;
create index if not exists ai_messages_conversation_created_idx
  on public.ai_messages(conversation_id, created_at desc)
  where deleted_at is null;
create index if not exists ai_messages_owner_idx
  on public.ai_messages(user_id, conversation_id)
  where deleted_at is null;

drop trigger if exists ai_conversations_set_updated_at on public.ai_conversations;
create trigger ai_conversations_set_updated_at
before update on public.ai_conversations
for each row execute function public.set_updated_at();

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_conversations force row level security;
alter table public.ai_messages force row level security;

drop policy if exists ai_conversations_select_own on public.ai_conversations;
create policy ai_conversations_select_own on public.ai_conversations
for select to authenticated
using (
  auth.uid() = user_id
  and deleted_at is null
  and retention_expires_at > now()
);

drop policy if exists ai_conversations_insert_own on public.ai_conversations;
create policy ai_conversations_insert_own on public.ai_conversations
for insert to authenticated
with check (
  auth.uid() = user_id
  and deleted_at is null
  and retention_expires_at > now()
);

drop policy if exists ai_conversations_update_own on public.ai_conversations;
create policy ai_conversations_update_own on public.ai_conversations
for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists ai_conversations_delete_own on public.ai_conversations;
create policy ai_conversations_delete_own on public.ai_conversations
for delete to authenticated
using (auth.uid() = user_id);

drop policy if exists ai_messages_select_own on public.ai_messages;
create policy ai_messages_select_own on public.ai_messages
for select to authenticated
using (
  auth.uid() = user_id
  and deleted_at is null
  and exists (
    select 1
    from public.ai_conversations conversation
    where conversation.id = ai_messages.conversation_id
      and conversation.user_id = auth.uid()
      and conversation.deleted_at is null
      and conversation.retention_expires_at > now()
  )
);

drop policy if exists ai_messages_insert_own on public.ai_messages;
create policy ai_messages_insert_own on public.ai_messages
for insert to authenticated
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.ai_conversations conversation
    where conversation.id = ai_messages.conversation_id
      and conversation.user_id = auth.uid()
      and conversation.deleted_at is null
      and conversation.retention_expires_at > now()
  )
);

drop policy if exists ai_messages_update_own on public.ai_messages;
create policy ai_messages_update_own on public.ai_messages
for update to authenticated
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.ai_conversations conversation
    where conversation.id = ai_messages.conversation_id
      and conversation.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.ai_conversations conversation
    where conversation.id = ai_messages.conversation_id
      and conversation.user_id = auth.uid()
  )
);

drop policy if exists ai_messages_delete_own on public.ai_messages;
create policy ai_messages_delete_own on public.ai_messages
for delete to authenticated
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.ai_conversations conversation
    where conversation.id = ai_messages.conversation_id
      and conversation.user_id = auth.uid()
  )
);

revoke all on public.ai_conversations from anon;
revoke all on public.ai_messages from anon;
grant select, insert, update, delete on public.ai_conversations to authenticated;
grant select, insert, update, delete on public.ai_messages to authenticated;

-- Reversible rollback plan (manual and intentionally NOT executed):
--   drop table if exists public.ai_messages;
--   drop table if exists public.ai_conversations;
