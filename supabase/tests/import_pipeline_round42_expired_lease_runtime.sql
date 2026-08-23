-- Ronda 4.2 expired/null lease fencing contract. Synthetic disposable DB only.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() !~ '^quiksol_import_round4_test(_[a-z0-9]+)?$' then
    raise exception 'REFUSING_NON_RONDA4_TEST_DATABASE';
  end if;
end;
$$;

begin;

set local request.jwt.claim.role='service_role';

do $$
declare
  function_name text;
  function_oid oid;
  definition text;
begin
  foreach function_name in array array[
    'stage_import_job_rows_v2',
    'update_import_job_progress_v2',
    'validate_import_job_staging_v2',
    'publish_import_job_v2',
    'fail_import_job_v2'
  ]
  loop
    select procedure.oid, lower(pg_get_functiondef(procedure.oid))
    into function_oid, definition
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='public' and procedure.proname=function_name;

    if function_oid is null
       or not (select prosecdef from pg_proc where oid=function_oid)
       or (select pg_get_userbyid(proowner) from pg_proc where oid=function_oid)<>'postgres'
       or not ((select proconfig from pg_proc where oid=function_oid) @> array['search_path=pg_catalog, public'])
       or position('job.lease_expires_at is null' in definition)=0
       or position('job.lease_expires_at<=clock_timestamp()' in regexp_replace(definition,'\s+','','g'))=0 then
      raise exception 'R42_MUTATOR_CONTRACT_INVALID: %',function_name;
    end if;
  end loop;

  select procedure.oid into function_oid
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid=procedure.pronamespace
  where namespace.nspname='public' and procedure.proname='fail_import_job_v2';

  if has_function_privilege('public',function_oid,'execute')
     or has_function_privilege('anon',function_oid,'execute')
     or has_function_privilege('authenticated',function_oid,'execute')
     or not has_function_privilege('service_role',function_oid,'execute') then
    raise exception 'R42_FAIL_GRANT_MATRIX_INVALID';
  end if;
end;
$$;

do $$
declare
  preflight jsonb;
begin
  if exists(
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join lateral aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) privilege
    where namespace.nspname='public'
      and relation.relname in ('import_jobs','upload_batches')
      and privilege.grantee in (0::oid,(select oid from pg_roles where rolname='anon'))
  ) then
    raise exception 'R42_PUBLIC_OR_ANON_IMPORT_PRIVILEGES_PRESENT';
  end if;

  if exists(
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join lateral aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) privilege
    where namespace.nspname='public'
      and relation.relname in ('import_jobs','upload_batches')
      and privilege.grantee=(select oid from pg_roles where rolname='authenticated')
      and privilege.privilege_type<>'SELECT'
  ) then
    raise exception 'R42_AUTHENTICATED_MUTATING_IMPORT_PRIVILEGES_PRESENT';
  end if;

  if not has_table_privilege('authenticated','public.import_jobs','select')
     or not has_table_privilege('authenticated','public.upload_batches','select') then
    raise exception 'R42_AUTHENTICATED_READ_ACCESS_MISSING';
  end if;

  if exists(
    select 1 from pg_class relation
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='public'
      and relation.relname in ('import_jobs','upload_batches')
      and not relation.relrowsecurity
  ) then
    raise exception 'R42_IMPORT_RLS_DISABLED';
  end if;

  preflight:=public.database_safety_catalog_preflight_v2();
  if not coalesce((preflight->>'classified')::boolean,false)
     or jsonb_array_length(coalesce(preflight->'missing','[]'::jsonb))<>0
     or jsonb_array_length(coalesce(preflight->'unclassified','[]'::jsonb))<>0 then
    raise exception 'R42_DATABASE_SAFETY_PREFLIGHT_INVALID';
  end if;

  if not exists(
    select 1 from public.database_safety_table_catalog_v2()
    where schema_name='public' and table_name='import_job_staging_rows' and planned_action='DELETE'
  ) or not exists(
    select 1 from public.database_safety_table_catalog_v2()
    where schema_name='public' and table_name='worker_runtime_heartbeats' and planned_action='PRESERVE'
  ) then
    raise exception 'R42_DATABASE_SAFETY_CLASSIFICATION_INVALID';
  end if;

  if coalesce((select delete_enabled from public.database_safety_state where singleton),true) then
    raise exception 'R42_DATABASE_SAFETY_DELETE_NOT_LOCKED';
  end if;
end;
$$;

insert into auth.users(id,email,raw_user_meta_data) values (
  '81000000-0000-4000-8000-000000000001',
  'r42-runtime@example.invalid',
  '{"full_name":"R42 Runtime Synthetic"}'
);

select public.create_import_upload_v2(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000001',
  'r42-runtime.csv','text/csv',64,'Auto Detect','QA','TEST','',
  'standard','r42-runtime',3
);

insert into storage.objects(id,bucket_id,name,owner,metadata) values (
  '84000000-0000-4000-8000-000000000001',
  'excel-uploads',
  '81000000-0000-4000-8000-000000000001/82000000-0000-4000-8000-000000000001/r42-runtime.csv',
  '81000000-0000-4000-8000-000000000001',
  '{"size":"64"}'
);

select public.finalize_import_upload_v2(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000001'
);

create temporary table r42_claim_a as
select * from public.claim_import_job_v2('r42-worker-a',120);

select public.stage_import_job_rows_v2(
  '83000000-0000-4000-8000-000000000001',
  'r42-worker-a',
  1,
  (select lease_token from r42_claim_a),
  'sheet',
  '[{"rowKey":"r42-sheet","payload":{"id":"85000000-0000-4000-8000-000000000001","sheet_name":"R42","detected_header_row":1,"total_rows":1,"valid_rows":1,"invalid_rows":0,"detected_category":"Generic","recognized_columns":["mpn"]}}]'
);

savepoint r42_valid_fail;

do $$
begin
  perform public.fail_import_job_v2(
    '83000000-0000-4000-8000-000000000001',
    'r42-worker-a',
    1,
    (select lease_token from r42_claim_a),
    'R42_VALID_WORKER_FAIL',
    false
  );

  if not exists(
    select 1 from public.import_jobs
    where id='83000000-0000-4000-8000-000000000001'
      and status='failed' and publication_state='failed'
  ) or exists(
    select 1 from public.import_job_staging_rows
    where job_id='83000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'R42_VALID_FAIL_REGRESSION';
  end if;
end;
$$;

rollback to savepoint r42_valid_fail;

update public.import_jobs
set lease_expires_at=clock_timestamp()-interval '1 second'
where id='83000000-0000-4000-8000-000000000001';

do $$
declare
  fenced_error text;
  renewal jsonb;
begin
  begin
    perform public.stage_import_job_rows_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),'sheet','[]'
    );
    raise exception 'R42_EXPIRED_STAGE_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_EXPIRED_STAGE_WRONG_ERROR'; end if;
  end;

  begin
    perform public.update_import_job_progress_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),'{"totalRows":1,"progressPercent":10}'
    );
    raise exception 'R42_EXPIRED_PROGRESS_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_EXPIRED_PROGRESS_WRONG_ERROR'; end if;
  end;

  begin
    perform public.validate_import_job_staging_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),64,repeat('a',64)
    );
    raise exception 'R42_EXPIRED_VALIDATE_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_EXPIRED_VALIDATE_WRONG_ERROR'; end if;
  end;

  begin
    perform public.publish_import_job_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),
      '{"totalRows":1,"validRows":1,"invalidRows":0,"sheetCount":1}'
    );
    raise exception 'R42_EXPIRED_PUBLISH_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_EXPIRED_PUBLISH_WRONG_ERROR'; end if;
  end;

  begin
    perform public.fail_import_job_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),'R42_EXPIRED_FAIL',false
    );
    raise exception 'R42_EXPIRED_FAIL_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_EXPIRED_FAIL_WRONG_ERROR'; end if;
  end;

  renewal:=public.renew_import_job_lease_v2(
    '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
    (select lease_token from r42_claim_a),120
  );
  if coalesce((renewal->>'renewed')::boolean,true) then
    raise exception 'R42_EXPIRED_RENEW_ALLOWED';
  end if;

  if not exists(
    select 1 from public.import_jobs
    where id='83000000-0000-4000-8000-000000000001'
      and status='processing' and publication_state='staging'
      and generation=1
      and lease_token=(select lease_token from r42_claim_a)
      and lease_owner='r42-worker-a'
  ) or (select count(*) from public.import_job_staging_rows
        where job_id='83000000-0000-4000-8000-000000000001')<>1 then
    raise exception 'R42_EXPIRED_ATTEMPT_MUTATED_STATE';
  end if;
end;
$$;

update public.import_jobs
set lease_expires_at=null
where id='83000000-0000-4000-8000-000000000001';

do $$
declare
  fenced_error text;
  renewal jsonb;
begin
  begin
    perform public.stage_import_job_rows_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),'sheet','[]'
    );
    raise exception 'R42_NULL_STAGE_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_NULL_STAGE_WRONG_ERROR'; end if;
  end;

  begin
    perform public.update_import_job_progress_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),'{"totalRows":1,"progressPercent":10}'
    );
    raise exception 'R42_NULL_PROGRESS_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_NULL_PROGRESS_WRONG_ERROR'; end if;
  end;

  begin
    perform public.validate_import_job_staging_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),64,repeat('a',64)
    );
    raise exception 'R42_NULL_VALIDATE_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_NULL_VALIDATE_WRONG_ERROR'; end if;
  end;

  begin
    perform public.publish_import_job_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),
      '{"totalRows":1,"validRows":1,"invalidRows":0,"sheetCount":1}'
    );
    raise exception 'R42_NULL_PUBLISH_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_NULL_PUBLISH_WRONG_ERROR'; end if;
  end;

  begin
    perform public.fail_import_job_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),'R42_NULL_FAIL',false
    );
    raise exception 'R42_NULL_FAIL_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_NULL_FAIL_WRONG_ERROR'; end if;
  end;

  renewal:=public.renew_import_job_lease_v2(
    '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
    (select lease_token from r42_claim_a),120
  );
  if coalesce((renewal->>'renewed')::boolean,true) then
    raise exception 'R42_NULL_RENEW_ALLOWED';
  end if;

  if not exists(
    select 1 from public.import_jobs
    where id='83000000-0000-4000-8000-000000000001'
      and status='processing' and publication_state='staging'
      and generation=1
      and lease_token=(select lease_token from r42_claim_a)
      and lease_owner='r42-worker-a'
      and lease_expires_at is null
  ) or (select count(*) from public.import_job_staging_rows
        where job_id='83000000-0000-4000-8000-000000000001')<>1 then
    raise exception 'R42_NULL_ATTEMPT_MUTATED_STATE';
  end if;
end;
$$;

update public.import_jobs
set lease_expires_at=clock_timestamp()-interval '1 second'
where id='83000000-0000-4000-8000-000000000001';

select public.recover_stale_import_jobs_v2('r42-recovery',25);

do $$
begin
  if not exists(
    select 1 from public.import_jobs
    where id='83000000-0000-4000-8000-000000000001'
      and status='retrying'
      and generation=(select generation from r42_claim_a)
      and lease_token=(select lease_token from r42_claim_a)+1
      and lease_owner is null and lease_expires_at is null
  ) then
    raise exception 'R42_STALE_RECOVERY_STATE_INVALID';
  end if;

  if exists(
    select 1 from public.import_job_staging_rows
    where job_id='83000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'R42_STALE_RECOVERY_DID_NOT_CLEAN_STAGING';
  end if;
end;
$$;

create temporary table r42_claim_b as
select * from public.claim_import_job_v2('r42-worker-b',120);

do $$
declare
  fenced_error text;
begin
  if (select count(*) from r42_claim_b)<>1
     or (select generation from r42_claim_b)<>(select generation from r42_claim_a)
     or (select lease_token from r42_claim_b)<>(select lease_token from r42_claim_a)+2
     or (select lease_owner from r42_claim_b)<>'r42-worker-b'
     or (select lease_expires_at from r42_claim_b)<=clock_timestamp() then
    raise exception 'R42_NEW_WORKER_CLAIM_INVALID';
  end if;

  begin
    perform public.fail_import_job_v2(
      '83000000-0000-4000-8000-000000000001','r42-worker-a',1,
      (select lease_token from r42_claim_a),'R42_STALE_A_FAIL',false
    );
    raise exception 'R42_STALE_WORKER_A_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics fenced_error=message_text;
    if fenced_error<>'IMPORT_WORKER_FENCED' then raise exception 'R42_STALE_A_WRONG_ERROR'; end if;
  end;
end;
$$;

select public.stage_import_job_rows_v2(
  '83000000-0000-4000-8000-000000000001',
  'r42-worker-b',
  1,
  (select lease_token from r42_claim_b),
  'sheet',
  '[{"rowKey":"r42-sheet-b","payload":{"id":"85000000-0000-4000-8000-000000000002","sheet_name":"R42-B","detected_header_row":1,"total_rows":1,"valid_rows":1,"invalid_rows":0,"detected_category":"Generic","recognized_columns":["mpn"]}}]'
);

select public.update_import_job_progress_v2(
  '83000000-0000-4000-8000-000000000001',
  'r42-worker-b',
  1,
  (select lease_token from r42_claim_b),
  '{"totalRows":1,"progressPercent":25}'
);

select public.fail_import_job_v2(
  '83000000-0000-4000-8000-000000000001',
  'r42-worker-b',
  1,
  (select lease_token from r42_claim_b),
  'R42_VALID_NEW_WORKER_FAIL',
  false
);

do $$
begin
  if not exists(
    select 1 from public.import_jobs
    where id='83000000-0000-4000-8000-000000000001'
      and status='failed' and publication_state='failed'
      and generation=1
  ) or exists(
    select 1 from public.import_job_staging_rows
    where job_id='83000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'R42_NEW_WORKER_COMPLETION_INVALID';
  end if;
end;
$$;

rollback;

select 'ROUND42_EXPIRED_LEASE_FENCING_OK' as result;
