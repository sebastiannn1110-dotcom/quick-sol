-- Run only against a disposable full-migration PostgreSQL database.
-- All data is synthetic and the transaction is rolled back.
\set ON_ERROR_STOP on
begin;

do $$
begin
  if current_setting('quiksol.allow_destructive_runtime_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_DISPOSABLE_DATABASE';
  end if;
end;
$$;

insert into auth.users(id,email,raw_user_meta_data)
values
  ('f3000000-0000-4000-8000-000000000001','round3-owner@example.invalid','{}'::jsonb),
  ('f3000000-0000-4000-8000-000000000002','round3-other@example.invalid','{}'::jsonb),
  ('f3000000-0000-4000-8000-000000000003','round3-employee@example.invalid','{}'::jsonb)
on conflict(id) do nothing;

update public.profiles set role='super_admin_dev',is_active=true where id in (
  'f3000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000002'
);
update public.profiles set role='employee',is_active=true where id='f3000000-0000-4000-8000-000000000003';

insert into public.clients(id,name,created_by)
values('f3000000-0000-4000-8000-000000000010','Synthetic Round 3 Client','f3000000-0000-4000-8000-000000000001');
insert into public.system_logs(level,module,action,message)
values('info','database_safety_round3','synthetic_fixture','Synthetic test evidence without business identifiers.');

grant insert,select on public.system_logs to service_role;
grant insert,select on public.clients to service_role;

do $$
declare function_name text;
begin
  foreach function_name in array array[
    'register_database_backup_manifest(text,text,bigint,integer,text,text,text,bigint,boolean)',
    'mark_database_backup_downloaded(uuid,text)',
    'arm_database_destruction(uuid,text,text,text)',
    'execute_database_business_purge(uuid,text,text)',
    'begin_database_backup_manifest_v2(uuid,text)',
    'arm_database_destruction_v2(uuid,uuid,text,text,text)',
    'execute_database_business_purge_v2(uuid,uuid,text,text)'
  ] loop
    if has_function_privilege('authenticated', format('public.%s',function_name), 'EXECUTE') then
      raise exception 'AUTHENTICATED_DIRECT_RPC_ALLOWED:%',function_name;
    end if;
  end loop;
  if not has_function_privilege('service_role','public.execute_database_business_purge_v2(uuid,uuid,text,text)','EXECUTE') then
    raise exception 'BACKEND_EXECUTE_GRANT_MISSING';
  end if;
end;
$$;

set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='f3000000-0000-4000-8000-000000000001';
do $$
begin
  begin
    perform public.begin_database_backup_manifest_v2(
      'f3000000-0000-4000-8000-000000000001',
      'backup-respaldo-seguridad-quiksol-2026-08-22-140001.tar'
    );
    raise exception 'DIRECT_SUPERADMIN_RPC_UNEXPECTEDLY_ALLOWED';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;
reset role;

create or replace function pg_temp.round3_verified_manifest(input_actor uuid,input_suffix text,input_hash_char text)
returns public.database_backup_manifests
language plpgsql
as $$
declare
  snapshot jsonb;
  manifest public.database_backup_manifests;
begin
  snapshot:=public.database_safety_current_snapshot_v2(input_actor);
  manifest:=public.begin_database_backup_manifest_v2(
    input_actor,
    format('backup-respaldo-seguridad-quiksol-2026-08-22-%s.tar',input_suffix)
  );
  manifest:=public.record_database_backup_created_v2(
    input_actor,manifest.id,repeat(input_hash_char,64),4096,'temporary-round3',
    snapshot->>'schemaVersion',snapshot->>'migrationVersion',repeat('d',64),2048,
    (snapshot->>'tableCount')::integer,repeat('e',64),0,0,'{}'::text[],repeat(input_hash_char,64)
  );
  manifest:=public.verify_database_backup_manifest_v2(input_actor,manifest.id,manifest.evidence_hash);
  manifest:=public.mark_database_backup_downloaded_v2(input_actor,manifest.id,manifest.evidence_hash);
  return manifest;
end;
$$;

set local role service_role;
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='';

do $$
declare
  before_version bigint;
  after_version bigint;
begin
  select data_version into before_version from public.database_safety_state where singleton;
  insert into public.system_logs(level,module,action,message)
  values('info','database_safety_round3','observability_does_not_stale','Synthetic observability fixture.');
  select data_version into after_version from public.database_safety_state where singleton;
  if after_version<>before_version then raise exception 'OBSERVABILITY_STALE_REGRESSION'; end if;
end;
$$;

reset role;
create table public.round3_unclassified_table(id uuid primary key);
set local role service_role;

do $$
declare
  locked boolean:=false;
begin
  begin
    perform public.database_safety_current_snapshot_v2('f3000000-0000-4000-8000-000000000001');
  exception when sqlstate '55000' then
    locked:=sqlerrm like '%CATALOG_UNCLASSIFIED%';
  end;
  if not locked then raise exception 'UNKNOWN_TABLE_DID_NOT_LOCK'; end if;
end;
$$;

reset role;
drop table public.round3_unclassified_table;
set local role service_role;

do $$
declare
  manifest public.database_backup_manifests;
  stale_locked boolean:=false;
begin
  manifest:=pg_temp.round3_verified_manifest('f3000000-0000-4000-8000-000000000001','140002','a');
  begin
    insert into public.clients(name,created_by) values('Synthetic stale write','f3000000-0000-4000-8000-000000000001');
    perform public.arm_database_destruction_v2(
      'f3000000-0000-4000-8000-000000000001',manifest.id,repeat('1',64),repeat('2',64),repeat('3',64)
    );
  exception when sqlstate '55000' then
    stale_locked:=sqlerrm like '%BACKUP_STALE%';
  end;
  if not stale_locked then raise exception 'BUSINESS_WRITE_DID_NOT_STALE_BACKUP'; end if;
end;
$$;

reset role;
insert into storage.objects(id,bucket_id,name,owner,metadata)
values(
  'f3000000-0000-4000-8000-000000000020','excel-uploads','f3000000-0000-4000-8000-000000000001/synthetic.xlsx',
  'f3000000-0000-4000-8000-000000000001','{"size":4}'::jsonb
);
set local role service_role;
set local request.jwt.claim.role='service_role';
do $$
declare manifest public.database_backup_manifests;
begin
  manifest:=pg_temp.round3_verified_manifest('f3000000-0000-4000-8000-000000000001','140005','f');
  perform set_config('quiksol.round3_storage_manifest_id',manifest.id::text,true);
end;
$$;
reset role;
update storage.objects set bucket_id='avatars'
where id='f3000000-0000-4000-8000-000000000020';
set local role service_role;
set local request.jwt.claim.role='service_role';
do $$
declare stale_locked boolean:=false;
begin
  begin
    perform public.arm_database_destruction_v2(
      'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_storage_manifest_id')::uuid,
      repeat('1',64),repeat('2',64),repeat('3',64)
    );
  exception when sqlstate '55000' then stale_locked:=sqlerrm like '%BACKUP_STALE%'; end;
  if not stale_locked then raise exception 'STORAGE_BUCKET_MOVE_DID_NOT_STALE_BACKUP'; end if;
end;
$$;

do $$
declare
  manifest public.database_backup_manifests;
  operation public.database_destruction_operations;
begin
  manifest:=pg_temp.round3_verified_manifest('f3000000-0000-4000-8000-000000000001','140003','b');
  operation:=public.arm_database_destruction_v2(
    'f3000000-0000-4000-8000-000000000001',manifest.id,repeat('4',64),repeat('5',64),repeat('6',64)
  );
  perform set_config('quiksol.round3_operation_id',operation.id::text,true);
  perform set_config('quiksol.round3_manifest_id',manifest.id::text,true);
end;
$$;

reset role;
update public.database_destruction_operations
set not_before=clock_timestamp()-interval '1 second'
where id=current_setting('quiksol.round3_operation_id')::uuid;

set local role service_role;
set local request.jwt.claim.role='service_role';

do $$
declare locked boolean:=false;
begin
  begin
    perform public.execute_database_business_purge_v2(
      'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid,repeat('4',64),repeat('5',64)
    );
  exception when sqlstate '55000' then locked:=sqlerrm like '%DELETE_KILL_SWITCH_DISABLED%'; end;
  if not locked then raise exception 'KILL_SWITCH_DID_NOT_LOCK'; end if;
end;
$$;

reset role;
update public.database_safety_state set delete_enabled=true where singleton;
set local role service_role;
set local request.jwt.claim.role='service_role';

do $$
declare denied boolean:=false;
begin
  begin
    perform public.execute_database_business_purge_v2(
      'f3000000-0000-4000-8000-000000000002',current_setting('quiksol.round3_operation_id')::uuid,repeat('4',64),repeat('5',64)
    );
  exception when no_data_found then denied:=true;
           when others then denied:=sqlerrm like '%OPERATION_NOT_FOUND%'; end;
  if not denied then raise exception 'FOREIGN_OPERATION_ALLOWED'; end if;
end;
$$;

do $$
declare denied boolean:=false;
begin
  begin
    perform public.execute_database_business_purge_v2(
      'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid,repeat('9',64),repeat('5',64)
    );
  exception when insufficient_privilege then denied:=sqlerrm like '%CHALLENGE_INVALID%'; end;
  if not denied then raise exception 'FORGED_CHALLENGE_ALLOWED'; end if;
end;
$$;

do $$
declare expired boolean:=false;
begin
  begin
    update public.database_destruction_operations set challenge_expires_at=clock_timestamp()-interval '1 second'
    where id=current_setting('quiksol.round3_operation_id')::uuid;
    perform public.execute_database_business_purge_v2(
      'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid,repeat('4',64),repeat('5',64)
    );
  exception when sqlstate '55000' then expired:=sqlerrm like '%CHALLENGE_EXPIRED%'; end;
  if not expired then raise exception 'EXPIRED_CHALLENGE_ALLOWED'; end if;
end;
$$;

do $$
declare
  first_result jsonb;
  second_result jsonb;
  final_operation public.database_destruction_operations;
begin
  first_result:=public.execute_database_business_purge_v2(
    'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid,repeat('4',64),repeat('5',64)
  );
  second_result:=public.execute_database_business_purge_v2(
    'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid,repeat('4',64),repeat('5',64)
  );
  if first_result<>second_result then raise exception 'EXECUTE_NOT_IDEMPOTENT'; end if;
  begin
    perform public.execute_database_business_purge_v2(
      'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid,repeat('9',64),repeat('5',64)
    );
    raise exception 'IDEMPOTENT_RETRY_ACCEPTED_FORGED_CHALLENGE';
  exception when insufficient_privilege then
    null;
  end;
  if not public.claim_database_storage_cleanup_v2('f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid) then
    raise exception 'STORAGE_CLEANUP_NOT_CLAIMED';
  end if;
  final_operation:=public.finish_database_storage_cleanup_v2(
    'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid,false,0,'SYNTHETIC_STORAGE_FAILURE'
  );
  if final_operation.storage_status<>'failed' then raise exception 'STORAGE_FAILURE_NOT_RECORDED'; end if;
  if not public.claim_database_storage_cleanup_v2('f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid) then
    raise exception 'STORAGE_RECOVERY_NOT_RETRYABLE';
  end if;
  final_operation:=public.finish_database_storage_cleanup_v2(
    'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_operation_id')::uuid,true,0,null
  );
  if final_operation.status<>'completed' or final_operation.storage_status<>'completed' then
    raise exception 'STORAGE_SAGA_NOT_COMPLETED';
  end if;
end;
$$;

reset role;

do $$
begin
  if exists(select 1 from public.clients where id='f3000000-0000-4000-8000-000000000010') then
    raise exception 'SYNTHETIC_BUSINESS_ROW_NOT_PURGED';
  end if;
  if not exists(select 1 from public.profiles where id='f3000000-0000-4000-8000-000000000001' and role='super_admin_dev') then
    raise exception 'PROTECTED_IDENTITY_REMOVED';
  end if;
  if not exists(select 1 from public.system_logs where module='database_safety_round3') then
    raise exception 'PRESERVED_OBSERVABILITY_REMOVED';
  end if;
  if (select count(*) from public.database_safety_audit_events where operation_id=current_setting('quiksol.round3_operation_id')::uuid and event_type='business_database_deleted')<>1 then
    raise exception 'DATABASE_AUDIT_NOT_IDEMPOTENT';
  end if;
  if (select count(*) from public.database_safety_audit_events where operation_id=current_setting('quiksol.round3_operation_id')::uuid and event_type='business_information_deleted')<>1 then
    raise exception 'FINAL_AUDIT_NOT_IDEMPOTENT';
  end if;
end;
$$;

-- Transactional rollback injection uses a fresh evidence lifecycle.
insert into public.clients(id,name,created_by)
values('f3000000-0000-4000-8000-000000000011','Synthetic Rollback Client','f3000000-0000-4000-8000-000000000001');

set local role service_role;
set local request.jwt.claim.role='service_role';
do $$
declare manifest public.database_backup_manifests; operation public.database_destruction_operations;
begin
  manifest:=pg_temp.round3_verified_manifest('f3000000-0000-4000-8000-000000000001','140004','c');
  operation:=public.arm_database_destruction_v2('f3000000-0000-4000-8000-000000000001',manifest.id,repeat('7',64),repeat('8',64),null);
  perform set_config('quiksol.round3_rollback_operation_id',operation.id::text,true);
end;
$$;
reset role;
update public.database_destruction_operations set not_before=clock_timestamp()-interval '1 second'
where id=current_setting('quiksol.round3_rollback_operation_id')::uuid;

set local role service_role;
set local request.jwt.claim.role='service_role';
do $$
declare failed boolean:=false;
begin
  begin
    perform set_config('quiksol.database_safety_fail_after_table','clients',true);
    perform public.execute_database_business_purge_v2(
      'f3000000-0000-4000-8000-000000000001',current_setting('quiksol.round3_rollback_operation_id')::uuid,repeat('7',64),repeat('8',64)
    );
  exception when others then failed:=sqlerrm like '%INJECTED_DELETE_FAILURE%'; end;
  if not failed then raise exception 'ROLLBACK_FAILURE_NOT_INJECTED'; end if;
  perform set_config('quiksol.database_safety_fail_after_table','',true);
end;
$$;
reset role;

do $$
begin
  if not exists(select 1 from public.clients where id='f3000000-0000-4000-8000-000000000011') then
    raise exception 'TRANSACTIONAL_ROLLBACK_FAILED';
  end if;
  if exists(select 1 from public.database_destruction_operations where id=current_setting('quiksol.round3_rollback_operation_id')::uuid and challenge_used_at is not null) then
    raise exception 'ROLLBACK_CONSUMED_CHALLENGE';
  end if;
end;
$$;

rollback;
