begin;

-- Ronda 4: import jobs are backend-issued capabilities. Browser sessions can
-- read their own lifecycle, but only trusted backend RPCs can create or mutate it.
alter table public.import_jobs
  add column if not exists backend_issued boolean not null default false,
  add column if not exists backend_issued_at timestamptz,
  add column if not exists provenance_status text not null default 'legacy'
    check (provenance_status in ('legacy','awaiting_upload','verified','rejected')),
  add column if not exists source text not null default 'legacy_migrated',
  add column if not exists dataset_key text not null default 'business_records',
  add column if not exists import_mode text not null default 'replace_upload'
    check (import_mode in ('replace_upload')),
  add column if not exists replacement_scope_key text,
  add column if not exists expected_size_bytes bigint,
  add column if not exists expected_sha256 text,
  add column if not exists storage_object_id uuid,
  add column if not exists storage_object_created_at timestamptz,
  add column if not exists verified_size_bytes bigint,
  add column if not exists verified_sha256 text,
  add column if not exists validated_at timestamptz,
  add column if not exists published_at timestamptz,
  add column if not exists publication_state text not null default 'pending'
    check (publication_state in ('pending','staging','validated','published','failed','cancelled')),
  add column if not exists generation bigint not null default 1 check (generation > 0),
  add column if not exists lease_token bigint not null default 0 check (lease_token >= 0),
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists error_code text;

update public.import_jobs
set replacement_scope_key = upload_batch_id::text,
    expected_size_bytes = coalesce(expected_size_bytes, size_bytes)
where replacement_scope_key is null or expected_size_bytes is null;

alter table public.import_jobs
  alter column replacement_scope_key set not null;

create unique index if not exists import_jobs_backend_upload_uidx
  on public.import_jobs(upload_batch_id)
  where backend_issued;
create index if not exists import_jobs_secure_claim_idx
  on public.import_jobs(status, provenance_status, next_retry_at, created_at)
  where backend_issued and status in ('queued','retrying');
create index if not exists import_jobs_lease_expiry_idx
  on public.import_jobs(status, lease_expires_at)
  where status = 'processing';

create table if not exists public.import_job_staging_rows (
  job_id uuid not null references public.import_jobs(id) on delete cascade,
  generation bigint not null check (generation > 0),
  lease_token bigint not null check (lease_token > 0),
  entity_kind text not null check (entity_kind in ('sheet','business_record','import_error','job_error','error_summary')),
  row_key text not null check (length(row_key) between 1 and 300),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  primary key(job_id,generation,entity_kind,row_key)
);

create index if not exists import_job_staging_rows_publish_idx
  on public.import_job_staging_rows(job_id,generation,entity_kind,row_key);

create table if not exists public.worker_runtime_heartbeats (
  worker_name text primary key,
  worker_id text not null,
  started_at timestamptz not null,
  heartbeat_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.import_job_staging_rows enable row level security;
alter table public.import_job_staging_rows force row level security;
alter table public.worker_runtime_heartbeats enable row level security;
alter table public.worker_runtime_heartbeats force row level security;

revoke all on public.import_job_staging_rows from public, anon, authenticated, service_role;
revoke all on public.worker_runtime_heartbeats from public, anon, authenticated;
grant select on public.worker_runtime_heartbeats to service_role;

-- Authenticated callers retain read policies but lose direct lifecycle and
-- ingestion writes. All mutations now pass through authenticated APIs and the
-- backend-only RPCs below.
drop policy if exists import_jobs_insert_own on public.import_jobs;
drop policy if exists import_jobs_update_owner_or_admin on public.import_jobs;
revoke insert, update, delete on public.import_jobs from authenticated;

drop policy if exists upload_batches_insert_own on public.upload_batches;
drop policy if exists upload_batches_update_admin_or_owner_processing on public.upload_batches;
revoke insert, update, delete on public.upload_batches from authenticated;

drop policy if exists business_records_insert_own on public.business_records;
revoke insert on public.business_records from authenticated;

drop policy if exists upload_sheets_insert_owner on public.upload_sheets;
revoke insert, update, delete on public.upload_sheets from authenticated;

drop policy if exists import_errors_insert_owner on public.import_errors;
revoke insert, update, delete on public.import_errors from authenticated;

drop policy if exists import_job_errors_insert_owner_or_admin on public.import_job_errors;
revoke insert, update, delete on public.import_job_errors from authenticated;

drop policy if exists import_job_error_summary_insert_owner_or_admin on public.import_job_error_summary;
revoke insert, update, delete on public.import_job_error_summary from authenticated;

create or replace function public.assert_import_service_role_v2()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'IMPORT_BACKEND_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.import_actor_can_manage_v2(input_actor_id uuid, input_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists(
    select 1
    from public.profiles profile
    where profile.id = input_actor_id
      and profile.is_active
      and (profile.id = input_owner_id or profile.role in ('admin','super_admin_dev'))
  );
$$;

create or replace function public.create_import_upload_v2(
  input_actor_id uuid,
  input_upload_id uuid,
  input_job_id uuid,
  input_original_file_name text,
  input_mime_type text,
  input_size_bytes bigint,
  input_selected_category text,
  input_department text,
  input_region text,
  input_notes text,
  input_upload_strategy text,
  input_idempotency_key text,
  input_max_attempts integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  storage_path_value text;
  existing_upload public.upload_batches;
  existing_job public.import_jobs;
begin
  perform public.assert_import_service_role_v2();
  if not exists(select 1 from public.profiles where id=input_actor_id and is_active) then
    raise exception 'IMPORT_ACTOR_NOT_ACTIVE' using errcode='42501';
  end if;
  if input_original_file_name is null
     or length(input_original_file_name) not between 1 and 260
     or input_original_file_name ~ '[\\/]'
     or lower(input_original_file_name) !~ '\.(csv|xlsx)$' then
    raise exception 'IMPORT_FILE_NAME_INVALID' using errcode='22023';
  end if;
  if input_size_bytes is null or input_size_bytes <= 0 then
    raise exception 'IMPORT_FILE_SIZE_INVALID' using errcode='22023';
  end if;
  if input_upload_strategy not in ('standard','resumable') then
    raise exception 'IMPORT_UPLOAD_STRATEGY_INVALID' using errcode='22023';
  end if;

  if input_idempotency_key is not null then
    select * into existing_upload
    from public.upload_batches
    where uploaded_by=input_actor_id and idempotency_key=input_idempotency_key and archived_at is null
    order by created_at desc limit 1;
    if found then
      select * into existing_job from public.import_jobs
      where upload_batch_id=existing_upload.id order by created_at desc limit 1;
      return jsonb_build_object(
        'duplicate',true,
        'uploadId',existing_upload.id,
        'jobId',existing_job.id,
        'status',existing_upload.status,
        'storagePath',existing_upload.stored_file_path,
        'storageBucket',existing_upload.storage_bucket
      );
    end if;
  end if;

  storage_path_value := format('%s/%s/%s', input_actor_id, input_upload_id, input_original_file_name);
  insert into public.upload_batches(
    id,uploaded_by,original_file_name,stored_file_path,storage_bucket,file_type,file_size,
    selected_category,status,total_rows,valid_rows,invalid_rows,error_count,
    upload_progress_percent,processing_progress_percent,upload_strategy,idempotency_key,notes
  ) values (
    input_upload_id,input_actor_id,input_original_file_name,storage_path_value,'excel-uploads',
    coalesce(input_mime_type,split_part(input_original_file_name,'.',2)),input_size_bytes,
    coalesce(input_selected_category,'Auto Detect'),'pending_upload',0,0,0,0,0,0,
    input_upload_strategy,input_idempotency_key,input_notes
  );

  insert into public.import_jobs(
    id,upload_batch_id,uploaded_by,status,storage_bucket,storage_path,original_file_name,
    mime_type,size_bytes,selected_category,department,region,notes,upload_strategy,max_attempts,
    backend_issued,backend_issued_at,provenance_status,source,dataset_key,import_mode,
    replacement_scope_key,expected_size_bytes,publication_state,generation,lease_token
  ) values (
    input_job_id,input_upload_id,input_actor_id,'pending_upload','excel-uploads',storage_path_value,
    input_original_file_name,input_mime_type,input_size_bytes,input_selected_category,
    input_department,input_region,input_notes,input_upload_strategy,greatest(1,least(input_max_attempts,5)),
    true,clock_timestamp(),'awaiting_upload','trusted_upload_api','business_records','replace_upload',
    input_upload_id::text,input_size_bytes,'pending',1,0
  );

  return jsonb_build_object(
    'duplicate',false,'uploadId',input_upload_id,'jobId',input_job_id,
    'status','pending_upload','storageBucket','excel-uploads','storagePath',storage_path_value
  );
end;
$$;

create or replace function public.finalize_import_upload_v2(
  input_actor_id uuid,
  input_upload_id uuid,
  input_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, storage
as $$
declare
  job public.import_jobs;
  batch public.upload_batches;
  object_row storage.objects;
  object_size bigint;
  queued_at_value timestamptz := clock_timestamp();
begin
  perform public.assert_import_service_role_v2();
  select * into job from public.import_jobs where id=input_job_id for update;
  select * into batch from public.upload_batches where id=input_upload_id for update;
  if job.id is null or batch.id is null or job.upload_batch_id<>batch.id or job.uploaded_by<>input_actor_id or batch.uploaded_by<>input_actor_id then
    raise exception 'IMPORT_PROVENANCE_INVALID' using errcode='42501';
  end if;
  if not job.backend_issued or job.storage_bucket<>'excel-uploads' or job.storage_path<>batch.stored_file_path
     or job.expected_size_bytes<>batch.file_size or job.original_file_name<>batch.original_file_name then
    raise exception 'IMPORT_PROVENANCE_INVALID' using errcode='42501';
  end if;
  if job.status in ('queued','retrying','processing','completed','completed_with_warnings') and job.provenance_status='verified' then
    return to_jsonb(job);
  end if;
  if job.status<>'pending_upload' or batch.status<>'pending_upload' then
    raise exception 'IMPORT_FINALIZE_STATE_INVALID' using errcode='55000';
  end if;
  select * into object_row from storage.objects
  where bucket_id=job.storage_bucket and name=job.storage_path
  order by created_at desc limit 1;
  if object_row.id is null then raise exception 'IMPORT_STORAGE_OBJECT_MISSING' using errcode='55000'; end if;
  if coalesce(object_row.metadata->>'size','') !~ '^[0-9]+$' then
    raise exception 'IMPORT_STORAGE_SIZE_UNVERIFIED' using errcode='55000';
  end if;
  object_size := (object_row.metadata->>'size')::bigint;
  if object_size<>job.expected_size_bytes then
    raise exception 'IMPORT_STORAGE_SIZE_MISMATCH' using errcode='55000';
  end if;

  update public.upload_batches set
    status='queued',upload_progress_percent=100,processing_progress_percent=0,
    queued_at=queued_at_value,error_message=null
  where id=batch.id;
  update public.import_jobs set
    status='queued',provenance_status='verified',storage_object_id=object_row.id,
    storage_object_created_at=object_row.created_at,progress_percent=0,error_message=null,
    error_code=null,next_retry_at=null,updated_at=queued_at_value
  where id=job.id returning * into job;
  return to_jsonb(job);
end;
$$;

create or replace function public.fail_import_upload_initialization_v2(
  input_actor_id uuid,
  input_upload_id uuid,
  input_job_id uuid,
  input_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare safe_code text := upper(coalesce(input_error_code,'IMPORT_INITIALIZATION_FAILED'));
begin
  perform public.assert_import_service_role_v2();
  if safe_code !~ '^[A-Z0-9_]{3,80}$' then safe_code:='IMPORT_INITIALIZATION_FAILED'; end if;
  update public.import_jobs set status='failed',provenance_status='rejected',publication_state='failed',
    error_code=safe_code,error_message='Import initialization failed.',finished_at=clock_timestamp(),updated_at=clock_timestamp()
  where id=input_job_id and upload_batch_id=input_upload_id and uploaded_by=input_actor_id and status='pending_upload';
  update public.upload_batches set status='failed',error_message='Import initialization failed.',completed_at=clock_timestamp()
  where id=input_upload_id and uploaded_by=input_actor_id and status='pending_upload';
  return true;
end;
$$;

create or replace function public.request_import_job_cancel_v2(input_actor_id uuid, input_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare job public.import_jobs; cancelled_at_value timestamptz:=clock_timestamp();
begin
  perform public.assert_import_service_role_v2();
  select * into job from public.import_jobs where id=input_job_id for update;
  if job.id is null then raise exception 'IMPORT_JOB_NOT_FOUND' using errcode='P0002'; end if;
  if not public.import_actor_can_manage_v2(input_actor_id,job.uploaded_by) then
    raise exception 'IMPORT_JOB_ACCESS_DENIED' using errcode='42501';
  end if;
  if job.status='processing' then
    update public.import_jobs set cancel_requested=true,updated_at=cancelled_at_value where id=job.id returning * into job;
    return jsonb_build_object('status','cancel_requested','jobId',job.id,'uploadId',job.upload_batch_id);
  end if;
  if job.status not in ('pending_upload','uploaded','queued','retrying','failed') then
    raise exception 'IMPORT_CANCEL_STATE_INVALID' using errcode='55000';
  end if;
  update public.import_jobs set status='cancelled',cancel_requested=true,publication_state='cancelled',
    error_code='IMPORT_CANCELLED',error_message='Cancelled by authorized user.',cancelled_at=cancelled_at_value,
    finished_at=cancelled_at_value,lease_token=lease_token+1,lease_owner=null,lease_expires_at=null,
    locked_at=null,locked_by=null,worker_id=null,updated_at=cancelled_at_value
  where id=job.id returning * into job;
  delete from public.import_job_staging_rows where job_id=job.id;
  update public.upload_batches set status='cancelled',error_message='Cancelled by authorized user.',
    cancelled_at=cancelled_at_value,completed_at=cancelled_at_value where id=job.upload_batch_id;
  return jsonb_build_object('status','cancelled','jobId',job.id,'uploadId',job.upload_batch_id);
end;
$$;

create or replace function public.request_import_job_retry_v2(input_actor_id uuid, input_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, storage
as $$
declare job public.import_jobs; object_row storage.objects; object_size bigint; queued_at_value timestamptz:=clock_timestamp();
begin
  perform public.assert_import_service_role_v2();
  select * into job from public.import_jobs where id=input_job_id for update;
  if job.id is null then raise exception 'IMPORT_JOB_NOT_FOUND' using errcode='P0002'; end if;
  if not public.import_actor_can_manage_v2(input_actor_id,job.uploaded_by) then
    raise exception 'IMPORT_JOB_ACCESS_DENIED' using errcode='42501';
  end if;
  if job.status not in ('failed','cancelled','retrying') then
    raise exception 'IMPORT_RETRY_STATE_INVALID' using errcode='55000';
  end if;
  select * into object_row from storage.objects where bucket_id=job.storage_bucket and name=job.storage_path order by created_at desc limit 1;
  if object_row.id is null then raise exception 'IMPORT_STORAGE_OBJECT_MISSING' using errcode='55000'; end if;
  if coalesce(object_row.metadata->>'size','') !~ '^[0-9]+$' then raise exception 'IMPORT_STORAGE_SIZE_UNVERIFIED' using errcode='55000'; end if;
  object_size:=(object_row.metadata->>'size')::bigint;
  if object_size<>coalesce(job.expected_size_bytes,job.size_bytes) then raise exception 'IMPORT_STORAGE_SIZE_MISMATCH' using errcode='55000'; end if;
  delete from public.import_job_staging_rows where job_id=job.id;
  update public.import_jobs set
    status='queued',backend_issued=true,backend_issued_at=queued_at_value,provenance_status='verified',
    source='trusted_retry_api',storage_object_id=object_row.id,storage_object_created_at=object_row.created_at,
    expected_size_bytes=object_size,generation=generation+1,lease_token=lease_token+1,
    lease_owner=null,lease_expires_at=null,locked_at=null,locked_by=null,worker_id=null,
    attempts=0,progress_percent=0,processed_rows=0,successful_rows=0,failed_rows=0,
    warning_count=0,rows_with_warnings=0,technical_error_count=0,suppressed_error_count=0,
    publication_state='pending',verified_size_bytes=null,verified_sha256=null,validated_at=null,published_at=null,
    error_code=null,error_message=null,last_error=null,next_retry_at=null,cancel_requested=false,
    started_at=null,finished_at=null,cancelled_at=null,updated_at=queued_at_value
  where id=job.id returning * into job;
  update public.upload_batches set status='queued',processed_rows=0,successful_rows=0,failed_rows=0,
    warning_count=0,rows_with_warnings=0,technical_error_count=0,suppressed_error_count=0,error_count=0,
    processing_progress_percent=0,error_message=null,queued_at=queued_at_value,processing_started_at=null,
    cancelled_at=null,worker_last_heartbeat_at=null,completed_at=null where id=job.upload_batch_id;
  return to_jsonb(job);
end;
$$;

create or replace function public.recover_stale_import_jobs_v2(input_worker_id text, input_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, storage
as $$
declare item public.import_jobs; next_status text; recovered integer:=0; rejected integer:=0; safe_limit integer:=greatest(1,least(input_limit,100));
begin
  perform public.assert_import_service_role_v2();
  if input_worker_id is null or length(input_worker_id) not between 1 and 200 then raise exception 'IMPORT_WORKER_ID_INVALID' using errcode='22023'; end if;

  for item in
    select job.* from public.import_jobs job
    left join public.upload_batches batch on batch.id=job.upload_batch_id
    left join storage.objects object_row on object_row.id=job.storage_object_id
    where job.status in ('queued','retrying') and (
      not job.backend_issued or job.provenance_status<>'verified' or batch.id is null
      or batch.uploaded_by<>job.uploaded_by or batch.stored_file_path<>job.storage_path
      or batch.storage_bucket<>job.storage_bucket or job.storage_bucket<>'excel-uploads'
      or object_row.id is null or object_row.bucket_id<>job.storage_bucket or object_row.name<>job.storage_path
    )
    order by job.created_at for update of job skip locked limit safe_limit
  loop
    update public.import_jobs set status='failed',provenance_status='rejected',publication_state='failed',
      error_code='IMPORT_PROVENANCE_INVALID',error_message='Import provenance validation failed.',
      finished_at=clock_timestamp(),lease_token=lease_token+1,updated_at=clock_timestamp()
    where id=item.id;
    update public.upload_batches set status='failed',error_message='Import provenance validation failed.',completed_at=clock_timestamp()
    where id=item.upload_batch_id and uploaded_by=item.uploaded_by;
    delete from public.import_job_staging_rows where job_id=item.id;
    rejected:=rejected+1;
  end loop;

  for item in
    select * from public.import_jobs
    where status='processing' and lease_expires_at<clock_timestamp()
    order by lease_expires_at for update skip locked limit safe_limit
  loop
    next_status:=case when item.cancel_requested then 'cancelled' when item.attempts>=item.max_attempts then 'failed' else 'retrying' end;
    update public.import_jobs set status=next_status,
      publication_state=case when next_status='cancelled' then 'cancelled' when next_status='failed' then 'failed' else 'pending' end,
      error_code=case when next_status='cancelled' then 'IMPORT_CANCELLED' when next_status='failed' then 'IMPORT_MAX_ATTEMPTS_EXCEEDED' else null end,
      error_message=case when next_status='failed' then 'Import worker lease expired after maximum attempts.' when next_status='cancelled' then 'Cancelled by authorized user.' else null end,
      last_error='Import worker lease expired.',next_retry_at=case when next_status='retrying' then clock_timestamp() else null end,
      finished_at=case when next_status in ('failed','cancelled') then clock_timestamp() else null end,
      lease_token=lease_token+1,lease_owner=null,lease_expires_at=null,locked_at=null,locked_by=null,worker_id=null,
      updated_at=clock_timestamp()
    where id=item.id;
    update public.upload_batches set status=next_status,
      error_message=case when next_status='retrying' then null when next_status='cancelled' then 'Cancelled by authorized user.' else 'Import worker lease expired after maximum attempts.' end,
      completed_at=case when next_status in ('failed','cancelled') then clock_timestamp() else null end
    where id=item.upload_batch_id;
    delete from public.import_job_staging_rows where job_id=item.id and generation=item.generation;
    recovered:=recovered+1;
  end loop;
  return jsonb_build_object('recovered',recovered,'rejected',rejected);
end;
$$;

create or replace function public.claim_import_job_v2(input_worker_id text, input_lease_seconds integer default 120)
returns setof public.import_jobs
language plpgsql
security definer
set search_path = pg_catalog, public, storage
as $$
declare candidate_id uuid; claimed public.import_jobs; lease_seconds integer:=greatest(30,least(input_lease_seconds,900));
begin
  perform public.assert_import_service_role_v2();
  perform public.recover_stale_import_jobs_v2(input_worker_id,25);
  select job.id into candidate_id from public.import_jobs job
  join public.upload_batches batch on batch.id=job.upload_batch_id
  join storage.objects object_row on object_row.id=job.storage_object_id
  where job.status in ('queued','retrying') and job.backend_issued and job.provenance_status='verified'
    and not job.cancel_requested and job.attempts<job.max_attempts and (job.next_retry_at is null or job.next_retry_at<=clock_timestamp())
    and batch.uploaded_by=job.uploaded_by and batch.stored_file_path=job.storage_path and batch.storage_bucket=job.storage_bucket
    and object_row.bucket_id=job.storage_bucket and object_row.name=job.storage_path
    and coalesce(object_row.metadata->>'size','') ~ '^[0-9]+$'
    and (object_row.metadata->>'size')::bigint=job.expected_size_bytes
  order by job.created_at for update of job skip locked limit 1;
  if candidate_id is null then return; end if;
  update public.import_jobs set status='processing',attempts=attempts+1,lease_token=lease_token+1,
    lease_owner=input_worker_id,lease_expires_at=clock_timestamp()+make_interval(secs=>lease_seconds),
    locked_at=clock_timestamp(),locked_by=input_worker_id,worker_id=input_worker_id,heartbeat_at=clock_timestamp(),
    started_at=coalesce(started_at,clock_timestamp()),error_code=null,error_message=null,publication_state='staging',updated_at=clock_timestamp()
  where id=candidate_id returning * into claimed;
  delete from public.import_job_staging_rows where job_id=claimed.id and generation=claimed.generation;
  update public.upload_batches set status='processing',processing_started_at=coalesce(processing_started_at,clock_timestamp()),
    worker_last_heartbeat_at=clock_timestamp(),error_message=null where id=claimed.upload_batch_id;
  return next claimed;
end;
$$;

create or replace function public.renew_import_job_lease_v2(
  input_job_id uuid,input_worker_id text,input_generation bigint,input_lease_token bigint,input_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare renewed public.import_jobs; lease_seconds integer:=greatest(30,least(input_lease_seconds,900));
begin
  perform public.assert_import_service_role_v2();
  update public.import_jobs set heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+make_interval(secs=>lease_seconds),
    updated_at=clock_timestamp()
  where id=input_job_id and status='processing' and generation=input_generation and lease_token=input_lease_token
    and lease_owner=input_worker_id and lease_expires_at>clock_timestamp() and not cancel_requested
  returning * into renewed;
  if renewed.id is null then
    return jsonb_build_object('renewed',false,'cancelRequested',coalesce((select cancel_requested from public.import_jobs where id=input_job_id),false));
  end if;
  update public.upload_batches set worker_last_heartbeat_at=renewed.heartbeat_at where id=renewed.upload_batch_id;
  return jsonb_build_object('renewed',true,'cancelRequested',false,'leaseExpiresAt',renewed.lease_expires_at);
end;
$$;

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
     or job.lease_owner<>input_worker_id or job.lease_expires_at<=clock_timestamp() then
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
     or job.lease_owner<>input_worker_id or job.lease_expires_at<=clock_timestamp() then
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
     or job.lease_owner<>input_worker_id or job.lease_expires_at<=clock_timestamp() then
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
     or job.lease_expires_at<=clock_timestamp() then raise exception 'IMPORT_WORKER_FENCED' using errcode='55000'; end if;
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
  if job.id is null or job.generation<>input_generation or job.lease_token<>input_lease_token or job.lease_owner<>input_worker_id then
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

create or replace function public.safe_finalize_import_job_v2(input_actor_id uuid,input_job_id uuid,input_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare job public.import_jobs; record_count integer; warning_count_value integer; final_status text; finished timestamptz:=clock_timestamp();
begin
  perform public.assert_import_service_role_v2();
  select * into job from public.import_jobs where id=input_job_id for update;
  if job.id is null then raise exception 'IMPORT_JOB_NOT_FOUND' using errcode='P0002'; end if;
  if not public.import_actor_can_manage_v2(input_actor_id,job.uploaded_by)
     or not exists(select 1 from public.profiles where id=input_actor_id and role in ('admin','super_admin_dev') and is_active) then
    raise exception 'IMPORT_JOB_ACCESS_DENIED' using errcode='42501';
  end if;
  if job.status not in ('processing','retrying','failed') or job.backend_issued then
    raise exception 'IMPORT_SAFE_FINALIZE_NOT_AVAILABLE' using errcode='55000';
  end if;
  select count(*) into record_count from public.business_records where upload_batch_id=job.upload_batch_id and archived_at is null;
  if record_count<=0 then raise exception 'IMPORT_SAFE_FINALIZE_NOT_AVAILABLE' using errcode='55000'; end if;
  select count(*) into warning_count_value from public.import_errors where upload_batch_id=job.upload_batch_id;
  final_status:=case when warning_count_value>0 then 'completed_with_warnings' else 'completed' end;
  update public.import_jobs set status=final_status,total_rows=record_count,processed_rows=record_count,successful_rows=record_count,
    failed_rows=0,warning_count=warning_count_value,progress_percent=100,error_code=null,error_message=null,last_error=null,
    publication_state='published',published_at=finished,finished_at=finished,lease_token=lease_token+1,
    lease_owner=null,lease_expires_at=null,locked_at=null,locked_by=null,worker_id=null,updated_at=finished
  where id=job.id returning * into job;
  update public.upload_batches set status=final_status,total_rows=record_count,processed_rows=record_count,
    valid_rows=record_count,successful_rows=record_count,warning_count=warning_count_value,
    processing_progress_percent=100,completed_at=finished,error_message=case when warning_count_value>0 then 'Archivo procesado con advertencias de calidad.' else null end
  where id=job.upload_batch_id;
  return to_jsonb(job)||jsonb_build_object('reason',coalesce(input_reason,'Authorized legacy safe finalize.'));
end;
$$;

create or replace function public.record_worker_runtime_heartbeat_v2(input_worker_name text,input_worker_id text,input_started_at timestamptz,input_metadata jsonb default '{}'::jsonb)
returns public.worker_runtime_heartbeats
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare heartbeat public.worker_runtime_heartbeats;
begin
  perform public.assert_import_service_role_v2();
  if input_worker_name<>'import-worker' or input_worker_id is null or length(input_worker_id) not between 1 and 200 then
    raise exception 'WORKER_HEARTBEAT_INVALID' using errcode='22023';
  end if;
  insert into public.worker_runtime_heartbeats(worker_name,worker_id,started_at,heartbeat_at,metadata,updated_at)
  values(input_worker_name,input_worker_id,input_started_at,clock_timestamp(),coalesce(input_metadata,'{}'::jsonb),clock_timestamp())
  on conflict(worker_name) do update set worker_id=excluded.worker_id,started_at=excluded.started_at,
    heartbeat_at=excluded.heartbeat_at,metadata=excluded.metadata,updated_at=excluded.updated_at
  returning * into heartbeat;
  return heartbeat;
end;
$$;

-- Retire the unfenced claim path and expose only backend-only Ronda 4 RPCs.
revoke all on function public.claim_import_job(text,interval) from public,anon,authenticated,service_role;

revoke all on function public.assert_import_service_role_v2() from public,anon,authenticated,service_role;
revoke all on function public.import_actor_can_manage_v2(uuid,uuid) from public,anon,authenticated,service_role;

revoke all on function public.create_import_upload_v2(uuid,uuid,uuid,text,text,bigint,text,text,text,text,text,text,integer) from public,anon,authenticated;
revoke all on function public.finalize_import_upload_v2(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.fail_import_upload_initialization_v2(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.request_import_job_cancel_v2(uuid,uuid) from public,anon,authenticated;
revoke all on function public.request_import_job_retry_v2(uuid,uuid) from public,anon,authenticated;
revoke all on function public.recover_stale_import_jobs_v2(text,integer) from public,anon,authenticated;
revoke all on function public.claim_import_job_v2(text,integer) from public,anon,authenticated;
revoke all on function public.renew_import_job_lease_v2(uuid,text,bigint,bigint,integer) from public,anon,authenticated;
revoke all on function public.stage_import_job_rows_v2(uuid,text,bigint,bigint,text,jsonb) from public,anon,authenticated;
revoke all on function public.update_import_job_progress_v2(uuid,text,bigint,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.validate_import_job_staging_v2(uuid,text,bigint,bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.publish_import_job_v2(uuid,text,bigint,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.fail_import_job_v2(uuid,text,bigint,bigint,text,boolean) from public,anon,authenticated;
revoke all on function public.safe_finalize_import_job_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.record_worker_runtime_heartbeat_v2(text,text,timestamptz,jsonb) from public,anon,authenticated;

grant execute on function public.create_import_upload_v2(uuid,uuid,uuid,text,text,bigint,text,text,text,text,text,text,integer) to service_role;
grant execute on function public.finalize_import_upload_v2(uuid,uuid,uuid) to service_role;
grant execute on function public.fail_import_upload_initialization_v2(uuid,uuid,uuid,text) to service_role;
grant execute on function public.request_import_job_cancel_v2(uuid,uuid) to service_role;
grant execute on function public.request_import_job_retry_v2(uuid,uuid) to service_role;
grant execute on function public.recover_stale_import_jobs_v2(text,integer) to service_role;
grant execute on function public.claim_import_job_v2(text,integer) to service_role;
grant execute on function public.renew_import_job_lease_v2(uuid,text,bigint,bigint,integer) to service_role;
grant execute on function public.stage_import_job_rows_v2(uuid,text,bigint,bigint,text,jsonb) to service_role;
grant execute on function public.update_import_job_progress_v2(uuid,text,bigint,bigint,jsonb) to service_role;
grant execute on function public.validate_import_job_staging_v2(uuid,text,bigint,bigint,bigint,text) to service_role;
grant execute on function public.publish_import_job_v2(uuid,text,bigint,bigint,jsonb) to service_role;
grant execute on function public.fail_import_job_v2(uuid,text,bigint,bigint,text,boolean) to service_role;
grant execute on function public.safe_finalize_import_job_v2(uuid,uuid,text) to service_role;
grant execute on function public.record_worker_runtime_heartbeat_v2(text,text,timestamptz,jsonb) to service_role;

-- Keep Database Safety catalog preflight complete after adding Ronda 4 tables.
create or replace function public.database_safety_table_catalog_v2()
returns table(schema_name text,table_name text,category text,planned_action text,delete_order integer,reason text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select original.schema_name,original.table_name,
    case when original.table_name in ('password_reset_codes','api_rate_limits','observability_log_outbox') then 'SYSTEM_EPHEMERAL' else original.category end,
    case when original.schema_name='public' and original.table_name in (
      'password_reset_codes','api_rate_limits','observability_log_outbox','audit_logs','security_events','system_logs','client_logs','performance_logs'
    ) then 'PRESERVE' else original.planned_action end,
    case when original.schema_name='public' and original.table_name in (
      'password_reset_codes','api_rate_limits','observability_log_outbox','audit_logs','security_events','system_logs','client_logs','performance_logs'
    ) then null else original.delete_order end,
    case
      when original.table_name='password_reset_codes' then 'Authentication recovery state is preserved.'
      when original.table_name='api_rate_limits' then 'Security rate-limit state is preserved and does not stale business backups.'
      when original.table_name='observability_log_outbox' then 'Observability delivery state is preserved.'
      when original.table_name in ('audit_logs','security_events','system_logs','client_logs','performance_logs') then 'Security and observability evidence is preserved.'
      else original.reason end
  from public.database_safety_table_catalog() original
  union all
  select 'public','import_job_staging_rows','OPERATIONAL_DATA','DELETE',5,'Transient import staging can contain business data.'
  union all
  select 'public','worker_runtime_heartbeats','SYSTEM_EPHEMERAL','PRESERVE',null,'Worker liveness contains no business payload and is preserved.';
$$;

drop trigger if exists database_safety_watermark on public.import_job_staging_rows;
create trigger database_safety_watermark
after insert or update or delete or truncate on public.import_job_staging_rows
for each statement execute function public.touch_database_safety_watermark();

commit;
