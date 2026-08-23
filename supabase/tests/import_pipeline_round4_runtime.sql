-- Ronda 4 destructive/concurrency contract tests. Synthetic disposable DB only.
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

insert into auth.users(id,email,raw_user_meta_data) values
  ('10000000-0000-4000-8000-000000000001','round4-owner@example.invalid','{"full_name":"Synthetic Owner"}'),
  ('10000000-0000-4000-8000-000000000002','round4-other@example.invalid','{"full_name":"Synthetic Other"}');

do $$
declare
  fn regprocedure;
  function_names text[] := array[
    'create_import_upload_v2(uuid,uuid,uuid,text,text,bigint,text,text,text,text,text,text,integer)',
    'finalize_import_upload_v2(uuid,uuid,uuid)',
    'fail_import_upload_initialization_v2(uuid,uuid,uuid,text)',
    'request_import_job_cancel_v2(uuid,uuid)',
    'request_import_job_retry_v2(uuid,uuid)',
    'recover_stale_import_jobs_v2(text,integer)',
    'claim_import_job_v2(text,integer)',
    'renew_import_job_lease_v2(uuid,text,bigint,bigint,integer)',
    'stage_import_job_rows_v2(uuid,text,bigint,bigint,text,jsonb)',
    'update_import_job_progress_v2(uuid,text,bigint,bigint,jsonb)',
    'validate_import_job_staging_v2(uuid,text,bigint,bigint,bigint,text)',
    'publish_import_job_v2(uuid,text,bigint,bigint,jsonb)',
    'fail_import_job_v2(uuid,text,bigint,bigint,text,boolean)',
    'safe_finalize_import_job_v2(uuid,uuid,text)',
    'record_worker_runtime_heartbeat_v2(text,text,timestamptz,jsonb)'
  ];
begin
  foreach fn in array function_names loop
    if has_function_privilege('public',fn,'execute')
      or has_function_privilege('anon',fn,'execute')
      or has_function_privilege('authenticated',fn,'execute')
      or not has_function_privilege('service_role',fn,'execute') then
      raise exception 'ROUND4_GRANT_MATRIX_INVALID: %',fn;
    end if;
  end loop;
  if has_function_privilege('service_role','public.claim_import_job(text,interval)','execute') then
    raise exception 'LEGACY_CLAIM_STILL_EXECUTABLE';
  end if;
end;
$$;

do $$
begin
  if exists(
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join lateral aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) privilege
    where namespace.nspname='public'
      and relation.relname in ('import_jobs','upload_batches')
      and privilege.grantee=(select oid from pg_roles where rolname='anon')
  ) then
    raise exception 'ANON_IMPORT_TABLE_PRIVILEGES_PRESENT';
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
    raise exception 'AUTHENTICATED_NON_READ_IMPORT_PRIVILEGES_PRESENT';
  end if;
  if not has_table_privilege('authenticated','public.import_jobs','select')
     or not has_table_privilege('authenticated','public.upload_batches','select') then
    raise exception 'AUTHENTICATED_IMPORT_READ_ACCESS_MISSING';
  end if;
  if has_table_privilege('authenticated','public.import_jobs','insert')
     or has_table_privilege('authenticated','public.import_jobs','update')
     or has_table_privilege('authenticated','public.import_jobs','delete')
     or has_table_privilege('authenticated','public.upload_batches','insert')
     or has_table_privilege('authenticated','public.upload_batches','update')
     or has_table_privilege('authenticated','public.import_jobs','truncate')
     or has_table_privilege('authenticated','public.upload_batches','truncate') then
    raise exception 'AUTHENTICATED_IMPORT_LIFECYCLE_DML_PRESENT';
  end if;
end;
$$;

set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000001';
do $$
begin
  begin
    insert into public.import_jobs(
      upload_batch_id,uploaded_by,status,storage_bucket,storage_path,original_file_name,
      replacement_scope_key
    ) values (
      gen_random_uuid(),'10000000-0000-4000-8000-000000000001','queued','excel-uploads',
      'forged/path.csv','forged.csv',gen_random_uuid()::text
    );
    raise exception 'DIRECT_JOB_INSERT_WAS_ALLOWED';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.import_jobs set status='completed';
    raise exception 'DIRECT_JOB_UPDATE_WAS_ALLOWED';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
set local request.jwt.claim.role='service_role';

-- Backend emission, Storage binding, cross-owner rejection and exclusive claim.
select public.create_import_upload_v2(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'synthetic.csv','text/csv',128,'Auto Detect','QA','LATAM','',
  'standard','round4-main',3
);
insert into storage.objects(id,bucket_id,name,owner,metadata) values (
  '40000000-0000-4000-8000-000000000001','excel-uploads',
  '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/synthetic.csv',
  '10000000-0000-4000-8000-000000000001','{"size":"128"}'
);
select public.finalize_import_upload_v2(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001'
);

do $$
begin
  begin
    perform public.request_import_job_cancel_v2(
      '10000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000001'
    );
    raise exception 'CROSS_OWNER_CANCEL_WAS_ALLOWED';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

create temporary table round4_claim as
select * from public.claim_import_job_v2('worker-a',120);

do $$
begin
  if (select count(*) from round4_claim)<>1 then raise exception 'FIRST_CLAIM_FAILED'; end if;
  if exists(select 1 from public.claim_import_job_v2('worker-b',120)) then raise exception 'DOUBLE_CLAIM_ALLOWED'; end if;
end;
$$;

insert into public.business_records(
  id,upload_batch_id,uploaded_by,category,row_index,raw_data,normalized_data,has_errors
) values (
  '50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001','Legacy',1,'{}','{}',false
);

select public.stage_import_job_rows_v2(
  '30000000-0000-4000-8000-000000000001','worker-a',1,
  (select lease_token from round4_claim),'sheet',
  '[{"rowKey":"sheet:0","payload":{"id":"60000000-0000-4000-8000-000000000001","sheet_name":"CSV","detected_header_row":1,"total_rows":1,"valid_rows":1,"invalid_rows":0,"detected_category":"Generic","recognized_columns":["mpn"]}}]'
);
select public.stage_import_job_rows_v2(
  '30000000-0000-4000-8000-000000000001','worker-a',1,
  (select lease_token from round4_claim),'business_record',
  '[{"rowKey":"record:1","payload":{"id":"50000000-0000-4000-8000-000000000002","upload_sheet_id":"60000000-0000-4000-8000-000000000001","category":"Generic","row_index":1,"raw_data":{"mpn":"SYNTHETIC-ONLY"},"normalized_data":{"mpn":"SYNTHETIC-ONLY"},"searchable_text":"synthetic only","has_errors":false,"errors":[]}}]'
);
select public.validate_import_job_staging_v2(
  '30000000-0000-4000-8000-000000000001','worker-a',1,
  (select lease_token from round4_claim),128,repeat('a',64)
);

select set_config('quiksol.import_fail_after_delete','30000000-0000-4000-8000-000000000001',true);
do $$
begin
  begin
    perform public.publish_import_job_v2(
      '30000000-0000-4000-8000-000000000001','worker-a',1,
      (select lease_token from round4_claim),
      '{"totalRows":1,"validRows":1,"invalidRows":0,"warningCount":0,"rowsWithWarnings":0,"technicalErrorCount":0,"suppressedErrorCount":0,"sheetCount":1,"detectedCategory":"Generic","dataQualityScore":100,"durationMs":10}'
    );
    raise exception 'FAILURE_INJECTION_DID_NOT_FIRE';
  exception when sqlstate '40001' then null;
  end;
  if not exists(select 1 from public.business_records where id='50000000-0000-4000-8000-000000000001') then
    raise exception 'OLD_DATA_WAS_NOT_ROLLED_BACK';
  end if;
  if exists(select 1 from public.business_records where id='50000000-0000-4000-8000-000000000002') then
    raise exception 'PARTIAL_NEW_DATA_SURVIVED';
  end if;
end;
$$;
select set_config('quiksol.import_fail_after_delete','',true);

select public.publish_import_job_v2(
  '30000000-0000-4000-8000-000000000001','worker-a',1,
  (select lease_token from round4_claim),
  '{"totalRows":1,"validRows":1,"invalidRows":0,"warningCount":0,"rowsWithWarnings":0,"technicalErrorCount":0,"suppressedErrorCount":0,"sheetCount":1,"detectedCategory":"Generic","dataQualityScore":100,"durationMs":10}'
);
select public.publish_import_job_v2(
  '30000000-0000-4000-8000-000000000001','worker-a',1,
  (select lease_token from round4_claim),
  '{"totalRows":1,"validRows":1,"invalidRows":0,"warningCount":0,"rowsWithWarnings":0,"technicalErrorCount":0,"suppressedErrorCount":0,"sheetCount":1,"detectedCategory":"Generic","dataQualityScore":100,"durationMs":10}'
);

do $$
begin
  if (select count(*) from public.business_records where upload_batch_id='20000000-0000-4000-8000-000000000001')<>1
     or not exists(select 1 from public.business_records where id='50000000-0000-4000-8000-000000000002') then
    raise exception 'PUBLICATION_NOT_IDEMPOTENT';
  end if;
  if not exists(select 1 from public.import_jobs where id='30000000-0000-4000-8000-000000000001' and publication_state='published' and status='completed') then
    raise exception 'PUBLICATION_STATE_INVALID';
  end if;
  begin
    perform public.request_import_job_cancel_v2(
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001'
    );
    raise exception 'LATE_CANCEL_WAS_ALLOWED';
  exception when sqlstate '55000' then null;
  end;
end;
$$;

-- Stale lease recovery fences worker A and gives worker B a larger token.
select public.create_import_upload_v2(
  '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000002','stale.csv','text/csv',64,
  'Auto Detect','QA','LATAM','','standard','round4-stale',3
);
insert into storage.objects(id,bucket_id,name,owner,metadata) values (
  '40000000-0000-4000-8000-000000000002','excel-uploads',
  '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002/stale.csv',
  '10000000-0000-4000-8000-000000000001','{"size":"64"}'
);
select public.finalize_import_upload_v2(
  '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000002'
);
create temporary table stale_claim_a as select * from public.claim_import_job_v2('stale-a',30);
select public.stage_import_job_rows_v2(
  '30000000-0000-4000-8000-000000000002','stale-a',1,
  (select lease_token from stale_claim_a),'sheet',
  '[{"rowKey":"stale-a-sheet","payload":{"id":"60000000-0000-4000-8000-000000000009","sheet_name":"STALE-A","detected_header_row":1,"total_rows":1,"valid_rows":1,"invalid_rows":0,"detected_category":"Generic","recognized_columns":["MPN"]}}]'
);
update public.import_jobs set lease_expires_at=clock_timestamp()-interval '1 second'
where id='30000000-0000-4000-8000-000000000002';
select public.recover_stale_import_jobs_v2('recovery-worker',25);
do $$
begin
  if exists(
    select 1 from public.import_job_staging_rows
    where job_id='30000000-0000-4000-8000-000000000002'
  ) then
    raise exception 'STALE_STAGING_NOT_CLEANED';
  end if;
end;
$$;
create temporary table stale_claim_b as select * from public.claim_import_job_v2('stale-b',120);

insert into public.business_records(
  id,upload_batch_id,uploaded_by,category,row_index,raw_data,normalized_data,has_errors
) values (
  '50000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001','Previously Published',1,'{}','{}',false
);

do $$
declare
  stale_error text;
begin
  if (select count(*) from stale_claim_b)<>1 then raise exception 'STALE_JOB_NOT_RECLAIMED'; end if;
  if (select generation from stale_claim_b)<>(select generation from stale_claim_a) then
    raise exception 'STALE_RECOVERY_CHANGED_LOGICAL_GENERATION';
  end if;
  if (select lease_token from stale_claim_b)<=(select lease_token from stale_claim_a) then raise exception 'FENCE_TOKEN_NOT_MONOTONIC'; end if;
  if (select lease_owner from stale_claim_b)<>'stale-b' or (select attempts from stale_claim_b)<>2 then
    raise exception 'NEW_WORKER_CLAIM_STATE_INVALID';
  end if;
  begin
    perform public.stage_import_job_rows_v2(
      '30000000-0000-4000-8000-000000000002','stale-a',1,
      (select lease_token from stale_claim_a),'sheet','[]'
    );
    raise exception 'STALE_STAGE_WAS_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics stale_error=message_text;
    if stale_error<>'IMPORT_WORKER_FENCED' then raise exception 'STALE_STAGE_WRONG_REJECTION: %',stale_error; end if;
  end;
  begin
    perform public.update_import_job_progress_v2(
      '30000000-0000-4000-8000-000000000002','stale-a',1,
      (select lease_token from stale_claim_a),'{"totalRows":1}'
    );
    raise exception 'STALE_PROGRESS_WAS_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics stale_error=message_text;
    if stale_error<>'IMPORT_WORKER_FENCED' then raise exception 'STALE_PROGRESS_WRONG_REJECTION: %',stale_error; end if;
  end;
  begin
    perform public.validate_import_job_staging_v2(
      '30000000-0000-4000-8000-000000000002','stale-a',1,
      (select lease_token from stale_claim_a),64,repeat('a',64)
    );
    raise exception 'STALE_VALIDATE_WAS_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics stale_error=message_text;
    if stale_error<>'IMPORT_WORKER_FENCED' then raise exception 'STALE_VALIDATE_WRONG_REJECTION: %',stale_error; end if;
  end;
  begin
    perform public.publish_import_job_v2(
      '30000000-0000-4000-8000-000000000002','stale-a',1,
      (select lease_token from stale_claim_a),
      '{"validRows":1,"invalidRows":0,"totalRows":1,"sheetCount":1}'
    );
    raise exception 'STALE_PUBLISH_WAS_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics stale_error=message_text;
    if stale_error<>'IMPORT_WORKER_FENCED' then raise exception 'STALE_PUBLISH_WRONG_REJECTION: %',stale_error; end if;
  end;
  begin
    perform public.fail_import_job_v2(
      '30000000-0000-4000-8000-000000000002','stale-a',1,
      (select lease_token from stale_claim_a),'STALE_WORKER_FAILURE',false
    );
    raise exception 'STALE_FAIL_WAS_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics stale_error=message_text;
    if stale_error<>'IMPORT_WORKER_FENCED' then raise exception 'STALE_FAIL_WRONG_REJECTION: %',stale_error; end if;
  end;
  update public.profiles set role='admin' where id='10000000-0000-4000-8000-000000000002';
  begin
    perform public.safe_finalize_import_job_v2(
      '10000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000002','stale worker attempted finalize'
    );
    raise exception 'STALE_SAFE_FINALIZE_WAS_ALLOWED';
  exception when sqlstate '55000' then
    get stacked diagnostics stale_error=message_text;
    if stale_error<>'IMPORT_SAFE_FINALIZE_NOT_AVAILABLE' then raise exception 'STALE_FINALIZE_WRONG_REJECTION: %',stale_error; end if;
  end;
end;
$$;

-- Invalid headers fail validation without touching previously published data.
select public.stage_import_job_rows_v2(
  '30000000-0000-4000-8000-000000000002','stale-b',1,
  (select lease_token from stale_claim_b),'sheet',
  '[{"rowKey":"sheet:0","payload":{"id":"60000000-0000-4000-8000-000000000002","sheet_name":"CSV","detected_header_row":1,"total_rows":1,"valid_rows":0,"invalid_rows":1,"detected_category":"Generic","recognized_columns":[]}}]'
);
do $$
begin
  begin
    perform public.validate_import_job_staging_v2(
      '30000000-0000-4000-8000-000000000002','stale-b',1,
      (select lease_token from stale_claim_b),64,repeat('b',64)
    );
    raise exception 'INVALID_HEADERS_WERE_ACCEPTED';
  exception when sqlstate '22023' then null;
  end;
  if not exists(select 1 from public.business_records where id='50000000-0000-4000-8000-000000000003') then
    raise exception 'INVALID_IMPORT_TOUCHED_PUBLISHED_DATA';
  end if;
end;
$$;

select public.fail_import_job_v2(
  '30000000-0000-4000-8000-000000000002','stale-b',1,
  (select lease_token from stale_claim_b),'IMPORT_HEADERS_INVALID',false
);
create temporary table retry_state as
select public.request_import_job_retry_v2(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002'
) as value;

do $$
declare current_generation bigint;
begin
  select generation into current_generation from public.import_jobs
  where id='30000000-0000-4000-8000-000000000002';
  if current_generation<>2 then raise exception 'RETRY_DID_NOT_ADVANCE_GENERATION'; end if;
  begin
    perform public.stage_import_job_rows_v2(
      '30000000-0000-4000-8000-000000000002','stale-b',1,
      (select lease_token from stale_claim_b),'sheet','[]'
    );
    raise exception 'SUPERSEDED_GENERATION_WRITE_WAS_ALLOWED';
  exception when sqlstate '55000' then null;
  end;
  begin
    perform public.request_import_job_retry_v2(
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002'
    );
    raise exception 'DUPLICATE_RETRY_WAS_ALLOWED';
  exception when sqlstate '55000' then null;
  end;
end;
$$;
select public.request_import_job_cancel_v2(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002'
);

-- A missing Storage object cannot be finalized or queued.
select public.create_import_upload_v2(
  '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000004',
  '30000000-0000-4000-8000-000000000004','missing.csv','text/csv',32,
  'Auto Detect','QA','LATAM','','standard','round4-missing',3
);
do $$
begin
  begin
    perform public.finalize_import_upload_v2(
      '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000004',
      '30000000-0000-4000-8000-000000000004'
    );
    raise exception 'MISSING_STORAGE_OBJECT_WAS_QUEUED';
  exception when sqlstate '55000' then null;
  end;
  if not exists(select 1 from public.business_records where id='50000000-0000-4000-8000-000000000002') then
    raise exception 'MISSING_STORAGE_TEST_TOUCHED_PUBLISHED_DATA';
  end if;
end;
$$;

-- Queued and processing cancellation preserve publication safety.
select public.create_import_upload_v2(
  '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000005',
  '30000000-0000-4000-8000-000000000005','queued-cancel.csv','text/csv',24,
  'Auto Detect','QA','LATAM','','standard','round4-queued-cancel',3
);
insert into storage.objects(id,bucket_id,name,owner,metadata) values (
  '40000000-0000-4000-8000-000000000005','excel-uploads',
  '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000005/queued-cancel.csv',
  '10000000-0000-4000-8000-000000000001','{"size":"24"}'
);
select public.finalize_import_upload_v2(
  '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000005',
  '30000000-0000-4000-8000-000000000005'
);
select public.request_import_job_cancel_v2(
  '10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000005'
);

select public.create_import_upload_v2(
  '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000006','processing-cancel.csv','text/csv',24,
  'Auto Detect','QA','LATAM','','standard','round4-processing-cancel',3
);
insert into storage.objects(id,bucket_id,name,owner,metadata) values (
  '40000000-0000-4000-8000-000000000006','excel-uploads',
  '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000006/processing-cancel.csv',
  '10000000-0000-4000-8000-000000000001','{"size":"24"}'
);
select public.finalize_import_upload_v2(
  '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000006'
);
create temporary table processing_cancel_claim as
select * from public.claim_import_job_v2('cancel-worker',120);
select public.request_import_job_cancel_v2(
  '10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000006'
);
select public.fail_import_job_v2(
  '30000000-0000-4000-8000-000000000006','cancel-worker',1,
  (select lease_token from processing_cancel_claim),'IMPORT_CANCELLED',false
);

do $$
begin
  if not exists(select 1 from public.import_jobs where id='30000000-0000-4000-8000-000000000005' and status='cancelled' and publication_state='cancelled') then
    raise exception 'QUEUED_CANCEL_STATE_INVALID';
  end if;
  if not exists(select 1 from public.import_jobs where id='30000000-0000-4000-8000-000000000006' and status='cancelled' and publication_state='cancelled') then
    raise exception 'PROCESSING_CANCEL_STATE_INVALID';
  end if;
end;
$$;

-- A forged privileged row inserted by the test superuser is rejected by recovery.
insert into public.upload_batches(
  id,uploaded_by,original_file_name,stored_file_path,storage_bucket,file_type,file_size,status
) values (
  '20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',
  'forged.csv','forged/path.csv','excel-uploads','text/csv',10,'queued'
);
insert into public.import_jobs(
  id,upload_batch_id,uploaded_by,status,storage_bucket,storage_path,original_file_name,size_bytes,
  replacement_scope_key,backend_issued,provenance_status
) values (
  '30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001','queued','excel-uploads','forged/path.csv','forged.csv',10,
  '20000000-0000-4000-8000-000000000003',false,'legacy'
);
select public.recover_stale_import_jobs_v2('recovery-worker',25);

do $$
begin
  if not exists(select 1 from public.import_jobs where id='30000000-0000-4000-8000-000000000003' and status='failed' and error_code='IMPORT_PROVENANCE_INVALID') then
    raise exception 'FORGED_JOB_NOT_REJECTED';
  end if;
  if coalesce((select delete_enabled from public.database_safety_state where singleton),true) then
    raise exception 'DATABASE_SAFETY_DELETE_NOT_LOCKED';
  end if;
  if not coalesce((public.database_safety_catalog_preflight_v2()->>'classified')::boolean,false) then
    raise exception 'DATABASE_SAFETY_CATALOG_REGRESSION';
  end if;
end;
$$;

select public.record_worker_runtime_heartbeat_v2('import-worker','synthetic-worker',clock_timestamp(),'{}');
do $$
begin
  if not exists(select 1 from public.worker_runtime_heartbeats where worker_name='import-worker') then
    raise exception 'RUNTIME_HEARTBEAT_NOT_RECORDED';
  end if;
end;
$$;

rollback;

select 'ROUND4_IMPORT_PIPELINE_RUNTIME_OK' as result;
