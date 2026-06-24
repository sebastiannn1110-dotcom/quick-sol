-- Observability and tracing layer for Quiksol Data Intelligence Platform.

create table if not exists public.system_logs (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid,
  request_id uuid,
  level text not null check (level in ('debug','info','warn','error','fatal','security','audit')),
  module text not null,
  action text not null,
  message text not null,
  user_id uuid references public.profiles(id),
  user_email text,
  user_role text,
  route text,
  method text,
  status text,
  duration_ms numeric,
  upload_batch_id uuid references public.upload_batches(id) on delete set null,
  file_name text,
  sheet_name text,
  row_index int,
  column_name text,
  category text,
  metadata jsonb,
  error jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.client_logs (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid,
  level text not null check (level in ('debug','info','warn','error')),
  action text not null,
  message text not null,
  user_id uuid references public.profiles(id),
  route text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.performance_logs (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid,
  request_id uuid,
  operation text not null,
  module text not null,
  duration_ms numeric not null,
  status text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table public.security_events add column if not exists trace_id uuid;
alter table public.security_events add column if not exists actor_email text;
alter table public.import_errors add column if not exists trace_id uuid;

create index if not exists system_logs_trace_id_idx on public.system_logs(trace_id);
create index if not exists system_logs_request_id_idx on public.system_logs(request_id);
create index if not exists system_logs_level_idx on public.system_logs(level);
create index if not exists system_logs_module_idx on public.system_logs(module);
create index if not exists system_logs_user_id_idx on public.system_logs(user_id);
create index if not exists system_logs_upload_batch_id_idx on public.system_logs(upload_batch_id);
create index if not exists system_logs_created_at_idx on public.system_logs(created_at desc);
create index if not exists system_logs_action_message_idx on public.system_logs using gin(to_tsvector('simple', coalesce(action, '') || ' ' || coalesce(message, '')));

create index if not exists client_logs_trace_id_idx on public.client_logs(trace_id);
create index if not exists client_logs_user_id_idx on public.client_logs(user_id);
create index if not exists client_logs_created_at_idx on public.client_logs(created_at desc);

create index if not exists performance_logs_trace_id_idx on public.performance_logs(trace_id);
create index if not exists performance_logs_operation_idx on public.performance_logs(operation);
create index if not exists performance_logs_created_at_idx on public.performance_logs(created_at desc);

create index if not exists security_events_trace_id_idx on public.security_events(trace_id);
create index if not exists import_errors_trace_id_idx on public.import_errors(trace_id);

alter table public.system_logs enable row level security;
alter table public.client_logs enable row level security;
alter table public.performance_logs enable row level security;

drop policy if exists system_logs_select_admin on public.system_logs;
create policy system_logs_select_admin on public.system_logs
for select using (public.is_admin());

drop policy if exists client_logs_select_admin on public.client_logs;
create policy client_logs_select_admin on public.client_logs
for select using (public.is_admin());

drop policy if exists client_logs_insert_own on public.client_logs;
create policy client_logs_insert_own on public.client_logs
for insert with check (user_id = auth.uid() and public.is_active_profile());

drop policy if exists performance_logs_select_admin on public.performance_logs;
create policy performance_logs_select_admin on public.performance_logs
for select using (public.is_admin());

-- system_logs and performance_logs are inserted by trusted server/service role only.
