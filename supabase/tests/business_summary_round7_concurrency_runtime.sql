-- Real two-session claim/lease/fencing contract for Ronda 7. Synthetic temp PostgreSQL only.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() !~ '^quiksol_privacy_round5_test_r7[a-z0-9_]*$'
     or current_setting('quiksol.allow_round7_summary_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_RONDA7_SUMMARY_TEST_DATABASE';
  end if;
end;
$$;

create extension if not exists dblink;
insert into auth.users(id,email,raw_user_meta_data)
values('79000000-0000-4000-8000-000000000001','r7-summary-concurrency@example.invalid','{}')
on conflict(id) do nothing;
update public.profiles set role='admin',is_active=true
where id='79000000-0000-4000-8000-000000000001';
insert into public.upload_batches(
  id,uploaded_by,original_file_name,status,detected_category,total_rows,valid_rows
) values (
  '79000000-0000-4000-8000-000000000010','79000000-0000-4000-8000-000000000001',
  'r7-summary-concurrency.xlsx','completed','pricing',1,1
);
insert into public.business_records(
  id,upload_batch_id,uploaded_by,row_index,raw_data,normalized_data,mpn,req_qty
) values (
  '79000000-0000-4000-8000-000000000011','79000000-0000-4000-8000-000000000010',
  '79000000-0000-4000-8000-000000000001',1,
  '{"MPN":"R7-CONCURRENCY","Required Qty":1}','{}','R7-CONCURRENCY',1
);

create or replace function public.round7_test_hold_summary_claim()
returns integer
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare won integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select count(*)::integer into won
  from public.claim_business_summary_rebuild_v2('r7-concurrent-worker-a',120)
  where upload_batch_id='79000000-0000-4000-8000-000000000010';
  perform pg_sleep(3);
  return won;
end;
$$;

create or replace function public.round7_test_measure_competing_summary_claim()
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  started_at timestamptz:=clock_timestamp();
  won integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('lock_timeout','1500ms',true);
  select count(*)::integer into won
  from public.claim_business_summary_rebuild_v2('r7-concurrent-worker-b',120)
  where upload_batch_id='79000000-0000-4000-8000-000000000010';
  return jsonb_build_object(
    'won',won,
    'elapsedMs',extract(epoch from clock_timestamp()-started_at)*1000
  );
end;
$$;

select dblink_connect(
  'r7_summary_a',
  format('host=%s port=%s dbname=%s user=%s application_name=r7_summary_a',
    inet_server_addr(),current_setting('port'),current_database(),current_user)
);
select dblink_connect(
  'r7_summary_b',
  format('host=%s port=%s dbname=%s user=%s application_name=r7_summary_b',
    inet_server_addr(),current_setting('port'),current_database(),current_user)
);
select dblink_send_query('r7_summary_a','select public.round7_test_hold_summary_claim()');

do $$
declare attempt integer;
begin
  for attempt in 1..40 loop
    exit when exists(select 1 from pg_stat_activity
      where application_name='r7_summary_a' and wait_event='PgSleep');
    perform pg_sleep(0.05);
  end loop;
  if not exists(select 1 from pg_stat_activity
    where application_name='r7_summary_a' and wait_event='PgSleep') then
    raise exception 'SUMMARY_CONCURRENT_SESSION_A_NOT_HELD';
  end if;
end;
$$;

select dblink_send_query('r7_summary_b','select public.round7_test_measure_competing_summary_claim()');
do $$
declare attempt integer;
begin
  for attempt in 1..20 loop
    exit when dblink_is_busy('r7_summary_b')=0;
    perform pg_sleep(0.05);
  end loop;
  if dblink_is_busy('r7_summary_b')<>0 then
    raise exception 'SUMMARY_COMPETING_CLAIM_BLOCKED';
  end if;
  if dblink_is_busy('r7_summary_a')<>1 then
    raise exception 'SUMMARY_PRIMARY_CLAIM_FINISHED_TOO_EARLY';
  end if;
end;
$$;

create temporary table r7_competing_result(result jsonb);
insert into r7_competing_result
select result from dblink_get_result('r7_summary_b') as response(result jsonb);
do $$
begin
  if (select (result->>'won')::integer from r7_competing_result) <> 0
     or (select (result->>'elapsedMs')::numeric from r7_competing_result) >= 1500 then
    raise exception 'SUMMARY_COMPETING_CLAIM_INVALID:%',(select result from r7_competing_result);
  end if;
end;
$$;

create temporary table r7_primary_result(won integer);
insert into r7_primary_result
select won from dblink_get_result('r7_summary_a') as response(won integer);
select dblink_disconnect('r7_summary_a');
select dblink_disconnect('r7_summary_b');
do $$
begin
  if (select won from r7_primary_result)<>1 then
    raise exception 'SUMMARY_PRIMARY_CLAIM_NOT_UNIQUE';
  end if;
end;
$$;

create temporary table r7_old_claim as
select rebuild_id,rebuild_generation,rebuild_fence_token
from public.business_upload_versions
where upload_batch_id='79000000-0000-4000-8000-000000000010';
update public.business_upload_versions
set rebuild_lease_expires_at=clock_timestamp()-interval '1 second'
where upload_batch_id='79000000-0000-4000-8000-000000000010';
select set_config('request.jwt.claim.role','service_role',false);
create temporary table r7_reclaimed as
select * from public.claim_business_summary_rebuild_v2('r7-reclaimer',120)
where upload_batch_id='79000000-0000-4000-8000-000000000010';
do $$
declare old_claim r7_old_claim%rowtype; reclaimed r7_reclaimed%rowtype;
begin
  select * into old_claim from r7_old_claim;
  select * into reclaimed from r7_reclaimed;
  if reclaimed.upload_batch_id is null
     or reclaimed.rebuild_generation <= old_claim.rebuild_generation
     or reclaimed.fence_token <= old_claim.rebuild_fence_token then
    raise exception 'SUMMARY_EXPIRED_LEASE_NOT_RECLAIMED';
  end if;
  begin
    perform public.publish_business_summary_rebuild_v2(
      '79000000-0000-4000-8000-000000000010','r7-concurrent-worker-a',
      old_claim.rebuild_id,old_claim.rebuild_generation,old_claim.rebuild_fence_token,
      1,repeat('a',64)
    );
    raise exception 'SUMMARY_OLD_WORKER_PUBLISHED_AFTER_RECLAIM';
  exception when sqlstate '55000' then
    if sqlerrm <> 'SUMMARY_WORKER_FENCED' then raise; end if;
  end;
end;
$$;

select 'BUSINESS_SUMMARY_ROUND7_CONCURRENCY_RUNTIME_PASS' result,
  (select result->>'elapsedMs' from r7_competing_result) competing_claim_elapsed_ms;
