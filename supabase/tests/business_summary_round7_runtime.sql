-- Ronda 7 summary runtime contract. Synthetic disposable PostgreSQL only.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() !~ '^quiksol_privacy_round5_test_r7[a-z0-9_]*$'
     or current_setting('quiksol.allow_round7_summary_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_RONDA7_SUMMARY_TEST_DATABASE';
  end if;
end;
$$;

begin;
select set_config('request.jwt.claim.role', 'service_role', true);

-- Decimal sums and their canonical fingerprints must not depend on chunk size.
create temporary table r7_decimal_input(ordinal integer primary key, value numeric not null);
insert into r7_decimal_input
select ordinal, 0.1::numeric from generate_series(1,1000) ordinal;

do $$
declare
  chunk_size integer;
  expected numeric;
  actual numeric;
  expected_fingerprint text;
  actual_fingerprint text;
begin
  select sum(value), encode(extensions.digest(
    convert_to(jsonb_build_object('total', trim_scale(sum(value)))::text, 'UTF8'), 'sha256'
  ), 'hex') into expected, expected_fingerprint from r7_decimal_input;
  if expected <> 100::numeric then raise exception 'DECIMAL_BASELINE_MISMATCH:%', expected; end if;
  foreach chunk_size in array array[1,2,7,500,2000]
  loop
    select sum(partial) into actual
    from (
      select sum(value) partial
      from r7_decimal_input
      group by (ordinal - 1) / chunk_size
    ) chunks;
    actual_fingerprint := encode(extensions.digest(
      convert_to(jsonb_build_object('total', trim_scale(actual))::text, 'UTF8'), 'sha256'
    ), 'hex');
    if actual is distinct from expected or actual_fingerprint <> expected_fingerprint then
      raise exception 'DECIMAL_CHUNK_DEPENDENT:size=% expected=% actual=%', chunk_size, expected, actual;
    end if;
  end loop;

  truncate r7_decimal_input;
  insert into r7_decimal_input values
    (1,0.1),(2,0.2),(3,-0.03),(4,1000000000000000000.00000001),
    (5,-999999999999999999.97),(6,0),(7,0.00000001);
  select sum(value) into expected from r7_decimal_input;
  foreach chunk_size in array array[1,2,7,500,2000]
  loop
    select sum(partial) into actual from (
      select sum(value) partial from r7_decimal_input
      group by (ordinal - 1) / chunk_size
    ) chunks;
    if actual is distinct from expected then
      raise exception 'DECIMAL_SCALE_OR_SIGN_MISMATCH:size=% expected=% actual=%', chunk_size, expected, actual;
    end if;
  end loop;
end;
$$;

insert into auth.users(id,email,raw_user_meta_data)
values ('77000000-0000-4000-8000-000000000001','r7-summary@example.invalid','{}'::jsonb);
insert into public.profiles(id,full_name,email,role,is_active)
values ('77000000-0000-4000-8000-000000000001','R7 Summary Synthetic','r7-summary@example.invalid','admin',true)
on conflict (id) do update set is_active=excluded.is_active;
insert into public.upload_batches(
  id,uploaded_by,original_file_name,status,detected_category,total_rows,valid_rows
) values (
  '77000000-0000-4000-8000-000000000010',
  '77000000-0000-4000-8000-000000000001',
  'r7-summary-synthetic.xlsx','completed','pricing',1000,1000
);
insert into public.business_records(
  id,upload_batch_id,uploaded_by,row_index,raw_data,normalized_data,mpn,req_qty,created_at
)
select
  md5('r7-summary-record-' || ordinal::text)::uuid,
  '77000000-0000-4000-8000-000000000010',
  '77000000-0000-4000-8000-000000000001',
  ordinal,
  jsonb_build_object('Item','R7-DECIMAL','Required Qty',0.1),
  '{}'::jsonb,'R7-DECIMAL',0.1,
  '2026-08-25 12:00:00+00'::timestamptz - ordinal * interval '1 second'
from generate_series(1,1000) ordinal;

create temporary table r7_claim as
select * from public.claim_business_summary_rebuild_v2('r7-summary-worker',120);
do $$
begin
  if (select count(*) from r7_claim) <> 1 then raise exception 'SUMMARY_CLAIM_COUNT_INVALID'; end if;
  if (select evaluation_at is null from r7_claim) then raise exception 'SUMMARY_EVALUATION_TIME_MISSING'; end if;
end;
$$;
create temporary table r7_competing_claim as
select * from public.claim_business_summary_rebuild_v2('r7-competing-worker',120);
do $$
declare before_expiry timestamptz; after_expiry timestamptz; evaluation_time timestamptz;
begin
  if (select count(*) from r7_competing_claim) <> 0 then raise exception 'DOUBLE_SUMMARY_CLAIM'; end if;
  select lease_expires_at,evaluation_at into before_expiry,evaluation_time from r7_claim;
  select public.heartbeat_business_summary_rebuild_v2(
    upload_batch_id,'r7-summary-worker',rebuild_id,rebuild_generation,fence_token,180
  ) into after_expiry from r7_claim;
  if after_expiry <= before_expiry then raise exception 'SUMMARY_HEARTBEAT_DID_NOT_EXTEND_LEASE'; end if;
  if evaluation_time is distinct from (select rebuild_evaluation_at from public.business_upload_versions
    where upload_batch_id=(select upload_batch_id from r7_claim)) then
    raise exception 'SUMMARY_EVALUATION_TIME_CHANGED';
  end if;
end;
$$;

create temporary table r7_stage_payloads(
  chunk_sequence integer primary key,
  source_rows integer not null,
  summary_rows jsonb not null,
  cursor_created_at timestamptz not null,
  cursor_id uuid not null
);
insert into r7_stage_payloads
select
  chunk_sequence,
  count(*)::integer,
  jsonb_agg(jsonb_build_object(
    'source_ordinal', source_ordinal,
    'normalized_mpn', 'R7-DECIMAL',
    'display_mpn', 'R7-DECIMAL',
    'manufacturer_name', case when chunk_sequence=0 then 'Maker A' else 'Maker B' end,
    'manufacturer_names', jsonb_build_array(case when chunk_sequence=0 then 'Maker A' else 'Maker B' end),
    'demand_qty', 0.1,
    'source_record_count', 1,
    'warnings', case when chunk_sequence=0
      then jsonb_build_array('warning_a','manufacturer_context_mixed')
      else jsonb_build_array('warning_b','manufacturer_context_mixed') end
  ) order by source_ordinal),
  min(created_at),
  (array_agg(id order by created_at asc,id asc))[1]
from (
  select
    case when row_index <= 500 then 0 else 1 end chunk_sequence,
    (row_index - 1) % 500 source_ordinal,
    created_at,id
  from public.business_records
  where upload_batch_id='77000000-0000-4000-8000-000000000010'
) records
group by chunk_sequence;

do $$
declare
  claim r7_claim%rowtype;
  payload r7_stage_payloads%rowtype;
  response jsonb;
begin
  select * into claim from r7_claim;
  for payload in select * from r7_stage_payloads order by chunk_sequence loop
    response := public.stage_business_summary_chunk_v2(
      claim.upload_batch_id,'r7-summary-worker',claim.rebuild_id,
      claim.rebuild_generation,claim.fence_token,payload.chunk_sequence,
      payload.source_rows,payload.summary_rows,'[]'::jsonb,
      octet_length(convert_to(payload.summary_rows::text,'UTF8')),
      payload.cursor_created_at,payload.cursor_id
    );
    if not (response->>'accepted')::boolean then raise exception 'SUMMARY_STAGE_NOT_ACCEPTED'; end if;
  end loop;
end;
$$;

create temporary table r7_publish_receipt as
select
  public.publish_business_summary_rebuild_v2(
    claim.upload_batch_id,'r7-summary-worker',claim.rebuild_id,
    claim.rebuild_generation,claim.fence_token,1000,repeat('a',64)
  ) result
from r7_claim claim;

do $$
declare
  claim r7_claim%rowtype;
  first_result jsonb;
  replay_result jsonb;
  first_published_at timestamptz;
  after_published_at timestamptz;
  first_summary_hash text;
  after_summary_hash text;
  warnings text[];
begin
  select * into claim from r7_claim;
  select result into first_result from r7_publish_receipt;
  select last_published_at into first_published_at
  from public.business_upload_versions where upload_batch_id=claim.upload_batch_id;
  select encode(extensions.digest(convert_to(jsonb_agg(to_jsonb(summary) order by normalized_mpn)::text,'UTF8'),'sha256'),'hex')
  into first_summary_hash
  from public.business_mpn_summaries summary
  where upload_batch_id=claim.upload_batch_id and data_version=claim.target_data_version;

  if (select demand_qty from public.business_mpn_summaries
      where upload_batch_id=claim.upload_batch_id and normalized_mpn='R7-DECIMAL') <> 100::numeric then
    raise exception 'SUMMARY_DECIMAL_TOTAL_INVALID';
  end if;
  select summary.warnings into warnings
  from public.business_mpn_summaries summary
  where upload_batch_id=claim.upload_batch_id and normalized_mpn='R7-DECIMAL';
  if warnings is distinct from array['warning_a','warning_b','manufacturer_context_mixed'] then
    raise exception 'SUMMARY_WARNING_ORDER_INVALID:%',warnings;
  end if;

  replay_result := public.publish_business_summary_rebuild_v2(
    claim.upload_batch_id,'r7-summary-worker',claim.rebuild_id,
    claim.rebuild_generation,claim.fence_token,1000,repeat('a',64)
  );
  select last_published_at into after_published_at
  from public.business_upload_versions where upload_batch_id=claim.upload_batch_id;
  select encode(extensions.digest(convert_to(jsonb_agg(to_jsonb(summary) order by normalized_mpn)::text,'UTF8'),'sha256'),'hex')
  into after_summary_hash
  from public.business_mpn_summaries summary
  where upload_batch_id=claim.upload_batch_id and data_version=claim.target_data_version;
  if replay_result is distinct from first_result
     or after_published_at is distinct from first_published_at
     or after_summary_hash is distinct from first_summary_hash then
    raise exception 'SUMMARY_PUBLISH_REPLAY_NOT_IDEMPOTENT';
  end if;

  begin
    perform public.publish_business_summary_rebuild_v2(
      claim.upload_batch_id,'r7-summary-worker',claim.rebuild_id,
      claim.rebuild_generation,claim.fence_token,1000,repeat('b',64)
    );
    raise exception 'ALTERED_REPLAY_WAS_ACCEPTED';
  exception when sqlstate '22023' then
    if sqlerrm <> 'SUMMARY_PUBLISH_REPLAY_MISMATCH' then raise; end if;
  end;

  begin
    perform public.heartbeat_business_summary_rebuild_v2(
      claim.upload_batch_id,'r7-summary-worker',claim.rebuild_id,
      claim.rebuild_generation,claim.fence_token,120
    );
    raise exception 'STALE_HEARTBEAT_WAS_ACCEPTED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'SUMMARY_WORKER_FENCED' then raise; end if;
  end;
end;
$$;

-- A business write between the READY preflight and the data RPC is rejected
-- by the embedded post-read fence instead of being rendered as a false zero.
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','77000000-0000-4000-8000-000000000001',true);
do $$
declare
  before_state jsonb;
  after_state jsonb;
  stock_page jsonb;
  published_version bigint;
begin
  before_state := public.get_business_summary_state_v2(
    '77000000-0000-4000-8000-000000000010',null
  );
  if before_state->>'status' <> 'ready' or not (before_state->>'summaryReady')::boolean then
    raise exception 'SUMMARY_RACE_PREFLIGHT_NOT_READY:%',before_state;
  end if;
  select summary_version into published_version
  from public.business_upload_versions
  where upload_batch_id='77000000-0000-4000-8000-000000000010';
  update public.business_upload_versions
  set data_version=data_version+1,dirty=true,rebuild_status='queued'
  where upload_batch_id='77000000-0000-4000-8000-000000000010';
  stock_page := public.get_stock_needs_page_v1(
    50,0,null,null,null,null,null,null,
    '77000000-0000-4000-8000-000000000010'
  );
  after_state := public.get_business_summary_state_v2(
    '77000000-0000-4000-8000-000000000010',null
  );
  if coalesce((stock_page->>'summaryReady')::boolean,true)
     or coalesce((after_state->>'summaryReady')::boolean,true) then
    raise exception 'SUMMARY_POST_READ_RACE_FENCE_FAILED:%:%',stock_page,after_state;
  end if;
  update public.business_upload_versions
  set data_version=published_version,dirty=false,rebuild_status='ready'
  where upload_batch_id='77000000-0000-4000-8000-000000000010';
end;
$$;
select set_config('request.jwt.claim.role','service_role',true);

-- A source_record_id from another upload is rejected server-side.
insert into public.upload_batches(id,uploaded_by,original_file_name,status,detected_category)
values('77000000-0000-4000-8000-000000000020','77000000-0000-4000-8000-000000000001','r7-other.xlsx','completed','pricing');
insert into public.business_records(id,upload_batch_id,uploaded_by,row_index,raw_data,normalized_data,mpn,req_qty)
values('77000000-0000-4000-8000-000000000021','77000000-0000-4000-8000-000000000020','77000000-0000-4000-8000-000000000001',1,'{}','{}','R7-OTHER',1);
update public.business_upload_versions
set dirty=false,summary_version=data_version,opportunity_entity_version=data_version,rebuild_status='ready'
where upload_batch_id='77000000-0000-4000-8000-000000000020';

update public.business_upload_versions
set data_version=data_version+1,dirty=true
where upload_batch_id='77000000-0000-4000-8000-000000000010';
create temporary table r7_claim_second as
select * from public.claim_business_summary_rebuild_v2('r7-summary-worker-2',120);
do $$
declare
  claim r7_claim_second%rowtype;
  valid_record uuid;
begin
  select * into claim from r7_claim_second
  where upload_batch_id='77000000-0000-4000-8000-000000000010';
  if claim.upload_batch_id is null then raise exception 'SECOND_SUMMARY_CLAIM_MISSING'; end if;
  select id into valid_record from public.business_records
  where upload_batch_id=claim.upload_batch_id order by created_at desc,id desc limit 1;
  perform public.stage_business_summary_chunk_v2(
    claim.upload_batch_id,'r7-summary-worker-2',claim.rebuild_id,
    claim.rebuild_generation,claim.fence_token,0,1,
    '[{"source_ordinal":0,"normalized_mpn":"R7-VALID","display_mpn":"R7-VALID","source_record_count":1}]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'source_record_id',valid_record,'entity_kind','demand','entity_key',valid_record::text || ':demand',
      'normalized_mpn','R7-VALID','display_mpn','R7-VALID','required_qty',1
    )),1024,clock_timestamp(),valid_record
  );
  begin
    perform public.stage_business_summary_chunk_v2(
      claim.upload_batch_id,'r7-summary-worker-2',claim.rebuild_id,
      claim.rebuild_generation,claim.fence_token,1,1,
      '[{"source_ordinal":0,"normalized_mpn":"R7-OTHER","display_mpn":"R7-OTHER","source_record_count":1}]'::jsonb,
      '[{"source_record_id":"77000000-0000-4000-8000-000000000021","entity_kind":"demand","entity_key":"outside:demand","normalized_mpn":"R7-OTHER","display_mpn":"R7-OTHER","required_qty":1}]'::jsonb,
      1024,clock_timestamp(),'77000000-0000-4000-8000-000000000021'
    );
    raise exception 'OUTSIDE_UPLOAD_SOURCE_WAS_ACCEPTED';
  exception when sqlstate '22023' then
    if sqlerrm <> 'SUMMARY_ENTITY_SOURCE_OUTSIDE_UPLOAD' then raise; end if;
  end;
  begin
    perform public.stage_business_summary_chunk_v2(
      claim.upload_batch_id,'r7-summary-worker-2',claim.rebuild_id,
      claim.rebuild_generation,claim.fence_token,1,1,
      '[{"source_ordinal":0,"normalized_mpn":"R7-MISSING","display_mpn":"R7-MISSING","source_record_count":1}]'::jsonb,
      '[{"source_record_id":"77000000-0000-4000-8000-000000000099","entity_kind":"demand","entity_key":"missing:demand","normalized_mpn":"R7-MISSING","display_mpn":"R7-MISSING","required_qty":1}]'::jsonb,
      1024,clock_timestamp(),'77000000-0000-4000-8000-000000000099'
    );
    raise exception 'NONEXISTENT_SOURCE_WAS_ACCEPTED';
  exception when sqlstate '22023' then
    if sqlerrm <> 'SUMMARY_ENTITY_SOURCE_OUTSIDE_UPLOAD' then raise; end if;
  end;
  begin
    perform public.stage_business_summary_chunk_v2(
      claim.upload_batch_id,'r7-summary-worker-2',claim.rebuild_id,
      claim.rebuild_generation-1,claim.fence_token,1,1,
      '[]'::jsonb,'[]'::jsonb,0,clock_timestamp(),valid_record
    );
    raise exception 'STALE_GENERATION_STAGE_WAS_ACCEPTED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'SUMMARY_WORKER_FENCED' then raise; end if;
  end;
end;
$$;

-- Dirty during rebuild fences the old worker and preserves the published v1.
do $$
declare claim r7_claim_second%rowtype;
begin
  select * into claim from r7_claim_second
  where upload_batch_id='77000000-0000-4000-8000-000000000010';
  update public.business_upload_versions
  set data_version=data_version+1,dirty=true
  where upload_batch_id=claim.upload_batch_id;
  begin
    perform public.publish_business_summary_rebuild_v2(
      claim.upload_batch_id,'r7-summary-worker-2',claim.rebuild_id,
      claim.rebuild_generation,claim.fence_token,1000,repeat('c',64)
    );
    raise exception 'DIRTY_OLD_WORKER_PUBLISHED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'SUMMARY_WORKER_FENCED' then raise; end if;
  end;
  if not exists(select 1 from public.business_mpn_summaries
    where upload_batch_id=claim.upload_batch_id and demand_qty=100::numeric) then
    raise exception 'PREVIOUS_SUMMARY_NOT_PRESERVED';
  end if;
end;
$$;

-- A mid-publish failure rolls back the replacement and visibility pointer.
create temporary table r7_claim_failure as
select * from public.claim_business_summary_rebuild_v2('r7-summary-worker-failure',120);
do $$
declare
  claim r7_claim_failure%rowtype;
  payload r7_stage_payloads%rowtype;
  previous_version bigint;
begin
  select * into claim from r7_claim_failure
  where upload_batch_id='77000000-0000-4000-8000-000000000010';
  if claim.upload_batch_id is null then raise exception 'FAILURE_TEST_CLAIM_MISSING'; end if;
  select max(data_version) into previous_version from public.business_mpn_summaries
  where upload_batch_id=claim.upload_batch_id;
  for payload in select * from r7_stage_payloads order by chunk_sequence loop
    perform public.stage_business_summary_chunk_v2(
      claim.upload_batch_id,'r7-summary-worker-failure',claim.rebuild_id,
      claim.rebuild_generation,claim.fence_token,payload.chunk_sequence,
      payload.source_rows,payload.summary_rows,'[]'::jsonb,
      octet_length(convert_to(payload.summary_rows::text,'UTF8')),
      payload.cursor_created_at,payload.cursor_id
    );
  end loop;
  perform set_config('quiksol.summary_fail_after_replace',claim.rebuild_id::text,true);
  begin
    perform public.publish_business_summary_rebuild_v2(
      claim.upload_batch_id,'r7-summary-worker-failure',claim.rebuild_id,
      claim.rebuild_generation,claim.fence_token,1000,repeat('d',64)
    );
    raise exception 'INJECTED_PUBLISH_FAILURE_DID_NOT_FIRE';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'SUMMARY_PUBLISH_INJECTED_FAILURE' then raise; end if;
  end;
  perform set_config('quiksol.summary_fail_after_replace','',true);
  if not exists(select 1 from public.business_mpn_summaries
      where upload_batch_id=claim.upload_batch_id and data_version=previous_version and demand_qty=100::numeric)
     or exists(select 1 from public.business_mpn_summaries
      where upload_batch_id=claim.upload_batch_id and data_version=claim.target_data_version) then
    raise exception 'SUMMARY_FAILURE_ROLLBACK_DID_NOT_PRESERVE_OLD_VERSION';
  end if;
end;
$$;

-- Expired final attempt is terminalized and cannot be reclaimed forever.
update public.business_upload_versions
set rebuild_status='rebuilding',rebuild_attempts=rebuild_max_attempts,
    rebuild_locked_by='crashed-worker',
    rebuild_lease_expires_at=clock_timestamp()-interval '1 second',
    rebuild_target_version=data_version
where upload_batch_id='77000000-0000-4000-8000-000000000010';
select * from public.claim_business_summary_rebuild_v2('terminalizer',120);
do $$
begin
  if not exists(select 1 from public.business_upload_versions
    where upload_batch_id='77000000-0000-4000-8000-000000000010'
      and rebuild_status='failed'
      and last_rebuild_error_code='SUMMARY_LEASE_EXPIRED_MAX_ATTEMPTS') then
    raise exception 'MAX_ATTEMPTS_NOT_TERMINALIZED';
  end if;
end;
$$;

-- Manual retry is authorized by actor scope, resets attempts and produces a
-- new fenced generation without duplicating active claims.
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','77000000-0000-4000-8000-000000000001',true);
do $$
declare response jsonb; duplicate_response jsonb;
begin
  response := public.request_business_summary_rebuild_v2(
    '77000000-0000-4000-8000-000000000010',null
  );
  if response->>'status' <> 'queued' or (response->>'requestedCount')::integer <> 1 then
    raise exception 'SUMMARY_MANUAL_RETRY_INVALID:%',response;
  end if;
  duplicate_response := public.request_business_summary_rebuild_v2(
    '77000000-0000-4000-8000-000000000010',null
  );
  if duplicate_response->>'status' <> 'noop'
     or (duplicate_response->>'requestedCount')::integer <> 0 then
    raise exception 'SUMMARY_MANUAL_RETRY_DUPLICATED_ACTIVE_JOB:%',duplicate_response;
  end if;
end;
$$;
select set_config('request.jwt.claim.role','service_role',true);
create temporary table r7_retry_claim as
select * from public.claim_business_summary_rebuild_v2('r7-retry-worker',120);
do $$
begin
  if (select count(*) from r7_retry_claim
      where upload_batch_id='77000000-0000-4000-8000-000000000010') <> 1 then
    raise exception 'SUMMARY_RETRY_CLAIM_INVALID';
  end if;
end;
$$;

-- A terminal upload without a version row is the same fail-closed scope for
-- state v2 and all four established consumer RPCs.
select set_config('request.jwt.claim.role','service_role',true);
insert into public.clients(id,name,created_by)
values('77000000-0000-4000-8000-000000000030','R7 Missing Version Synthetic','77000000-0000-4000-8000-000000000001');
set local session_replication_role='replica';
insert into public.upload_batches(id,uploaded_by,original_file_name,status,detected_category)
values('77000000-0000-4000-8000-000000000031','77000000-0000-4000-8000-000000000001','r7-missing-version.xlsx','completed','pricing');
set local session_replication_role='origin';
insert into public.client_upload_assignments(client_id,upload_batch_id,assigned_by)
values('77000000-0000-4000-8000-000000000030','77000000-0000-4000-8000-000000000031','77000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','77000000-0000-4000-8000-000000000001',true);
do $$
declare
  state jsonb;
  opportunity_ready boolean;
  stock_page jsonb;
  sales_page jsonb;
  client_ready boolean;
begin
  state := public.get_business_summary_state_v2('77000000-0000-4000-8000-000000000031',null);
  select ready into opportunity_ready from public.get_opportunity_summary_v1();
  stock_page := public.get_stock_needs_page_v1(50,0,null,null,null,null,null,null,'77000000-0000-4000-8000-000000000031');
  sales_page := public.get_sales_opportunities_page_v1(50,0,null,null,null,null,null,null,'77000000-0000-4000-8000-000000000031',null);
  select summary_ready into client_ready
  from public.get_client_business_metrics_v1(array['77000000-0000-4000-8000-000000000030'::uuid]);
  if coalesce((state->>'summaryReady')::boolean,true)
     or (state->>'missingVersionCount')::integer <> 1
     or coalesce(opportunity_ready,true)
     or coalesce((stock_page->>'summaryReady')::boolean,true)
     or coalesce((sales_page->>'summaryReady')::boolean,true)
     or coalesce(client_ready,true) then
    raise exception 'SUMMARY_CONSUMER_UNIVERSE_MISMATCH:%:%:%:%:%',
      state,opportunity_ready,stock_page->>'summaryReady',sales_page->>'summaryReady',client_ready;
  end if;
end;
$$;
select set_config('request.jwt.claim.role','service_role',true);

-- Backend rebuild contracts are service-role-only; user state/retry contracts
-- retain their bounded authenticated grants and staging has no direct grants.
do $$
declare
  signature regprocedure;
begin
  foreach signature in array array[
    'public.claim_business_summary_rebuild_v2(text,integer)'::regprocedure,
    'public.heartbeat_business_summary_rebuild_v2(uuid,text,uuid,bigint,bigint,integer)'::regprocedure,
    'public.read_business_summary_source_chunk_v2(uuid,text,uuid,bigint,bigint,timestamptz,uuid,integer)'::regprocedure,
    'public.stage_business_summary_chunk_v2(uuid,text,uuid,bigint,bigint,integer,integer,jsonb,jsonb,bigint,timestamptz,uuid)'::regprocedure,
    'public.publish_business_summary_rebuild_v2(uuid,text,uuid,bigint,bigint,bigint,text)'::regprocedure,
    'public.fail_business_summary_rebuild_v2(uuid,text,uuid,bigint,bigint,text,boolean)'::regprocedure
  ] loop
    if has_function_privilege('public',signature,'execute')
       or has_function_privilege('anon',signature,'execute')
       or has_function_privilege('authenticated',signature,'execute')
       or not has_function_privilege('service_role',signature,'execute') then
      raise exception 'SUMMARY_BACKEND_GRANT_MATRIX_INVALID:%',signature;
    end if;
  end loop;
  if has_function_privilege('public','public.get_business_summary_state_v2(uuid,uuid)','execute')
     or has_function_privilege('anon','public.get_business_summary_state_v2(uuid,uuid)','execute')
     or not has_function_privilege('authenticated','public.get_business_summary_state_v2(uuid,uuid)','execute')
     or not has_function_privilege('service_role','public.get_business_summary_state_v2(uuid,uuid)','execute') then
    raise exception 'SUMMARY_STATE_GRANTS_INVALID';
  end if;
  if has_function_privilege('public','public.request_business_summary_rebuild_v2(uuid,uuid)','execute')
     or has_function_privilege('anon','public.request_business_summary_rebuild_v2(uuid,uuid)','execute')
     or not has_function_privilege('authenticated','public.request_business_summary_rebuild_v2(uuid,uuid)','execute')
     or has_function_privilege('service_role','public.request_business_summary_rebuild_v2(uuid,uuid)','execute') then
    raise exception 'SUMMARY_RETRY_GRANTS_INVALID';
  end if;
  if has_table_privilege('anon','public.business_summary_mpn_stage','select')
     or has_table_privilege('authenticated','public.business_summary_mpn_stage','select')
     or has_table_privilege('service_role','public.business_summary_mpn_stage','select')
     or has_table_privilege('anon','public.business_summary_entity_stage','select')
     or has_table_privilege('authenticated','public.business_summary_entity_stage','select')
     or has_table_privilege('service_role','public.business_summary_entity_stage','select') then
    raise exception 'SUMMARY_STAGING_DIRECT_GRANT_PRESENT';
  end if;
end;
$$;

select 'BUSINESS_SUMMARY_ROUND7_RUNTIME_PASS' as result;
rollback;
