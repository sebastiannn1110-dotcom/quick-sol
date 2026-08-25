-- Ronda 7 resumable single-file snapshot runtime. Synthetic PostgreSQL only.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() !~ '^quiksol_privacy_round5_test_r7[a-z0-9_]*$'
     or current_setting('quiksol.allow_round7_snapshot_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_RONDA7_SNAPSHOT_TEST_DATABASE';
  end if;
end;
$$;

begin;
select set_config('request.jwt.claim.role','service_role',true);

insert into auth.users(id,email,raw_user_meta_data)
values('78000000-0000-4000-8000-000000000001','r7-snapshot@example.invalid','{}');
insert into public.profiles(id,full_name,email,role,is_active)
values('78000000-0000-4000-8000-000000000001','R7 Snapshot Synthetic','r7-snapshot@example.invalid','admin',true)
on conflict(id) do update set role='admin',is_active=true;

insert into public.upload_batches(id,uploaded_by,original_file_name,status,detected_category,total_rows,valid_rows)
values('78000000-0000-4000-8000-000000000010','78000000-0000-4000-8000-000000000001','r7-platform.xlsx','completed','Inventory',3,3);
insert into public.business_records(id,upload_batch_id,uploaded_by,row_index,raw_data,normalized_data,mpn,on_hand)
values
 ('78000000-0000-4000-8000-000000000011','78000000-0000-4000-8000-000000000010','78000000-0000-4000-8000-000000000001',1,'{}','{}','R7-MPN-1',10),
 ('78000000-0000-4000-8000-000000000012','78000000-0000-4000-8000-000000000010','78000000-0000-4000-8000-000000000001',2,'{}','{}','R7-MPN-1',20),
 ('78000000-0000-4000-8000-000000000013','78000000-0000-4000-8000-000000000010','78000000-0000-4000-8000-000000000001',3,'{}','{}','R7-MPN-2',30);
insert into public.business_opportunity_entities(
  upload_batch_id,owner_id,data_version,source_record_id,entity_kind,entity_key,
  normalized_mpn,display_mpn,manufacturer_name,available_qty,is_live_supply,warnings
)
select
  '78000000-0000-4000-8000-000000000010','78000000-0000-4000-8000-000000000001',
  version.data_version,source.id,'stock',source.id::text || ':stock',source.mpn,source.mpn,
  'Synthetic Maker',source.on_hand,true,array['synthetic_warning']
from public.business_records source
join public.business_upload_versions version on version.upload_batch_id=source.upload_batch_id
where source.upload_batch_id='78000000-0000-4000-8000-000000000010';
update public.business_upload_versions
set dirty=false,summary_version=data_version,opportunity_entity_version=data_version,rebuild_status='ready'
where upload_batch_id='78000000-0000-4000-8000-000000000010';

create temporary table r7_locator as
select public.opportunity_finder_dataset_locator_for_actor_v2(
  '78000000-0000-4000-8000-000000000001'
) locator;
do $$
begin
  if (select locator->'datasetManifest'->>'kind' from r7_locator) <> 'opportunity-dataset-locator-v2'
     or (select locator->>'datasetVersion' from r7_locator) !~ '^[0-9a-f]{64}$'
     or (select (locator->>'uploadCount')::integer from r7_locator) <> 1 then
    raise exception 'SNAPSHOT_LOCATOR_INVALID';
  end if;
end;
$$;

insert into public.opportunity_finder_jobs(
  id,created_by,tenant_id,status,current_stage,progress_percent,comparison_mode,
  uploaded_role,opposite_dataset_role,dataset_version,dataset_scope,dataset_manifest,
  snapshot_status,pipeline_version,locked_by,lock_token,processing_fence
)
select
  '78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001',
  '78000000-0000-4000-8000-000000000001','parsing','detecting_headers',45,
  'single_file','demand','stock',locator->>'datasetVersion',locator->>'datasetScope',
  locator->'datasetManifest','pending','r7-synthetic','r7-fixture-worker',
  '78000000-0000-4000-8000-000000000199',1
from r7_locator;
insert into public.opportunity_finder_files(
  id,job_id,tenant_id,side,original_file_name,storage_bucket,storage_path,mime_type,
  size_bytes,content_sha256,validation_status,source_kind,parse_status
) values
 ('78000000-0000-4000-8000-000000000101','78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001','A','uploaded.xlsx','opportunity-finder','78000000-0000-4000-8000-000000000001/78000000-0000-4000-8000-000000000100/78000000-0000-4000-8000-000000000101.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',100,repeat('a',64),'verified','uploaded','parsed'),
 ('78000000-0000-4000-8000-000000000102','78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001','B','Base QuikSol autorizada','opportunity-finder','78000000-0000-4000-8000-000000000001/78000000-0000-4000-8000-000000000100/78000000-0000-4000-8000-000000000102.json','application/json',1,(select locator->>'datasetVersion' from r7_locator),'verified','platform_snapshot','parsed');
insert into public.opportunity_finder_rows(
  job_id,file_id,tenant_id,side,sheet_name,source_row,original_index,record_role,
  raw_mpn,display_mpn,normalized_mpn,review_key,required_qty,raw_row,
  ingestion_lock_token,ingestion_fence
) values
 ('78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000101','78000000-0000-4000-8000-000000000001','A','Sheet1',1,1,'demand','R7-MPN-1','R7-MPN-1','R7-MPN-1','r7-review-1',1,'{}','78000000-0000-4000-8000-000000000199',1),
 ('78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000101','78000000-0000-4000-8000-000000000001','A','Sheet1',2,2,'demand','R7-MPN-2','R7-MPN-2','R7-MPN-2','r7-review-2',1,'{}','78000000-0000-4000-8000-000000000199',1);
update public.opportunity_finder_jobs
set status='awaiting_roles',current_stage='finding_matches',progress_percent=55,
    locked_by=null,lock_token=null
where id='78000000-0000-4000-8000-000000000100';

create temporary table r7_snapshot_state as
select public.begin_opportunity_finder_dataset_snapshot_v2(
  '78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001',
  '78000000-0000-4000-8000-000000000110',
  (select locator->>'datasetVersion' from r7_locator),
  (select locator->>'datasetScope' from r7_locator),
  'r7-snapshot-idempotency','{"strategy":"bounded_sql_page_v2"}'
) state;

-- Partial headers and rows are hidden from authenticated actors.
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','78000000-0000-4000-8000-000000000001',true);
do $$
begin
  if (select count(*) from public.opportunity_finder_dataset_snapshots
      where job_id='78000000-0000-4000-8000-000000000100') <> 0
     or (select count(*) from public.opportunity_finder_dataset_snapshot_rows
      where job_id='78000000-0000-4000-8000-000000000100') <> 0 then
    raise exception 'PARTIAL_SNAPSHOT_VISIBLE';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role','service_role',true);

do $$
declare
  state jsonb;
  resumed jsonb;
  page jsonb;
  appended jsonb;
  duplicate jsonb;
  cursor jsonb;
  done boolean := false;
  sequence integer;
  entity_count integer;
  fingerprint text;
  iterations integer := 0;
begin
  select r7_snapshot_state.state into state from r7_snapshot_state;
  if state->>'snapshotId' <> '78000000-0000-4000-8000-000000000110'
     or (state->>'nextChunkSequence')::integer <> 0
     or (state->>'entityCount')::integer <> 0 then
    raise exception 'SNAPSHOT_BEGIN_INVALID:%',state;
  end if;
  sequence := (state->>'nextChunkSequence')::integer;
  entity_count := (state->>'entityCount')::integer;
  fingerprint := state->>'rowsFingerprint';
  cursor := state->'cursor';

  loop
    page := public.read_opportunity_finder_snapshot_chunk_v2(
      '78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001',
      '78000000-0000-4000-8000-000000000110',(state->>'generation')::bigint,
      (state->>'fenceToken')::bigint,nullif(cursor->>'candidateSourceRecordId','')::uuid,
      nullif(cursor->>'candidateEntityKind',''),1,16384
    );
    if (page->>'rowCount')::integer > 1
       or (page->>'scannedRows')::integer > 1
       or (page->>'payloadBytes')::integer > 16384 then
      raise exception 'SNAPSHOT_READ_LIMIT_BROKEN:%',page;
    end if;
    appended := public.append_opportunity_finder_dataset_snapshot_rows_v2(
      '78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001',
      '78000000-0000-4000-8000-000000000110',(state->>'generation')::bigint,
      (state->>'fenceToken')::bigint,sequence,page->'rows',
      (page->>'payloadBytes')::bigint,page->>'chunkFingerprint',page->'nextCursor'
    );
    if not (appended->>'accepted')::boolean then raise exception 'SNAPSHOT_APPEND_REJECTED'; end if;
    if iterations=0 then
      duplicate := public.append_opportunity_finder_dataset_snapshot_rows_v2(
        '78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001',
        '78000000-0000-4000-8000-000000000110',(state->>'generation')::bigint,
        (state->>'fenceToken')::bigint,sequence,page->'rows',
        (page->>'payloadBytes')::bigint,page->>'chunkFingerprint',page->'nextCursor'
      );
      if not (duplicate->>'duplicate')::boolean
         or duplicate->>'rowsFingerprint' is distinct from appended->>'rowsFingerprint' then
        raise exception 'SNAPSHOT_APPEND_REPLAY_INVALID';
      end if;
      resumed := public.begin_opportunity_finder_dataset_snapshot_v2(
        '78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001',
        '78000000-0000-4000-8000-000000000119',
        (select locator->>'datasetVersion' from r7_locator),
        (select locator->>'datasetScope' from r7_locator),
        'r7-snapshot-idempotency','{}'
      );
      if not (resumed->>'resumed')::boolean
         or resumed->>'snapshotId' <> '78000000-0000-4000-8000-000000000110'
         or resumed->'cursor' is distinct from appended->'cursor' then
        raise exception 'SNAPSHOT_RESUME_INVALID:%',resumed;
      end if;
    end if;
    sequence := (appended->>'nextChunkSequence')::integer;
    entity_count := (appended->>'entityCount')::integer;
    fingerprint := appended->>'rowsFingerprint';
    cursor := appended->'cursor';
    done := (cursor->>'done')::boolean;
    iterations := iterations + 1;
    if iterations > 10 then raise exception 'SNAPSHOT_CURSOR_DID_NOT_TERMINATE'; end if;
    exit when done;
  end loop;

  state := public.finalize_opportunity_finder_dataset_snapshot_v2(
    '78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001',
    '78000000-0000-4000-8000-000000000110',(state->>'generation')::bigint,
    (state->>'fenceToken')::bigint,entity_count,fingerprint,
    jsonb_build_object('boundedRequests',true,'chunkCount',sequence)
  );
  if state->>'status' <> 'ready' or (state->>'entityCount')::integer <> 3 then
    raise exception 'SNAPSHOT_FINALIZE_INVALID:%',state;
  end if;
  resumed := public.finalize_opportunity_finder_dataset_snapshot_v2(
    '78000000-0000-4000-8000-000000000100','78000000-0000-4000-8000-000000000001',
    '78000000-0000-4000-8000-000000000110',
    (select build_generation from public.opportunity_finder_dataset_snapshots where id='78000000-0000-4000-8000-000000000110'),
    (select build_fence_token from public.opportunity_finder_dataset_snapshots where id='78000000-0000-4000-8000-000000000110'),
    entity_count,fingerprint,'{}'
  );
  if resumed->>'status' <> 'ready' or resumed->>'snapshotId' <> state->>'snapshotId' then
    raise exception 'SNAPSHOT_FINALIZE_REPLAY_INVALID';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
begin
  if (select count(*) from public.opportunity_finder_dataset_snapshots
      where id='78000000-0000-4000-8000-000000000110') <> 1
     or (select count(*) from public.opportunity_finder_dataset_snapshot_rows
      where snapshot_id='78000000-0000-4000-8000-000000000110') <> 3 then
    raise exception 'FINAL_SNAPSHOT_NOT_VISIBLE';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role','service_role',true);

-- A changed authoritative dataset universe fences a resume explicitly and
-- cannot mix rows from two versions.
insert into public.opportunity_finder_jobs(
  id,created_by,tenant_id,status,current_stage,progress_percent,comparison_mode,
  uploaded_role,opposite_dataset_role,dataset_version,dataset_scope,dataset_manifest,
  snapshot_status,pipeline_version
)
select
  '78000000-0000-4000-8000-000000000200','78000000-0000-4000-8000-000000000001',
  '78000000-0000-4000-8000-000000000001','awaiting_roles','finding_matches',55,
  'single_file','demand','stock',locator->>'datasetVersion',locator->>'datasetScope',
  locator->'datasetManifest','pending','r7-synthetic'
from r7_locator;
insert into public.opportunity_finder_files(
  id,job_id,tenant_id,side,original_file_name,storage_bucket,storage_path,mime_type,
  size_bytes,content_sha256,validation_status,source_kind,parse_status
) values (
  '78000000-0000-4000-8000-000000000202','78000000-0000-4000-8000-000000000200',
  '78000000-0000-4000-8000-000000000001','B','Base QuikSol autorizada','opportunity-finder',
  '78000000-0000-4000-8000-000000000001/78000000-0000-4000-8000-000000000200/78000000-0000-4000-8000-000000000202.json',
  'application/json',1,(select locator->>'datasetVersion' from r7_locator),
  'verified','platform_snapshot','parsed'
);
create temporary table r7_changed_universe_snapshot as
select public.begin_opportunity_finder_dataset_snapshot_v2(
  '78000000-0000-4000-8000-000000000200','78000000-0000-4000-8000-000000000001',
  '78000000-0000-4000-8000-000000000210',
  (select locator->>'datasetVersion' from r7_locator),
  (select locator->>'datasetScope' from r7_locator),
  'r7-snapshot-version-conflict','{}'
) state;
select nextval('public.opportunity_finder_dataset_universe_seq');
do $$
declare state jsonb;
begin
  select r7_changed_universe_snapshot.state into state from r7_changed_universe_snapshot;
  begin
    perform public.read_opportunity_finder_snapshot_chunk_v2(
      '78000000-0000-4000-8000-000000000200','78000000-0000-4000-8000-000000000001',
      '78000000-0000-4000-8000-000000000210',(state->>'generation')::bigint,
      (state->>'fenceToken')::bigint,null,null,1,16384
    );
    raise exception 'SNAPSHOT_CHANGED_UNIVERSE_WAS_READ';
  exception when sqlstate '40001' then
    if sqlerrm <> 'SNAPSHOT_UNIVERSE_CHANGED' then raise; end if;
  end;
end;
$$;

-- Backend functions remain service-role-only and staging remains private.
do $$
declare signature regprocedure;
begin
  foreach signature in array array[
    'public.begin_opportunity_finder_dataset_snapshot_v2(uuid,uuid,uuid,text,text,text,jsonb)'::regprocedure,
    'public.read_opportunity_finder_snapshot_chunk_v2(uuid,uuid,uuid,bigint,bigint,uuid,text,integer,integer)'::regprocedure,
    'public.append_opportunity_finder_dataset_snapshot_rows_v2(uuid,uuid,uuid,bigint,bigint,integer,jsonb,bigint,text,jsonb)'::regprocedure,
    'public.finalize_opportunity_finder_dataset_snapshot_v2(uuid,uuid,uuid,bigint,bigint,bigint,text,jsonb)'::regprocedure
  ] loop
    if has_function_privilege('public',signature,'execute')
       or has_function_privilege('anon',signature,'execute')
       or has_function_privilege('authenticated',signature,'execute')
       or not has_function_privilege('service_role',signature,'execute') then
      raise exception 'SNAPSHOT_GRANT_MATRIX_INVALID:%',signature;
    end if;
  end loop;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
      where oid='public.business_summary_mpn_stage'::regclass)
     or not (select relrowsecurity and relforcerowsecurity from pg_class
      where oid='public.business_summary_entity_stage'::regclass) then
    raise exception 'SUMMARY_STAGE_RLS_NOT_FORCED';
  end if;
end;
$$;

select 'OPPORTUNITY_FINDER_ROUND7_SNAPSHOT_RUNTIME_PASS' as result;
rollback;
