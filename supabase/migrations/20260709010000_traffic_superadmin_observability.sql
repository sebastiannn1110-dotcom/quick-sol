-- Traffic and superadmin observability hardening.

alter table public.system_logs
  add column if not exists status_code int,
  add column if not exists ip_address text,
  add column if not exists user_agent text,
  add column if not exists event_type text;

alter table public.client_logs
  add column if not exists ip_address text,
  add column if not exists user_agent text;

create index if not exists system_logs_status_code_idx on public.system_logs(status_code);
create index if not exists system_logs_event_type_idx on public.system_logs(event_type);
create index if not exists system_logs_route_created_idx on public.system_logs(route, created_at desc);
create index if not exists system_logs_ip_created_idx on public.system_logs(ip_address, created_at desc);
create index if not exists client_logs_route_created_idx on public.client_logs(route, created_at desc);
create index if not exists client_logs_ip_created_idx on public.client_logs(ip_address, created_at desc);
create index if not exists client_logs_action_created_idx on public.client_logs(action, created_at desc);

create or replace function public.purge_old_traffic_logs(retention_days int default 90)
returns table(system_logs_deleted int, client_logs_deleted int)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 1));
begin
  delete from public.client_logs where created_at < cutoff;
  get diagnostics client_logs_deleted = row_count;

  delete from public.system_logs
  where created_at < cutoff
    and module in ('frontend', 'api', 'analytics', 'upload', 'ai', 'chat', 'security', 'auth');
  get diagnostics system_logs_deleted = row_count;

  return next;
end;
$$;

revoke all on function public.purge_old_traffic_logs(int) from public;
grant execute on function public.purge_old_traffic_logs(int) to service_role;
