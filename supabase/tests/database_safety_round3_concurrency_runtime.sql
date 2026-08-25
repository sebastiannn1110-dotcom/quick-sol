-- Run only against an isolated database named quiksol_round3_concurrency_test.
-- This script commits and executes a synthetic purge; never point it at shared data.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_round3_concurrency_test'
     or current_setting('quiksol.allow_destructive_runtime_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_DISPOSABLE_DATABASE';
  end if;
end;
$$;

create extension if not exists dblink;

begin;
insert into auth.users(id,email,raw_user_meta_data)
values('f3100000-0000-4000-8000-000000000001','round3-concurrency@example.invalid','{}'::jsonb);
update public.profiles set role='super_admin_dev',is_active=true
where id='f3100000-0000-4000-8000-000000000001';
insert into public.clients(id,name,created_by)
values('f3100000-0000-4000-8000-000000000010','Synthetic Concurrent Client','f3100000-0000-4000-8000-000000000001');
update public.database_safety_state set delete_enabled=true where singleton;

set local role service_role;
set local request.jwt.claim.role='service_role';
do $$
declare
  snapshot jsonb;
  manifest public.database_backup_manifests;
  operation public.database_destruction_operations;
begin
  snapshot:=public.database_safety_current_snapshot_v2('f3100000-0000-4000-8000-000000000001');
  manifest:=public.begin_database_backup_manifest_v2(
    'f3100000-0000-4000-8000-000000000001',
    'backup-respaldo-seguridad-quiksol-2026-08-22-150001.tar'
  );
  manifest:=public.record_database_backup_created_v2(
    'f3100000-0000-4000-8000-000000000001',manifest.id,repeat('a',64),4096,'temporary-round3',
    snapshot->>'schemaVersion',snapshot->>'migrationVersion',repeat('b',64),2048,
    (snapshot->>'tableCount')::integer,repeat('c',64),0,0,'{}'::text[],repeat('d',64)
  );
  manifest:=public.verify_database_backup_manifest_v2(
    'f3100000-0000-4000-8000-000000000001',manifest.id,manifest.evidence_hash
  );
  manifest:=public.mark_database_backup_downloaded_v2(
    'f3100000-0000-4000-8000-000000000001',manifest.id,manifest.evidence_hash
  );
  operation:=public.arm_database_destruction_v2(
    'f3100000-0000-4000-8000-000000000001',manifest.id,repeat('e',64),repeat('f',64),repeat('0',64)
  );
end;
$$;
reset role;
update public.database_destruction_operations
set not_before=clock_timestamp()-interval '1 second'
where created_by='f3100000-0000-4000-8000-000000000001' and status='armed';
commit;

select dblink_connect(
  'round3_concurrent_a',
  format('host=%s port=%s dbname=%s user=%s',inet_server_addr(),current_setting('port'),current_database(),current_user)
);
select dblink_connect(
  'round3_concurrent_b',
  format('host=%s port=%s dbname=%s user=%s',inet_server_addr(),current_setting('port'),current_database(),current_user)
);

select dblink_send_query('round3_concurrent_a',$query$
  set role service_role;
  set request.jwt.claim.role='service_role';
  select public.execute_database_business_purge_v2(
    'f3100000-0000-4000-8000-000000000001',
    (select id from public.database_destruction_operations where created_by='f3100000-0000-4000-8000-000000000001' and status in ('armed','database_completed') order by created_at desc limit 1),
    repeat('e',64),repeat('f',64)
  )::text;
$query$);
select dblink_send_query('round3_concurrent_b',$query$
  set role service_role;
  set request.jwt.claim.role='service_role';
  select public.execute_database_business_purge_v2(
    'f3100000-0000-4000-8000-000000000001',
    (select id from public.database_destruction_operations where created_by='f3100000-0000-4000-8000-000000000001' and status in ('armed','database_completed') order by created_at desc limit 1),
    repeat('e',64),repeat('f',64)
  )::text;
$query$);

create temporary table round3_concurrent_results(payload text);
insert into round3_concurrent_results select payload from dblink_get_result('round3_concurrent_a') as result(payload text);
insert into round3_concurrent_results select payload from dblink_get_result('round3_concurrent_b') as result(payload text);
select dblink_disconnect('round3_concurrent_a');
select dblink_disconnect('round3_concurrent_b');

do $$
declare
  v_operation_id uuid;
begin
  select id into v_operation_id from public.database_destruction_operations
  where created_by='f3100000-0000-4000-8000-000000000001'
  order by created_at desc limit 1;
  if (select count(*) from round3_concurrent_results)<>2 then raise exception 'CONCURRENT_RESULT_MISSING'; end if;
  if (select count(distinct payload) from round3_concurrent_results)<>1 then raise exception 'CONCURRENT_RESULTS_DIFFER'; end if;
  if not exists(select 1 from public.database_destruction_operations where id=v_operation_id and status='database_completed' and challenge_used_at is not null) then
    raise exception 'CONCURRENT_OPERATION_NOT_COMPLETED';
  end if;
  if (select count(*) from public.database_safety_audit_events audit where audit.operation_id=v_operation_id and audit.event_type='business_database_deleted')<>1 then
    raise exception 'CONCURRENT_AUDIT_NOT_SINGLE';
  end if;
  if exists(select 1 from public.clients where id='f3100000-0000-4000-8000-000000000010') then
    raise exception 'CONCURRENT_PURGE_DID_NOT_DELETE_FIXTURE';
  end if;
end;
$$;
