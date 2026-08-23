begin;

-- Ronda 4.2: every worker-owned mutation requires a live lease. A matching
-- generation, lease token, and owner are not sufficient after expiration.
create or replace function public.stage_import_job_rows_v2(
  input_job_id uuid,input_worker_id text,input_generation bigint,input_lease_token bigint,input_entity_kind text,input_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare job public.import_jobs; item jsonb; authoritative jsonb; inserted_count integer:=0;
begin
  perform public.assert_import_service_role_v2();
  select * into job from public.import_jobs where id=input_job_id and status='processing' for update;
  if job.id is null or job.generation<>input_generation or job.lease_token<>input_lease_token
     or job.lease_owner<>input_worker_id or job.lease_expires_at is null or job.lease_expires_at<=clock_timestamp() then
    raise exception 'IMPORT_WORKER_FENCED' using errcode='55000';
  end if;
  if job.cancel_requested then raise exception 'IMPORT_CANCEL_REQUESTED' using errcode='57014'; end if;
  if input_entity_kind not in ('sheet','business_record','import_error','job_error','error_summary')
     or jsonb_typeof(input_rows)<>'array' or jsonb_array_length(input_rows)>2000 then
    raise exception 'IMPORT_STAGING_PAYLOAD_INVALID' using errcode='22023';
  end if;
  for item in select value from jsonb_array_elements(input_rows)
  loop
    if jsonb_typeof(item->'payload')<>'object' or coalesce(item->>'rowKey','')='' then
      raise exception 'IMPORT_STAGING_PAYLOAD_INVALID' using errcode='22023';
    end if;
    authoritative:=item->'payload';
    if input_entity_kind='business_record' then
      authoritative:=authoritative||jsonb_build_object('upload_batch_id',job.upload_batch_id,'uploaded_by',job.uploaded_by);
    elsif input_entity_kind='sheet' then
      authoritative:=authoritative||jsonb_build_object('upload_batch_id',job.upload_batch_id);
    elsif input_entity_kind='import_error' then
      authoritative:=authoritative||jsonb_build_object('upload_batch_id',job.upload_batch_id);
    elsif input_entity_kind in ('job_error','error_summary') then
      authoritative:=authoritative||jsonb_build_object('job_id',job.id,'upload_batch_id',job.upload_batch_id);
    end if;
    insert into public.import_job_staging_rows(job_id,generation,lease_token,entity_kind,row_key,payload)
    values(job.id,input_generation,input_lease_token,input_entity_kind,left(item->>'rowKey',300),authoritative)
    on conflict(job_id,generation,entity_kind,row_key) do update set
      lease_token=excluded.lease_token,payload=excluded.payload,created_at=clock_timestamp();
    inserted_count:=inserted_count+1;
  end loop;
  update public.import_jobs set publication_state='staging',updated_at=clock_timestamp() where id=job.id;
  return inserted_count;
end;
$$;

create or replace function public.update_import_job_progress_v2(
  input_job_id uuid,input_worker_id text,input_generation bigint,input_lease_token bigint,input_metrics jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare job public.import_jobs; progress numeric;
begin
  perform public.assert_import_service_role_v2();
  select * into job from public.import_jobs where id=input_job_id and status='processing' for update;
  if job.id is null or job.generation<>input_generation or job.lease_token<>input_lease_token
     or job.lease_owner<>input_worker_id or job.lease_expires_at is null or job.lease_expires_at<=clock_timestamp() then
    raise exception 'IMPORT_WORKER_FENCED' using errcode='55000';
  end if;
  if job.cancel_requested then raise exception 'IMPORT_CANCEL_REQUESTED' using errcode='57014'; end if;
  progress:=least(95,greatest(0,coalesce((input_metrics->>'progressPercent')::numeric,0)));
  update public.import_jobs set total_rows=coalesce((input_metrics->>'totalRows')::int,total_rows),
    processed_rows=coalesce((input_metrics->>'totalRows')::int,processed_rows),
    successful_rows=coalesce((input_metrics->>'validRows')::int,successful_rows),
    failed_rows=coalesce((input_metrics->>'invalidRows')::int,failed_rows),
    warning_count=coalesce((input_metrics->>'warningCount')::int,warning_count),
    rows_with_warnings=coalesce((input_metrics->>'rowsWithWarnings')::int,rows_with_warnings),
    technical_error_count=coalesce((input_metrics->>'technicalErrorCount')::int,technical_error_count),
    suppressed_error_count=coalesce((input_metrics->>'suppressedErrorCount')::int,suppressed_error_count),
    progress_percent=progress,updated_at=clock_timestamp() where id=job.id;
  update public.upload_batches set total_rows=coalesce((input_metrics->>'totalRows')::int,total_rows),
    processed_rows=coalesce((input_metrics->>'totalRows')::int,processed_rows),
    valid_rows=coalesce((input_metrics->>'validRows')::int,valid_rows),invalid_rows=coalesce((input_metrics->>'invalidRows')::int,invalid_rows),
    successful_rows=coalesce((input_metrics->>'validRows')::int,successful_rows),failed_rows=coalesce((input_metrics->>'invalidRows')::int,failed_rows),
    warning_count=coalesce((input_metrics->>'warningCount')::int,warning_count),rows_with_warnings=coalesce((input_metrics->>'rowsWithWarnings')::int,rows_with_warnings),
    technical_error_count=coalesce((input_metrics->>'technicalErrorCount')::int,technical_error_count),suppressed_error_count=coalesce((input_metrics->>'suppressedErrorCount')::int,suppressed_error_count),
    processing_progress_percent=progress,worker_last_heartbeat_at=clock_timestamp() where id=job.upload_batch_id;
  return true;
end;
$$;

create or replace function public.validate_import_job_staging_v2(
  input_job_id uuid,input_worker_id text,input_generation bigint,input_lease_token bigint,input_file_size bigint,input_file_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare job public.import_jobs; sheet_count integer; record_count integer; invalid_headers integer;
  object_size bigint;
begin
  perform public.assert_import_service_role_v2();
  select * into job from public.import_jobs where id=input_job_id and status='processing' for update;
  if job.id is null or job.generation<>input_generation or job.lease_token<>input_lease_token
     or job.lease_owner<>input_worker_id or job.lease_expires_at is null or job.lease_expires_at<=clock_timestamp() then
    raise exception 'IMPORT_WORKER_FENCED' using errcode='55000';
  end if;
  if job.cancel_requested then raise exception 'IMPORT_CANCEL_REQUESTED' using errcode='57014'; end if;
  if input_file_size<>job.expected_size_bytes then raise exception 'IMPORT_FILE_SIZE_MISMATCH' using errcode='55000'; end if;
  if input_file_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'IMPORT_FILE_HASH_INVALID' using errcode='22023'; end if;
  select (object_row.metadata->>'size')::bigint into object_size
  from storage.objects object_row
  where object_row.id=job.storage_object_id and object_row.bucket_id=job.storage_bucket
    and object_row.name=job.storage_path and coalesce(object_row.metadata->>'size','') ~ '^[0-9]+$';
  if object_size is null or object_size<>job.expected_size_bytes then
    raise exception 'IMPORT_STORAGE_PROVENANCE_CHANGED' using errcode='55000';
  end if;
  if job.expected_sha256 is not null and job.expected_sha256<>input_file_sha256 then
    raise exception 'IMPORT_FILE_HASH_MISMATCH' using errcode='55000';
  end if;
  select count(*) into sheet_count from public.import_job_staging_rows where job_id=job.id and generation=job.generation and entity_kind='sheet';
  select count(*) into record_count from public.import_job_staging_rows where job_id=job.id and generation=job.generation and entity_kind='business_record';
  select count(*) into invalid_headers from public.import_job_staging_rows
  where job_id=job.id and generation=job.generation and entity_kind='sheet'
    and coalesce(jsonb_array_length(payload->'recognized_columns'),0)=0;
  if sheet_count=0 then raise exception 'IMPORT_FILE_EMPTY' using errcode='22023'; end if;
  if invalid_headers>0 then raise exception 'IMPORT_HEADERS_INVALID' using errcode='22023'; end if;
  update public.import_jobs set expected_sha256=coalesce(expected_sha256,input_file_sha256),
    verified_size_bytes=input_file_size,verified_sha256=input_file_sha256,
    validated_at=clock_timestamp(),publication_state='validated',updated_at=clock_timestamp() where id=job.id;
  return jsonb_build_object('validated',true,'sheetCount',sheet_count,'recordCount',record_count);
end;
$$;

create or replace function public.publish_import_job_v2(
  input_job_id uuid,input_worker_id text,input_generation bigint,input_lease_token bigint,input_metrics jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare job public.import_jobs; staged_records_value integer; staged_sheets_value integer; valid_rows_value integer; invalid_rows_value integer;
  total_rows_value integer; warning_count_value integer; technical_count integer; suppressed_count integer; rows_with_warnings_value integer;
  final_status text; finished_at_value timestamptz:=clock_timestamp();
begin
  perform public.assert_import_service_role_v2();
  select * into job from public.import_jobs where id=input_job_id for update;
  if job.id is null then raise exception 'IMPORT_JOB_NOT_FOUND' using errcode='P0002'; end if;
  if job.publication_state='published' and job.generation=input_generation then return to_jsonb(job); end if;
  if job.generation<>input_generation then raise exception 'IMPORT_JOB_SUPERSEDED' using errcode='55000'; end if;
  if job.status<>'processing' or job.lease_token<>input_lease_token or job.lease_owner<>input_worker_id
     or job.lease_expires_at is null or job.lease_expires_at<=clock_timestamp() then raise exception 'IMPORT_WORKER_FENCED' using errcode='55000'; end if;
  if job.cancel_requested then raise exception 'IMPORT_CANCEL_REQUESTED' using errcode='57014'; end if;
  if job.publication_state<>'validated' or job.validated_at is null or job.verified_size_bytes<>job.expected_size_bytes
     or job.verified_sha256 !~ '^[0-9a-f]{64}$' or job.verified_sha256<>job.expected_sha256
     then raise exception 'IMPORT_STAGING_NOT_VALIDATED' using errcode='55000'; end if;

  staged_records_value:=(select count(*) from public.import_job_staging_rows where job_id=job.id and generation=job.generation and entity_kind='business_record');
  staged_sheets_value:=(select count(*) from public.import_job_staging_rows where job_id=job.id and generation=job.generation and entity_kind='sheet');
  valid_rows_value:=coalesce((input_metrics->>'validRows')::int,-1);
  invalid_rows_value:=coalesce((input_metrics->>'invalidRows')::int,-1);
  total_rows_value:=coalesce((input_metrics->>'totalRows')::int,-1);
  warning_count_value:=greatest(0,coalesce((input_metrics->>'warningCount')::int,0));
  technical_count:=greatest(0,coalesce((input_metrics->>'technicalErrorCount')::int,0));
  suppressed_count:=greatest(0,coalesce((input_metrics->>'suppressedErrorCount')::int,0));
  rows_with_warnings_value:=greatest(0,coalesce((input_metrics->>'rowsWithWarnings')::int,0));
  if valid_rows_value<>staged_records_value or total_rows_value<>valid_rows_value+invalid_rows_value or total_rows_value<=0
     or staged_sheets_value<>coalesce((input_metrics->>'sheetCount')::int,-1) then
    raise exception 'IMPORT_PUBLICATION_COUNTS_INVALID' using errcode='22023';
  end if;
  final_status:=case when warning_count_value>0 or technical_count>0 or suppressed_count>0 or invalid_rows_value>0
    then 'completed_with_warnings' else 'completed' end;

  delete from public.import_job_error_summary where job_id=job.id;
  delete from public.import_job_errors where job_id=job.id;
  delete from public.import_errors where upload_batch_id=job.upload_batch_id;
  delete from public.business_records where upload_batch_id=job.upload_batch_id;
  delete from public.upload_sheets where upload_batch_id=job.upload_batch_id;

  if current_setting('quiksol.import_fail_after_delete',true)=job.id::text then
    raise exception 'IMPORT_PUBLISH_INJECTED_FAILURE' using errcode='40001';
  end if;

  insert into public.upload_sheets
  select (jsonb_populate_record(null::public.upload_sheets,payload||jsonb_build_object('created_at',finished_at_value))).*
  from public.import_job_staging_rows where job_id=job.id and generation=job.generation and entity_kind='sheet' order by row_key;

  insert into public.business_records
  select (jsonb_populate_record(null::public.business_records,payload||jsonb_build_object('created_at',finished_at_value))).*
  from public.import_job_staging_rows where job_id=job.id and generation=job.generation and entity_kind='business_record' order by row_key;

  insert into public.import_errors
  select (jsonb_populate_record(null::public.import_errors,payload||jsonb_build_object('id',gen_random_uuid(),'created_at',finished_at_value))).*
  from public.import_job_staging_rows where job_id=job.id and generation=job.generation and entity_kind='import_error' order by row_key;

  insert into public.import_job_errors
  select (jsonb_populate_record(null::public.import_job_errors,payload||jsonb_build_object('id',gen_random_uuid(),'created_at',finished_at_value))).*
  from public.import_job_staging_rows where job_id=job.id and generation=job.generation and entity_kind='job_error' order by row_key;

  insert into public.import_job_error_summary
  select (jsonb_populate_record(null::public.import_job_error_summary,payload||jsonb_build_object('id',gen_random_uuid(),'created_at',finished_at_value,'updated_at',finished_at_value))).*
  from public.import_job_staging_rows where job_id=job.id and generation=job.generation and entity_kind='error_summary' order by row_key;

  update public.import_jobs set status=final_status,total_rows=total_rows_value,processed_rows=total_rows_value,
    successful_rows=valid_rows_value,failed_rows=invalid_rows_value,warning_count=warning_count_value,
    rows_with_warnings=rows_with_warnings_value,technical_error_count=technical_count,suppressed_error_count=suppressed_count,
    progress_percent=100,error_code=null,error_message=null,publication_state='published',published_at=finished_at_value,
    finished_at=finished_at_value,duration_ms=coalesce((input_metrics->>'durationMs')::bigint,duration_ms),
    lease_owner=null,lease_expires_at=null,locked_at=null,locked_by=null,worker_id=null,updated_at=finished_at_value
  where id=job.id returning * into job;
  update public.upload_batches set status=final_status,detected_category=input_metrics->>'detectedCategory',
    total_sheets=staged_sheets_value,total_rows=total_rows_value,processed_rows=total_rows_value,valid_rows=valid_rows_value,invalid_rows=invalid_rows_value,
    successful_rows=valid_rows_value,failed_rows=invalid_rows_value,error_count=warning_count_value+technical_count,
    warning_count=warning_count_value,rows_with_warnings=rows_with_warnings_value,technical_error_count=technical_count,
    suppressed_error_count=suppressed_count,data_quality_score=coalesce((input_metrics->>'dataQualityScore')::numeric,0),
    processing_progress_percent=100,completed_at=finished_at_value,error_message=case when final_status='completed_with_warnings' then 'Archivo procesado con advertencias de calidad.' else null end
  where id=job.upload_batch_id;
  delete from public.import_job_staging_rows where job_id=job.id and generation=job.generation;
  return to_jsonb(job);
end;
$$;

create or replace function public.fail_import_job_v2(
  input_job_id uuid,input_worker_id text,input_generation bigint,input_lease_token bigint,input_error_code text,input_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare job public.import_jobs; next_status text; safe_code text:=upper(coalesce(input_error_code,'IMPORT_WORKER_FAILED'));
  next_retry timestamptz; finished timestamptz:=clock_timestamp();
begin
  perform public.assert_import_service_role_v2();
  select * into job from public.import_jobs where id=input_job_id for update;
  if job.id is null or job.generation<>input_generation or job.lease_token<>input_lease_token or job.lease_owner<>input_worker_id or job.lease_expires_at is null
     or job.lease_expires_at<=clock_timestamp() then
    raise exception 'IMPORT_WORKER_FENCED' using errcode='55000';
  end if;
  if safe_code !~ '^[A-Z0-9_]{3,80}$' then safe_code:='IMPORT_WORKER_FAILED'; end if;
  if job.cancel_requested then next_status:='cancelled';
  elsif input_retryable and job.attempts<job.max_attempts then next_status:='retrying';
  else next_status:='failed'; end if;
  next_retry:=case when next_status='retrying' then finished+make_interval(secs=>least(300,60*greatest(job.attempts,1))) else null end;
  delete from public.import_job_staging_rows where job_id=job.id and generation=job.generation;
  update public.import_jobs set status=next_status,
    publication_state=case when next_status='cancelled' then 'cancelled' when next_status='failed' then 'failed' else 'pending' end,
    error_code=case when next_status='cancelled' then 'IMPORT_CANCELLED' else safe_code end,
    error_message=case when next_status='retrying' then null when next_status='cancelled' then 'Cancelled by authorized user.' else 'Import processing failed.' end,
    last_error=safe_code,next_retry_at=next_retry,finished_at=case when next_status='retrying' then null else finished end,
    cancelled_at=case when next_status='cancelled' then finished else cancelled_at end,
    duration_ms=coalesce(duration_ms,0),lease_token=lease_token+1,lease_owner=null,lease_expires_at=null,
    locked_at=null,locked_by=null,worker_id=null,updated_at=finished where id=job.id returning * into job;
  update public.upload_batches set status=next_status,
    error_message=case when next_status='retrying' then 'Processing failed and will be retried by the worker.' when next_status='cancelled' then 'Cancelled by authorized user.' else 'Import processing failed.' end,
    completed_at=case when next_status='retrying' then null else finished end where id=job.upload_batch_id;
  return to_jsonb(job);
end;
$$;

commit;
