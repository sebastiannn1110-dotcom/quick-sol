-- Ronda 7 watermark semantics. Synthetic fixtures in a disposable full-migration database only.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() !~ '^quiksol_round7_watermark_test(_[a-z0-9]+)?$'
     or current_setting('quiksol.allow_round7_watermark_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_ROUND7_WATERMARK_TEST_DATABASE';
  end if;
end;
$$;

insert into auth.users(id,email,raw_user_meta_data)
values('f7000000-0000-4000-8000-000000000001','round7-watermark@example.invalid','{}'::jsonb)
on conflict(id) do nothing;

update public.profiles
set role='super_admin_dev',is_active=true
where id='f7000000-0000-4000-8000-000000000001';

insert into storage.buckets(id,name,public)
values('client-assets','client-assets',false),('avatars','avatars',false)
on conflict(id) do nothing;

do $$
declare
  before_data bigint;
  after_data bigint;
begin
  select data_version into before_data from public.database_safety_current_watermarks_v3();
  insert into public.clients(id,name,created_by) values
    ('f7000000-0000-4000-8000-000000000011','Synthetic R7 statement A','f7000000-0000-4000-8000-000000000001'),
    ('f7000000-0000-4000-8000-000000000012','Synthetic R7 statement B','f7000000-0000-4000-8000-000000000001');
  select data_version into after_data from public.database_safety_current_watermarks_v3();
  if after_data <> before_data + 1 then
    raise exception 'STATEMENT_LEVEL_WATERMARK_DELTA_INVALID:%:%',before_data,after_data;
  end if;
end;
$$;

do $$
declare
  before_data bigint;
  after_data bigint;
begin
  select data_version into before_data from public.database_safety_current_watermarks_v3();
  begin
    insert into public.clients(id,name,created_by)
    values('f7000000-0000-4000-8000-000000000013','Synthetic R7 rollback','f7000000-0000-4000-8000-000000000001');
    raise exception 'INJECTED_ROLLBACK';
  exception when others then
    null;
  end;
  select data_version into after_data from public.database_safety_current_watermarks_v3();
  if after_data <> before_data + 1 then
    raise exception 'ROLLED_BACK_WRITE_DID_NOT_ADVANCE_WATERMARK:%:%',before_data,after_data;
  end if;
  if exists(select 1 from public.clients where id='f7000000-0000-4000-8000-000000000013') then
    raise exception 'ROLLED_BACK_FIXTURE_PERSISTED';
  end if;
end;
$$;

do $$
declare
  before_data bigint;
  after_data bigint;
begin
  select data_version into before_data from public.database_safety_current_watermarks_v3();
  insert into public.system_logs(level,module,action,message)
  values('info','round7_watermark','preserve_contract','Synthetic observability fixture.');
  select data_version into after_data from public.database_safety_current_watermarks_v3();
  if after_data <> before_data then
    raise exception 'PRESERVED_WRITE_STALED_BACKUP:%:%',before_data,after_data;
  end if;
end;
$$;

select set_config('request.jwt.claim.role','service_role',false);

do $$
declare
  actor constant uuid := 'f7000000-0000-4000-8000-000000000001';
  manifest public.database_backup_manifests;
  stale_locked boolean := false;
begin
  manifest:=public.begin_database_backup_manifest_v2(
    actor,'backup-respaldo-seguridad-quiksol-2026-08-25-120701.tar'
  );
  manifest:=public.record_database_backup_created_v2(
    actor,manifest.id,repeat('a',64),4096,'temporary-round7',
    manifest.schema_version,manifest.migration_version,repeat('b',64),2048,
    manifest.table_count,repeat('c',64),0,0,'{}'::text[],repeat('d',64)
  );
  insert into public.clients(id,name,created_by)
  values('f7000000-0000-4000-8000-000000000014','Synthetic R7 stale','f7000000-0000-4000-8000-000000000001');
  begin
    perform public.verify_database_backup_manifest_v2(actor,manifest.id,manifest.evidence_hash);
  exception when sqlstate '55000' then
    stale_locked:=sqlerrm like '%BACKUP_STALE%';
  end;
  if not stale_locked then raise exception 'BUSINESS_WRITE_DID_NOT_STALE_BACKUP'; end if;
end;
$$;

do $$
declare
  actor constant uuid := 'f7000000-0000-4000-8000-000000000001';
  manifest public.database_backup_manifests;
  stale_locked boolean := false;
begin
  manifest:=public.begin_database_backup_manifest_v2(
    actor,'backup-respaldo-seguridad-quiksol-2026-08-25-120702.tar'
  );
  manifest:=public.record_database_backup_created_v2(
    actor,manifest.id,repeat('e',64),4096,'temporary-round7',
    manifest.schema_version,manifest.migration_version,repeat('f',64),2048,
    manifest.table_count,repeat('1',64),0,0,'{}'::text[],repeat('2',64)
  );
  insert into storage.objects(id,bucket_id,name,owner,metadata)
  values('f7000000-0000-4000-8000-000000000021','client-assets','synthetic/r7.txt',actor,'{}'::jsonb);
  begin
    perform public.verify_database_backup_manifest_v2(actor,manifest.id,manifest.evidence_hash);
  exception when sqlstate '55000' then
    stale_locked:=sqlerrm like '%BACKUP_STALE%';
  end;
  if not stale_locked then raise exception 'STORAGE_WRITE_DID_NOT_STALE_BACKUP'; end if;
end;
$$;

do $$
declare
  actor constant uuid := 'f7000000-0000-4000-8000-000000000001';
  before_storage bigint;
  after_storage bigint;
begin
  select storage_version into before_storage from public.database_safety_current_watermarks_v3();
  insert into storage.objects(id,bucket_id,name,owner,metadata)
  values('f7000000-0000-4000-8000-000000000022','avatars','synthetic/avatar.png',actor,'{}'::jsonb);
  select storage_version into after_storage from public.database_safety_current_watermarks_v3();
  if after_storage <> before_storage then
    raise exception 'PRESERVED_STORAGE_WRITE_STALED_BACKUP:%:%',before_storage,after_storage;
  end if;
end;
$$;

do $$
declare
  snapshot jsonb;
  current_data bigint;
  current_storage bigint;
  purge_definition text;
begin
  snapshot:=public.database_safety_current_snapshot_v2('f7000000-0000-4000-8000-000000000001');
  select data_version,storage_version into current_data,current_storage
  from public.database_safety_current_watermarks_v3();
  if (snapshot->>'dataVersion')::bigint <> current_data
     or (snapshot->>'storageVersion')::bigint <> current_storage
     or coalesce((snapshot->>'deleteEnabledInDatabase')::boolean,true) then
    raise exception 'SNAPSHOT_WATERMARK_NOT_AUTHORITATIVE';
  end if;
  select pg_get_functiondef(
    'public.execute_database_business_purge_v2(uuid,uuid,text,text)'::regprocedure
  ) into purge_definition;
  if purge_definition not like '%DELETE_KILL_SWITCH_DISABLED%'
     or purge_definition not like '%delete_enabled%' then
    raise exception 'ROUND7_DELETE_LOCK_CONTRACT_MISSING';
  end if;
end;
$$;

select set_config('request.jwt.claim.role','',false);
