\set ON_ERROR_STOP on

begin;

create temporary table r74_scenarios(
  scenario_name text primary key,
  p_limit integer not null,
  p_offset integer not null,
  p_q text,
  p_customer text,
  p_supplier text,
  p_manufacturer text,
  p_status text,
  p_coverage text,
  p_upload_batch_id uuid
) on commit drop;

create temporary table r74_before(
  actor_name text not null,
  scenario_name text not null,
  payload jsonb not null,
  fingerprint text not null,
  primary key(actor_name, scenario_name)
) on commit drop;
create temporary table r74_after(like r74_before including all) on commit drop;

insert into auth.users(id,email,raw_user_meta_data)
select ('d7400000-0000-4000-8000-' || lpad(actor_number::text,12,'0'))::uuid,
  format('r74-actor-%s@example.invalid',actor_number), '{}'::jsonb
from generate_series(1,20) actor_number;

update public.profiles
set role=case id
      when 'd7400000-0000-4000-8000-000000000001' then 'employee'
      when 'd7400000-0000-4000-8000-000000000002' then 'manager'
      when 'd7400000-0000-4000-8000-000000000019' then 'admin'
      when 'd7400000-0000-4000-8000-000000000020' then 'super_admin_dev'
      else 'employee' end,
    department=case when substring(id::text from 25)::bigint between 1 and 5 then 'North' else 'South' end,
    region=case when substring(id::text from 25)::bigint between 2 and 10 then 'East' else 'West' end
where id::text like 'd7400000-0000-4000-8000-%';

insert into public.upload_batches(id,uploaded_by,original_file_name,status,detected_category,created_at)
select ('d7410000-0000-4000-8000-' || lpad(owner_number::text,12,'0'))::uuid,
  ('d7400000-0000-4000-8000-' || lpad(owner_number::text,12,'0'))::uuid,
  format('r74-synthetic-%s.xlsx',owner_number),
  case when owner_number<=10 then 'completed' else 'completed_with_warnings' end,
  case when owner_number%2=0 then 'stock' else 'requirements' end,
  '2026-08-26 00:00:00+00'::timestamptz + owner_number*interval '1 minute'
from generate_series(1,20) owner_number;

update public.business_upload_versions
set summary_version=data_version, dirty=false, rebuild_status='ready'
where owner_id::text like 'd7400000-0000-4000-8000-%';

insert into public.business_mpn_summaries(
  upload_batch_id,owner_id,data_version,normalized_mpn,display_mpn,
  stock_required_qty,stock_available_qty,stock_customer_name,
  stock_supplier_name,stock_manufacturer_name,required_date,lead_time,
  source_record_count
)
select version.upload_batch_id,version.owner_id,version.data_version,
  format('MPN%s',lpad(mpn_number::text,9,'0')),
  format('MPN-%s',lpad(mpn_number::text,9,'0')),
  ((mpn_number%17)+source_slot+1)::numeric/10,
  case when (mpn_number+source_slot)%7=0 then 0::numeric
       else ((mpn_number%13)+source_slot)::numeric/10 end,
  case when (mpn_number+source_slot)%4=0 then null else format('Customer %s',mpn_number%11) end,
  case when (mpn_number+source_slot)%5=0 then null else format('Partner %s',mpn_number%9) end,
  case when (mpn_number+source_slot)%6=0 then null else format('Maker %s',mpn_number%7) end,
  case when mpn_number%8=0 then null else format('2026-09-%s',lpad((1+mpn_number%28)::text,2,'0')) end,
  case when mpn_number%10=0 then null else format('%s days',1+mpn_number%30) end,
  1
from generate_series(1,2000) mpn_number
cross join generate_series(0,5) source_slot
join public.business_upload_versions version on version.upload_batch_id=(
  'd7410000-0000-4000-8000-' ||
  lpad((1+((mpn_number*3+source_slot*7)%20))::text,12,'0')
)::uuid;

analyze public.business_mpn_summaries;
analyze public.upload_batches;
analyze public.business_upload_versions;
analyze public.profiles;

insert into r74_scenarios values
  ('first',100,0,null,null,null,null,null,null,null),
  ('middle',100,900,null,null,null,null,null,null,null),
  ('last',100,1900,null,null,null,null,null,null,null),
  ('empty_page',100,999999,null,null,null,null,null,null,null),
  ('empty_filter',100,0,'DOESNOTEXIST',null,null,null,null,null,null),
  ('mpn',100,0,'MPN000001000',null,null,null,null,null,null),
  ('customer',100,0,null,'Customer 3',null,null,null,null,null),
  ('manufacturer',100,0,null,null,null,'Maker 4',null,null,null),
  ('partner_union',100,0,null,null,'Partner 2','Partner 2',null,null,null),
  ('coverage',100,0,null,null,null,null,null,'no_stock',null),
  ('status',100,0,null,null,null,null,'completed_with_warnings',null,null),
  ('upload',100,0,null,null,null,null,null,null,'d7410000-0000-4000-8000-000000000001'),
  ('limit_one',1,0,null,null,null,null,null,null,null);

select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare actor record; scenario record; result jsonb;
begin
  for actor in select * from (values
    ('employee','d7400000-0000-4000-8000-000000000001'::uuid),
    ('manager','d7400000-0000-4000-8000-000000000002'::uuid),
    ('admin','d7400000-0000-4000-8000-000000000019'::uuid),
    ('super_admin_dev','d7400000-0000-4000-8000-000000000020'::uuid)
  ) actors(actor_name,actor_id)
  loop
    perform set_config('request.jwt.claim.sub',actor.actor_id::text,true);
    for scenario in select * from r74_scenarios order by scenario_name loop
      result:=public.get_stock_needs_page_v1(
        scenario.p_limit,scenario.p_offset,scenario.p_q,scenario.p_customer,
        scenario.p_supplier,scenario.p_manufacturer,scenario.p_status,
        scenario.p_coverage,scenario.p_upload_batch_id);
      insert into r74_before values(actor.actor_name,scenario.scenario_name,result,
        encode(extensions.digest(convert_to(result::text,'UTF8'),'sha256'),'hex'));
    end loop;
  end loop;
end;
$$;

select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
do $$
declare claim record; receipt jsonb; sequence integer; claimed integer:=0;
begin
  loop
    select * into claim from public.claim_stock_needs_snapshot_rebuild_v1('r74-runtime',120);
    exit when not found;
    claimed:=claimed+1;
    if claimed>100 then raise exception 'R74_CLAIM_LOOP'; end if;
    sequence:=claim.next_chunk_sequence;
    loop
      perform public.heartbeat_stock_needs_snapshot_rebuild_v1(
        claim.scope_id,'r74-runtime',claim.rebuild_id,claim.build_generation,claim.fence_token,120);
      receipt:=public.stage_stock_needs_snapshot_chunk_v1(
        claim.scope_id,'r74-runtime',claim.rebuild_id,claim.build_generation,
        claim.fence_token,sequence,500);
      exit when (receipt->>'done')::boolean;
      sequence:=sequence+1;
    end loop;
    perform public.publish_stock_needs_snapshot_rebuild_v1(
      claim.scope_id,'r74-runtime',claim.rebuild_id,claim.build_generation,claim.fence_token);
  end loop;
  if claimed<4 then raise exception 'R74_SCOPES_NOT_BUILT:%',claimed; end if;
end;
$$;

select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare actor record; scenario record; result jsonb;
begin
  for actor in select * from (values
    ('employee','d7400000-0000-4000-8000-000000000001'::uuid),
    ('manager','d7400000-0000-4000-8000-000000000002'::uuid),
    ('admin','d7400000-0000-4000-8000-000000000019'::uuid),
    ('super_admin_dev','d7400000-0000-4000-8000-000000000020'::uuid)
  ) actors(actor_name,actor_id)
  loop
    perform set_config('request.jwt.claim.sub',actor.actor_id::text,true);
    for scenario in select * from r74_scenarios order by scenario_name loop
      result:=public.get_stock_needs_snapshot_page_v1(
        scenario.p_limit,scenario.p_offset,scenario.p_q,scenario.p_customer,
        scenario.p_supplier,scenario.p_manufacturer,scenario.p_status,
        scenario.p_coverage,scenario.p_upload_batch_id);
      insert into r74_after values(actor.actor_name,scenario.scenario_name,result,
        encode(extensions.digest(convert_to(result::text,'UTF8'),'sha256'),'hex'));
    end loop;
  end loop;
end;
$$;

do $$
declare unexpected integer; denied boolean:=false;
begin
  select count(*) into unexpected from (
    select actor_name,scenario_name,fingerprint from r74_before
    except select actor_name,scenario_name,fingerprint from r74_after
    union all
    select actor_name,scenario_name,fingerprint from r74_after
    except select actor_name,scenario_name,fingerprint from r74_before
  ) difference;
  if unexpected<>0 then raise exception 'R74_UNEXPECTED_DIFFERENCE=%',unexpected; end if;
  if (select count(*) from r74_after)<>52 then raise exception 'R74_EXPECTED_52_SNAPSHOTS'; end if;
  if exists(
    select 1 from r74_after actual
    cross join lateral jsonb_array_elements(actual.payload->'items') item
    where jsonb_array_length(item->'sourceUploads')>5
  ) then raise exception 'R74_SOURCE_UPLOAD_LIMIT'; end if;
  if exists(
    select 1 from r74_after actual
    cross join lateral jsonb_array_elements(actual.payload->'items') item
    cross join lateral jsonb_array_elements(item->'sourceUploads') source
    join public.upload_batches upload on upload.id=(source->>'uploadBatchId')::uuid
    where actual.actor_name='employee'
      and upload.uploaded_by<>'d7400000-0000-4000-8000-000000000001'::uuid
  ) then raise exception 'R74_EMPLOYEE_CROSS_SCOPE_SOURCE'; end if;
  if exists(
    select 1 from r74_after actual
    cross join lateral jsonb_array_elements(actual.payload->'items') item
    where actual.actor_name='employee' and (
      item->>'customerName' is not null or item->>'supplierName' is not null
      or item->>'manufacturerName' is not null)
  ) then raise exception 'R74_EMPLOYEE_COMMERCIAL_LEAK'; end if;

  perform set_config('request.jwt.claim.sub','d7400000-0000-4000-8000-000000000001',true);
  begin
    perform public.get_stock_needs_snapshot_page_v1(
      100,0,null,null,null,null,null,null,'d7410000-0000-4000-8000-000000000002');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'R74_CROSS_SCOPE_UPLOAD_NOT_REJECTED'; end if;
end;
$$;

do $$
declare scope_id uuid; old_generation bigint; first_claim record; resumed record;
  receipt jsonb; repeated_receipt jsonb; stale_rejected boolean:=false;
  invalid_generation_rejected boolean:=false; duplicate_result jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select id,active_generation into scope_id,old_generation
  from public.business_stock_needs_scopes where scope_key='company';
  update public.business_stock_needs_scopes set enabled=(id=scope_id);
  update public.business_stock_needs_scopes
  set required_version=required_version+1,snapshot_status='queued',updated_at=clock_timestamp()
  where id=scope_id;
  select * into first_claim from public.claim_stock_needs_snapshot_rebuild_v1('r74-old-worker',120);
  receipt:=public.stage_stock_needs_snapshot_chunk_v1(first_claim.scope_id,'r74-old-worker',
    first_claim.rebuild_id,first_claim.build_generation,first_claim.fence_token,0,100);
  repeated_receipt:=public.stage_stock_needs_snapshot_chunk_v1(first_claim.scope_id,'r74-old-worker',
    first_claim.rebuild_id,first_claim.build_generation,first_claim.fence_token,0,100);
  if repeated_receipt is distinct from receipt then raise exception 'R74_CHUNK_APPEND_NOT_IDEMPOTENT'; end if;
  if public.heartbeat_stock_needs_snapshot_rebuild_v1(first_claim.scope_id,'r74-old-worker',
      first_claim.rebuild_id,first_claim.build_generation,first_claim.fence_token,120) is null then
    raise exception 'R74_HEARTBEAT_MISSING';
  end if;
  if (select active_generation from public.business_stock_needs_scopes where id=scope_id)<>old_generation
     or (select count(*) from public.business_stock_needs_snapshot_rows
         where data_scope_id=scope_id and generation=first_claim.build_generation)<>100
     or (public.get_stock_needs_snapshot_state_v1(null)->>'summaryReady')::boolean then
    raise exception 'R74_PARTIAL_STAGING_VISIBLE';
  end if;
  update public.business_stock_needs_scopes set build_lease_expires_at=clock_timestamp()-interval '1 second'
  where id=scope_id;
  select * into resumed from public.claim_stock_needs_snapshot_rebuild_v1('r74-new-worker',120);
  if resumed.rebuild_id is distinct from first_claim.rebuild_id
     or resumed.build_generation<>first_claim.build_generation
     or resumed.evaluation_at is distinct from first_claim.evaluation_at
     or resumed.next_chunk_sequence<>1 then raise exception 'R74_RESUME_STATE_LOST'; end if;
  begin
    perform public.stage_stock_needs_snapshot_chunk_v1(first_claim.scope_id,'r74-old-worker',
      first_claim.rebuild_id,first_claim.build_generation,first_claim.fence_token,1,100);
  exception when object_not_in_prerequisite_state then stale_rejected:=true; end;
  if not stale_rejected then raise exception 'R74_STALE_WORKER_NOT_FENCED'; end if;
  begin
    perform public.stage_stock_needs_snapshot_chunk_v1(resumed.scope_id,'r74-new-worker',
      resumed.rebuild_id,resumed.build_generation+1,resumed.fence_token,1,100);
  exception when object_not_in_prerequisite_state then invalid_generation_rejected:=true; end;
  if not invalid_generation_rejected then raise exception 'R74_INVALID_GENERATION_NOT_FENCED'; end if;
  loop
    receipt:=public.stage_stock_needs_snapshot_chunk_v1(resumed.scope_id,'r74-new-worker',
      resumed.rebuild_id,resumed.build_generation,resumed.fence_token,
      resumed.next_chunk_sequence,500);
    exit when (receipt->>'done')::boolean;
    resumed.next_chunk_sequence:=resumed.next_chunk_sequence+1;
  end loop;
  duplicate_result:=public.publish_stock_needs_snapshot_rebuild_v1(resumed.scope_id,
    'r74-new-worker',resumed.rebuild_id,resumed.build_generation,resumed.fence_token);
  if public.publish_stock_needs_snapshot_rebuild_v1(resumed.scope_id,'r74-new-worker',
    resumed.rebuild_id,resumed.build_generation,resumed.fence_token)
      is distinct from duplicate_result then raise exception 'R74_DUPLICATE_PUBLISH_CHANGED'; end if;
  if old_generation is null or old_generation=resumed.build_generation then
    raise exception 'R74_GENERATION_DID_NOT_ADVANCE';
  end if;
end;
$$;

do $$
declare company_id uuid; previous_generation bigint; previous_rows bigint;
  dirty_claim record; receipt jsonb; cleanup_result jsonb; stale_publish_rejected boolean:=false;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select id,active_generation into company_id,previous_generation
  from public.business_stock_needs_scopes where scope_key='company';
  select count(*) into previous_rows from public.business_stock_needs_snapshot_rows
  where data_scope_id=company_id and generation=previous_generation;
  update public.business_stock_needs_scopes set enabled=(id=company_id);
  update public.business_stock_needs_scopes
  set required_version=required_version+1,snapshot_status='queued',updated_at=clock_timestamp()
  where id=company_id;
  select * into dirty_claim from public.claim_stock_needs_snapshot_rebuild_v1('r74-dirty-worker',120);
  receipt:=public.stage_stock_needs_snapshot_chunk_v1(dirty_claim.scope_id,'r74-dirty-worker',
    dirty_claim.rebuild_id,dirty_claim.build_generation,dirty_claim.fence_token,0,100);
  update public.business_upload_versions set dirty=true
  where upload_batch_id='d7410000-0000-4000-8000-000000000001';
  begin
    perform public.publish_stock_needs_snapshot_rebuild_v1(dirty_claim.scope_id,'r74-dirty-worker',
      dirty_claim.rebuild_id,dirty_claim.build_generation,dirty_claim.fence_token);
  exception when object_not_in_prerequisite_state then stale_publish_rejected:=true; end;
  if not stale_publish_rejected
     or (select active_generation from public.business_stock_needs_scopes where id=company_id)<>previous_generation
     or (select count(*) from public.business_stock_needs_snapshot_rows
         where data_scope_id=company_id and generation=previous_generation)<>previous_rows then
    raise exception 'R74_DIRTY_DURING_BUILD_NOT_FENCED';
  end if;
  loop
    cleanup_result:=public.cleanup_stock_needs_snapshot_generations_v1(100);
    exit when (cleanup_result->>'done')::boolean;
  end loop;
  if exists (
       select 1 from public.business_stock_needs_snapshot_rows
       where data_scope_id=company_id and generation=dirty_claim.build_generation
     )
     or (select cardinality(retained_generations) from public.business_stock_needs_scopes
         where id=company_id)<>2
     or (select count(distinct generation) from public.business_stock_needs_snapshot_rows
         where data_scope_id=company_id)<>2 then
    raise exception 'R74_GENERATION_RETENTION_NOT_BOUNDED';
  end if;
  update public.business_upload_versions
  set dirty=false,summary_version=data_version,rebuild_status='ready'
  where upload_batch_id='d7410000-0000-4000-8000-000000000001';
end;
$$;

do $$
declare retry_scope_id uuid; first_claim record; second_claim record;
  first_failure jsonb; terminal_failure jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select id into retry_scope_id from public.business_stock_needs_scopes
  where scope_type='owner' and owner_id='d7400000-0000-4000-8000-000000000001';
  update public.business_stock_needs_scopes set enabled=(id=retry_scope_id);
  update public.business_stock_needs_scopes
  set snapshot_status='queued',build_id=null,build_locked_by=null,
      build_lease_expires_at=null,build_attempts=0,build_max_attempts=2,
      build_next_retry_at=null,updated_at=clock_timestamp()
  where id=retry_scope_id;
  select * into first_claim from public.claim_stock_needs_snapshot_rebuild_v1('r74-retry-one',120);
  first_failure:=public.fail_stock_needs_snapshot_rebuild_v1(first_claim.scope_id,'r74-retry-one',
    first_claim.rebuild_id,first_claim.build_generation,first_claim.fence_token,'TEMP FAIL!',true);
  if first_failure->>'status'<>'retrying'
     or (select build_id from public.business_stock_needs_scopes where id=retry_scope_id)
       is distinct from first_claim.rebuild_id then raise exception 'R74_RETRY_STATE_NOT_PRESERVED'; end if;
  update public.business_stock_needs_scopes set build_next_retry_at=clock_timestamp()-interval '1 second'
  where id=retry_scope_id;
  select * into second_claim from public.claim_stock_needs_snapshot_rebuild_v1('r74-retry-two',120);
  if second_claim.rebuild_id is distinct from first_claim.rebuild_id
     or second_claim.build_generation<>first_claim.build_generation
     or (select build_attempts from public.business_stock_needs_scopes where id=retry_scope_id)<>2 then
    raise exception 'R74_RETRY_DID_NOT_RESUME';
  end if;
  terminal_failure:=public.fail_stock_needs_snapshot_rebuild_v1(second_claim.scope_id,'r74-retry-two',
    second_claim.rebuild_id,second_claim.build_generation,second_claim.fence_token,'TEMP FAIL!',true);
  if terminal_failure->>'status'<>'failed'
     or (select snapshot_status from public.business_stock_needs_scopes where id=retry_scope_id)<>'failed'
     or (select build_id from public.business_stock_needs_scopes where id=retry_scope_id) is not null
     or (select last_failure_code from public.business_stock_needs_scopes where id=retry_scope_id)<>'TEMPFAIL' then
    raise exception 'R74_MAX_ATTEMPTS_NOT_TERMINAL';
  end if;
end;
$$;

do $$
begin
  if has_table_privilege('authenticated','public.business_stock_needs_scopes','select')
     or has_table_privilege('service_role','public.business_stock_needs_snapshot_rows','select')
     or has_function_privilege('anon','public.get_stock_needs_snapshot_page_v1(integer,integer,text,text,text,text,text,text,uuid)','execute')
     or not has_function_privilege('authenticated','public.get_stock_needs_snapshot_page_v1(integer,integer,text,text,text,text,text,text,uuid)','execute') then
    raise exception 'R74_ACL_BOUNDARY_FAILED';
  end if;
  if not (select (public.database_safety_catalog_preflight_v2()->>'classified')::boolean)
     or jsonb_array_length(public.database_safety_catalog_preflight_v2()->'unclassified')<>0
     or jsonb_array_length(public.database_safety_catalog_preflight_v2()->'missing')<>0 then
    raise exception 'R74_DATABASE_SAFETY_CLASSIFICATION_FAILED';
  end if;
end;
$$;

select 52 as exact_snapshots,0 as unexpected_difference,'PASS' as result;
rollback;
