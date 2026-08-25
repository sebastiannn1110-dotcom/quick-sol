-- Empty migration-history regression for Ronda 7. Synthetic temp PostgreSQL only.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() !~ '^quiksol_privacy_round5_test_r7[a-z0-9_]*$'
     or current_setting('quiksol.allow_round7_database_safety_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_RONDA7_DATABASE_SAFETY_TEST_DATABASE';
  end if;
end;
$$;

begin;
insert into auth.users(id,email,raw_user_meta_data)
values('7a000000-0000-4000-8000-000000000001','r7-empty-history@example.invalid','{}')
on conflict(id) do nothing;
update public.profiles set role='super_admin_dev',is_active=true
where id='7a000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.role','service_role',true);

-- Preserve the real synthetic history table untouched while exposing an empty
-- table under the authoritative name for this transaction only.
alter table supabase_migrations.schema_migrations
  rename to schema_migrations_r7_nonempty;
create table supabase_migrations.schema_migrations (
  version text primary key,
  statements text[] default '{}',
  name text
);

do $$
declare
  snapshot jsonb;
  coalesced_read_count integer;
begin
  if exists(select 1 from supabase_migrations.schema_migrations) then
    raise exception 'ROUND7_MIGRATION_HISTORY_NOT_EMPTY';
  end if;
  snapshot:=public.database_safety_current_snapshot_v2(
    '7a000000-0000-4000-8000-000000000001'
  );
  if snapshot->>'migrationVersion' <> 'unknown'
     or snapshot->>'schemaVersion' <> 'unknown'
     or snapshot->>'catalogVersion' <> '20260825120000-r7-v1'
     or coalesce((snapshot->>'deleteEnabledInDatabase')::boolean,true) then
    raise exception 'ROUND7_EMPTY_HISTORY_SNAPSHOT_INVALID:%',snapshot;
  end if;
  select count(*)::integer into coalesced_read_count
  from pg_proc function
  join pg_namespace namespace on namespace.oid=function.pronamespace
  where namespace.nspname='public'
    and function.prokind='f'
    and pg_get_functiondef(function.oid) like '%coalesce(max(version)::text, ''unknown'')%';
  if coalesced_read_count <> 4 then
    raise exception 'ROUND7_EMPTY_HISTORY_COALESCE_COUNT_INVALID:%',coalesced_read_count;
  end if;
end;
$$;

select 'DATABASE_SAFETY_ROUND7_EMPTY_HISTORY_RUNTIME_PASS' result;
rollback;
