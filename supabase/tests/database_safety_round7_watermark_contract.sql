-- Ronda 7 watermark contracts. Run only after the full migration chain in a disposable database.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() !~ '^quiksol_round7_watermark_test(_[a-z0-9]+)?$'
     or current_setting('quiksol.allow_round7_watermark_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_ROUND7_WATERMARK_TEST_DATABASE';
  end if;
end;
$$;

do $$
declare
  preflight jsonb;
  routine regprocedure;
  role_name text;
  legacy regprocedure;
  v2_routines regprocedure[] := array[
    'public.database_safety_table_catalog_v2()'::regprocedure,
    'public.database_safety_storage_catalog_v2()'::regprocedure,
    'public.database_safety_catalog_version_v2()'::regprocedure,
    'public.assert_database_safety_backend_actor_v2(uuid)'::regprocedure,
    'public.database_safety_catalog_preflight_v2()'::regprocedure,
    'public.database_safety_counts_v2(text)'::regprocedure,
    'public.database_safety_current_snapshot_v2(uuid)'::regprocedure,
    'public.database_safety_dry_run_v2(uuid)'::regprocedure,
    'public.begin_database_backup_manifest_v2(uuid,text)'::regprocedure,
    'public.record_database_backup_created_v2(uuid,uuid,text,bigint,text,text,text,text,bigint,integer,text,bigint,bigint,text[],text)'::regprocedure,
    'public.verify_database_backup_manifest_v2(uuid,uuid,text)'::regprocedure,
    'public.fail_database_backup_manifest_v2(uuid,uuid,text)'::regprocedure,
    'public.mark_database_backup_downloaded_v2(uuid,uuid,text)'::regprocedure,
    'public.arm_database_destruction_v2(uuid,uuid,text,text,text)'::regprocedure,
    'public.cancel_database_destruction_v2(uuid,uuid)'::regprocedure,
    'public.fail_database_destruction_v2(uuid,uuid,text)'::regprocedure,
    'public.execute_database_business_purge_v2(uuid,uuid,text,text)'::regprocedure,
    'public.claim_database_storage_cleanup_v2(uuid,uuid)'::regprocedure,
    'public.finish_database_storage_cleanup_v2(uuid,uuid,boolean,integer,text)'::regprocedure
  ];
  legacy_routines regprocedure[] := array[
    'public.database_safety_current_snapshot()'::regprocedure,
    'public.database_safety_dry_run()'::regprocedure,
    'public.register_database_backup_manifest(text,text,bigint,integer,text,text,text,bigint,boolean)'::regprocedure,
    'public.mark_database_backup_downloaded(uuid,text)'::regprocedure,
    'public.arm_database_destruction(uuid,text,text,text)'::regprocedure,
    'public.cancel_database_destruction(uuid)'::regprocedure,
    'public.fail_database_destruction(uuid,text)'::regprocedure,
    'public.execute_database_business_purge(uuid,text,text)'::regprocedure
  ];
begin
  if to_regclass('public.database_safety_data_version_seq') is null
     or to_regclass('public.database_safety_storage_version_seq') is null then
    raise exception 'ROUND7_WATERMARK_SEQUENCE_MISSING';
  end if;

  if exists (
    select 1 from pg_sequences
    where schemaname = 'public'
      and sequencename in ('database_safety_data_version_seq','database_safety_storage_version_seq')
      and (cache_size <> 1 or cycle)
  ) or (
    select count(*) from pg_sequences
    where schemaname = 'public'
      and sequencename in ('database_safety_data_version_seq','database_safety_storage_version_seq')
  ) <> 2 then
    raise exception 'ROUND7_WATERMARK_SEQUENCE_CONTRACT_INVALID';
  end if;

  if (select count(*) from public.database_safety_table_catalog_v2() where planned_action='DELETE') <> 47
     or (select count(*) from public.database_safety_table_catalog_v2() where planned_action='PRESERVE') <> 25
     or (select count(*) from public.database_safety_table_catalog_v2() where schema_name='public') <> 68 then
    raise exception 'ROUND7_DATABASE_SAFETY_CATALOG_COUNT_INVALID';
  end if;

  if exists (
    (select format('%I.%I',schema_name,table_name)
     from public.database_safety_table_catalog_v2()
     where schema_name='public' and planned_action='DELETE')
    except
    (select format('%I.%I',n.nspname,c.relname)
     from pg_trigger t
     join pg_class c on c.oid=t.tgrelid
     join pg_namespace n on n.oid=c.relnamespace
     join pg_proc p on p.oid=t.tgfoid
     where not t.tgisinternal and t.tgname='database_safety_watermark'
       and p.proname='touch_database_safety_watermark')
  ) or exists (
    (select format('%I.%I',n.nspname,c.relname)
     from pg_trigger t
     join pg_class c on c.oid=t.tgrelid
     join pg_namespace n on n.oid=c.relnamespace
     join pg_proc p on p.oid=t.tgfoid
     where not t.tgisinternal and t.tgname='database_safety_watermark'
       and p.proname='touch_database_safety_watermark')
    except
    (select format('%I.%I',schema_name,table_name)
     from public.database_safety_table_catalog_v2()
     where schema_name='public' and planned_action='DELETE')
  ) then
    raise exception 'ROUND7_DELETE_WATERMARK_TRIGGER_COVERAGE_INVALID';
  end if;

  if exists (
    select 1
    from pg_trigger t
    join pg_proc p on p.oid=t.tgfoid
    where not t.tgisinternal and p.proname='touch_database_safety_watermark'
      and ((t.tgtype::integer & 1) <> 0
        or (t.tgtype::integer & 4) = 0
        or (t.tgtype::integer & 8) = 0
        or (t.tgtype::integer & 16) = 0
        or (t.tgtype::integer & 32) = 0)
  ) then
    raise exception 'ROUND7_WATERMARK_NOT_STATEMENT_LEVEL_ALL_EVENTS';
  end if;

  preflight := public.database_safety_catalog_preflight_v2();
  if not coalesce((preflight->>'classified')::boolean,false)
     or jsonb_array_length(preflight->'missing') <> 0
     or jsonb_array_length(preflight->'unclassified') <> 0 then
    raise exception 'ROUND7_DATABASE_SAFETY_PREFLIGHT_FAILED';
  end if;

  if coalesce((select delete_enabled from public.database_safety_state where singleton),true) then
    raise exception 'ROUND7_DELETE_KILL_SWITCH_ENABLED';
  end if;

  foreach routine in array v2_routines loop
    foreach role_name in array array['anon','authenticated'] loop
      if has_function_privilege(role_name,routine,'EXECUTE') then
        raise exception 'ROUND7_V2_RPC_GRANT_TOO_BROAD:%:%',routine,role_name;
      end if;
    end loop;
    if exists (
      select 1
      from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where p.oid=routine and acl.grantee=0 and acl.privilege_type='EXECUTE'
    ) then
      raise exception 'ROUND7_V2_RPC_PUBLIC_EXECUTE:%',routine;
    end if;
    if not has_function_privilege('service_role',routine,'EXECUTE') then
      raise exception 'ROUND7_V2_RPC_SERVICE_ROLE_MISSING:%',routine;
    end if;
  end loop;

  foreach legacy in array legacy_routines loop
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(role_name,legacy,'EXECUTE') then
        raise exception 'ROUND7_LEGACY_RPC_EXECUTE_PRESENT:%:%',legacy,role_name;
      end if;
    end loop;
    if exists (
      select 1
      from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where p.oid=legacy and acl.grantee=0 and acl.privilege_type='EXECUTE'
    ) then
      raise exception 'ROUND7_LEGACY_RPC_PUBLIC_EXECUTE:%',legacy;
    end if;
  end loop;

  foreach routine in array array[
    'public.database_safety_watermark_lock_key_v3()'::regprocedure,
    'public.database_safety_current_watermarks_v3()'::regprocedure,
    'public.database_safety_capture_watermarks_v3()'::regprocedure,
    'public.touch_database_safety_watermark()'::regprocedure,
    'public.touch_database_safety_storage_watermark_v2()'::regprocedure
  ] loop
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(role_name,routine,'EXECUTE') then
        raise exception 'ROUND7_INTERNAL_FUNCTION_EXPOSED:%:%',routine,role_name;
      end if;
    end loop;
    if exists (
      select 1
      from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where p.oid=routine and acl.grantee=0 and acl.privilege_type='EXECUTE'
    ) then
      raise exception 'ROUND7_INTERNAL_FUNCTION_PUBLIC:%',routine;
    end if;
  end loop;

  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_sequence_privilege(role_name,'public.database_safety_data_version_seq','USAGE')
       or has_sequence_privilege(role_name,'public.database_safety_data_version_seq','SELECT')
       or has_sequence_privilege(role_name,'public.database_safety_data_version_seq','UPDATE')
       or has_sequence_privilege(role_name,'public.database_safety_storage_version_seq','USAGE')
       or has_sequence_privilege(role_name,'public.database_safety_storage_version_seq','SELECT')
       or has_sequence_privilege(role_name,'public.database_safety_storage_version_seq','UPDATE') then
      raise exception 'ROUND7_WATERMARK_SEQUENCE_EXPOSED:%',role_name;
    end if;
  end loop;
end;
$$;
