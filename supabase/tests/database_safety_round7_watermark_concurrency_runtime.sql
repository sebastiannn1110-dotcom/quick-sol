-- Real two-session AFTER regression for Ronda 7. Disposable PostgreSQL only.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() !~ '^quiksol_round7_watermark_test(_[a-z0-9]+)?$'
     or current_setting('quiksol.allow_round7_watermark_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_ROUND7_WATERMARK_TEST_DATABASE';
  end if;
end;
$$;

create extension if not exists dblink;

insert into auth.users(id,email,raw_user_meta_data)
values('f7000000-0000-4000-8000-000000000001','round7-watermark@example.invalid','{}'::jsonb)
on conflict(id) do nothing;

update public.profiles
set role='super_admin_dev',is_active=true
where id='f7000000-0000-4000-8000-000000000001';

insert into public.clients(id,name,created_by)
values('f7000000-0000-4000-8000-000000000031','Synthetic R7 concurrent A','f7000000-0000-4000-8000-000000000001')
on conflict(id) do update set name=excluded.name;

insert into public.business_scope_counters(owner_id)
values('f7000000-0000-4000-8000-000000000001')
on conflict(owner_id) do nothing;

create or replace function public.round7_test_hold_client_write()
returns integer
language plpgsql
set search_path=pg_catalog,public
as $$
begin
  update public.clients
  set name='Synthetic R7 concurrent A held'
  where id='f7000000-0000-4000-8000-000000000031';
  perform pg_sleep(4);
  return 1;
end;
$$;

create or replace function public.round7_test_measure_unrelated_write()
returns double precision
language plpgsql
set search_path=pg_catalog,public
as $$
declare
  started_at timestamptz:=clock_timestamp();
begin
  perform set_config('lock_timeout','1500ms',true);
  update public.business_scope_counters
  set record_count=record_count+1,updated_at=clock_timestamp()
  where owner_id='f7000000-0000-4000-8000-000000000001';
  return extract(epoch from clock_timestamp()-started_at)*1000;
end;
$$;

select dblink_connect(
  'round7_watermark_a',
  format(
    'host=%s port=%s dbname=%s user=%s application_name=round7_watermark_a',
    inet_server_addr(),current_setting('port'),current_database(),current_user
  )
);
select dblink_connect(
  'round7_watermark_b',
  format(
    'host=%s port=%s dbname=%s user=%s application_name=round7_watermark_b',
    inet_server_addr(),current_setting('port'),current_database(),current_user
  )
);

select dblink_send_query('round7_watermark_a','select public.round7_test_hold_client_write()');

do $$
declare
  attempt integer;
begin
  for attempt in 1..40 loop
    exit when exists(
      select 1 from pg_stat_activity
      where application_name='round7_watermark_a' and wait_event='PgSleep'
    );
    perform pg_sleep(0.05);
  end loop;
  if not exists(
    select 1 from pg_stat_activity
    where application_name='round7_watermark_a' and wait_event='PgSleep'
  ) then raise exception 'ROUND7_SESSION_A_DID_NOT_HOLD_TRANSACTION'; end if;
  if not exists(
    select 1
    from pg_locks locks
    join pg_stat_activity activity on activity.pid=locks.pid
    where activity.application_name='round7_watermark_a'
      and locks.locktype='advisory' and locks.mode='ShareLock' and locks.granted
  ) then raise exception 'ROUND7_SESSION_A_SHARED_FENCE_MISSING'; end if;
end;
$$;

select dblink_send_query('round7_watermark_b','select public.round7_test_measure_unrelated_write()');

do $$
declare
  attempt integer;
  blocker_pids integer[];
begin
  for attempt in 1..20 loop
    exit when dblink_is_busy('round7_watermark_b')=0;
    perform pg_sleep(0.05);
  end loop;
  if dblink_is_busy('round7_watermark_b')<>0 then
    raise exception 'ROUND7_UNRELATED_WRITE_BLOCKED';
  end if;
  if dblink_is_busy('round7_watermark_a')<>1 then
    raise exception 'ROUND7_SESSION_A_FINISHED_BEFORE_ASSERTION';
  end if;
  select pg_blocking_pids(pid) into blocker_pids
  from pg_stat_activity where application_name='round7_watermark_b';
  if cardinality(coalesce(blocker_pids,'{}'::integer[]))<>0 then
    raise exception 'ROUND7_UNRELATED_WRITE_HAS_BLOCKER:%',blocker_pids;
  end if;
end;
$$;

create temporary table round7_write_elapsed(elapsed_ms double precision);
insert into round7_write_elapsed
select elapsed_ms from dblink_get_result('round7_watermark_b') as result(elapsed_ms double precision);

do $$
begin
  if (select count(*) from round7_write_elapsed)<>1
     or (select elapsed_ms from round7_write_elapsed)>=1500 then
    raise exception 'ROUND7_UNRELATED_WRITE_LATENCY_INVALID:%',
      (select elapsed_ms from round7_write_elapsed limit 1);
  end if;
end;
$$;

select elapsed_ms as unrelated_write_elapsed_ms
from round7_write_elapsed;

select result_value
from dblink_get_result('round7_watermark_a') as result(result_value integer);
select dblink_disconnect('round7_watermark_a');
select dblink_disconnect('round7_watermark_b');
