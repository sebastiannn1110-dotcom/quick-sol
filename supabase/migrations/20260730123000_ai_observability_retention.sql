-- Additive, not executed by this change.
-- Rollback:
--   drop function if exists public.purge_old_ai_system_logs(integer);

create or replace function public.purge_old_ai_system_logs(retention_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  if retention_days < 1 or retention_days > 365 then
    raise exception 'retention_days must be between 1 and 365';
  end if;

  delete from public.system_logs
  where module = 'ai'
    and created_at < now() - make_interval(days => retention_days);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.purge_old_ai_system_logs(integer) from public;
revoke all on function public.purge_old_ai_system_logs(integer) from anon;
revoke all on function public.purge_old_ai_system_logs(integer) from authenticated;
grant execute on function public.purge_old_ai_system_logs(integer) to service_role;

comment on function public.purge_old_ai_system_logs(integer) is
  'Deletes sanitized AI system logs older than the requested retention window. No schedule is installed by this migration.';
