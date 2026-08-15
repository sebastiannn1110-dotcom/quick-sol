-- Local-only executable regression checks for
-- 20260815120000_fix_virtual_snapshot_verification.sql.
-- Apply all local migrations first. Every fixture is rolled back.
begin;

do $$
declare
  actor_id uuid := 'a1000000-0000-4000-8000-000000000001';
  lock_token uuid;
  job_id uuid;
  file_a_id uuid;
  file_b_id uuid;
  counts record;
  finalized_job public.opportunity_finder_jobs%rowtype;
  commit_key text;
  rejected boolean;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    actor_id,
    'virtual-hotfix-runtime@example.invalid',
    '{"full_name":"Virtual Snapshot Hotfix","role":"admin"}'::jsonb
  );

  -- A verified physical CSV/XLSX pair, each with a physical size, remains valid.
  job_id := 'a1100000-0000-4000-8000-000000000001';
  file_a_id := 'a1200000-0000-4000-8000-000000000001';
  file_b_id := 'a1300000-0000-4000-8000-000000000001';
  lock_token := 'a1400000-0000-4000-8000-000000000001';
  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, comparison_mode, status, current_stage,
    file_a_role, file_b_role, locked_by, lock_token, processing_fence
  ) values (
    job_id, actor_id, actor_id, 'two_files', 'parsing', 'grouping_quantities',
    'demand', 'stock', 'virtual-hotfix-runtime', lock_token, 1
  );
  insert into public.opportunity_finder_files (
    id, job_id, side, original_file_name, storage_bucket, storage_path,
    mime_type, size_bytes, actual_size_bytes, content_sha256, detected_type,
    selected_role, parse_status, validation_status, source_kind
  ) values
    (
      file_a_id, job_id, 'A', 'demand.csv', 'ignored', 'ignored/demand.csv',
      'text/csv', 20, 20, repeat('a', 64), 'demand', 'demand', 'parsed',
      'verified', 'uploaded'
    ),
    (
      file_b_id, job_id, 'B', 'stock.xlsx', 'ignored', 'ignored/stock.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      30, 30, repeat('b', 64), 'stock', 'stock', 'parsed', 'verified', 'uploaded'
    );
  select * into counts
  from public.materialize_opportunity_finder_entities(
    job_id, 'virtual-hotfix-runtime', lock_token
  );
  if counts.demand_event_count <> 0
     or counts.demand_part_option_count <> 0
     or counts.supply_lot_count <> 0
     or counts.historical_signal_count <> 0 then
    raise exception 'zero-row physical materialization returned non-zero counts';
  end if;

  -- Missing actual_size_bytes remains invalid for a physical CSV.
  job_id := 'a2100000-0000-4000-8000-000000000001';
  lock_token := 'a2400000-0000-4000-8000-000000000001';
  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, comparison_mode, status, current_stage,
    file_a_role, file_b_role, locked_by, lock_token, processing_fence
  ) values (
    job_id, actor_id, actor_id, 'two_files', 'parsing', 'grouping_quantities',
    'demand', 'stock', 'virtual-hotfix-runtime', lock_token, 1
  );
  insert into public.opportunity_finder_files (
    id, job_id, side, original_file_name, storage_bucket, storage_path,
    mime_type, size_bytes, actual_size_bytes, content_sha256, detected_type,
    selected_role, parse_status, validation_status, source_kind
  ) values
    ('a2200000-0000-4000-8000-000000000001', job_id, 'A', 'missing.csv', 'ignored', 'ignored/a.csv',
     'text/csv', 20, null, repeat('c', 64), 'demand', 'demand', 'parsed', 'verified', 'uploaded'),
    ('a2300000-0000-4000-8000-000000000001', job_id, 'B', 'stock.xlsx', 'ignored', 'ignored/b.xlsx',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 30, 30,
     repeat('d', 64), 'stock', 'stock', 'parsed', 'verified', 'uploaded');
  rejected := false;
  begin
    perform * from public.materialize_opportunity_finder_entities(
      job_id, 'virtual-hotfix-runtime', lock_token
    );
  exception when check_violation then
    rejected := sqlerrm = 'opportunity_file_not_verified';
  end;
  if not rejected then raise exception 'physical CSV without actual size was accepted'; end if;

  -- Missing actual_size_bytes remains invalid for a physical XLSX.
  job_id := 'a3100000-0000-4000-8000-000000000001';
  lock_token := 'a3400000-0000-4000-8000-000000000001';
  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, comparison_mode, status, current_stage,
    file_a_role, file_b_role, locked_by, lock_token, processing_fence
  ) values (
    job_id, actor_id, actor_id, 'two_files', 'parsing', 'grouping_quantities',
    'demand', 'stock', 'virtual-hotfix-runtime', lock_token, 1
  );
  insert into public.opportunity_finder_files (
    id, job_id, side, original_file_name, storage_bucket, storage_path,
    mime_type, size_bytes, actual_size_bytes, content_sha256, detected_type,
    selected_role, parse_status, validation_status, source_kind
  ) values
    ('a3200000-0000-4000-8000-000000000001', job_id, 'A', 'demand.csv', 'ignored', 'ignored/a.csv',
     'text/csv', 20, 20, repeat('e', 64), 'demand', 'demand', 'parsed', 'verified', 'uploaded'),
    ('a3300000-0000-4000-8000-000000000001', job_id, 'B', 'missing.xlsx', 'ignored', 'ignored/b.xlsx',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 30, null,
     repeat('f', 64), 'stock', 'stock', 'parsed', 'verified', 'uploaded');
  rejected := false;
  begin
    perform * from public.materialize_opportunity_finder_entities(
      job_id, 'virtual-hotfix-runtime', lock_token
    );
  exception when check_violation then
    rejected := sqlerrm = 'opportunity_file_not_verified';
  end;
  if not rejected then raise exception 'physical XLSX without actual size was accepted'; end if;

  -- A normal uploaded JSON file is still rejected by the canonical locator trigger.
  job_id := 'a4100000-0000-4000-8000-000000000001';
  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, comparison_mode, status, current_stage
  ) values (job_id, actor_id, actor_id, 'two_files', 'uploading', 'uploading');
  rejected := false;
  begin
    insert into public.opportunity_finder_files (
      id, job_id, side, original_file_name, storage_bucket, storage_path,
      mime_type, size_bytes, actual_size_bytes, content_sha256,
      validation_status, source_kind
    ) values (
      'a4200000-0000-4000-8000-000000000001', job_id, 'A', 'payload.json',
      'ignored', 'ignored/payload.json', 'application/json', 20, 20,
      repeat('1', 64), 'verified', 'uploaded'
    );
  exception when check_violation then
    rejected := sqlerrm = 'opportunity_file_extension_invalid';
  end;
  if not rejected then raise exception 'physical JSON upload was accepted'; end if;

  -- The verified internal snapshot has no physical object size and materializes.
  job_id := 'a5100000-0000-4000-8000-000000000001';
  lock_token := 'a5400000-0000-4000-8000-000000000001';
  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, comparison_mode, status, current_stage,
    file_a_role, file_b_role, uploaded_role, opposite_dataset_role,
    locked_by, lock_token, processing_fence
  ) values (
    job_id, actor_id, actor_id, 'single_file', 'parsing', 'grouping_quantities',
    'demand', 'stock', 'demand', 'stock', 'virtual-hotfix-runtime', lock_token, 1
  );
  insert into public.opportunity_finder_files (
    id, job_id, side, original_file_name, storage_bucket, storage_path,
    mime_type, size_bytes, actual_size_bytes, content_sha256, detected_type,
    selected_role, parse_status, validation_status, source_kind
  ) values
    ('a5200000-0000-4000-8000-000000000001', job_id, 'A', 'demand.xlsx', 'ignored', 'ignored/a.xlsx',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 30, 30,
     repeat('2', 64), 'demand', 'demand', 'parsed', 'verified', 'uploaded'),
    ('a5300000-0000-4000-8000-000000000001', job_id, 'B', 'Base QuikSol autorizada', 'ignored', 'ignored/snapshot.json',
     'application/json', 1, null, repeat('3', 64), 'stock', 'stock', 'parsed',
     'verified', 'platform_snapshot');
  select * into counts
  from public.materialize_opportunity_finder_entities(
    job_id, 'virtual-hotfix-runtime', lock_token
  );
  if counts.demand_event_count <> 0
     or counts.demand_part_option_count <> 0
     or counts.supply_lot_count <> 0
     or counts.historical_signal_count <> 0 then
    raise exception 'zero-candidate virtual materialization returned non-zero counts';
  end if;
  update public.opportunity_finder_jobs
  set status = 'matching', current_stage = 'finding_matches', progress_percent = 78
  where id = job_id;
  commit_key := 'opportunity-output-v4:' || job_id::text || ':' || lock_token::text;
  perform public.begin_opportunity_finder_output(
    job_id, 'virtual-hotfix-runtime', lock_token, 1, commit_key
  );
  select committed.* into finalized_job
  from public.commit_staged_opportunity_finder_output(
    job_id,
    'virtual-hotfix-runtime',
    lock_token,
    1,
    commit_key,
    jsonb_build_object(
      'results', 0,
      'possible_matches', 0,
      'rejected_rows', 0,
      'allocations', 0,
      'commercials', 0,
      'financials', 0
    ),
    jsonb_build_object(
      'analyzedMpns', 0,
      'exactMatches', 0,
      'rejectedRows', 0,
      'missingMpnRows', 0,
      'invalidQuantityRows', 0
    ),
    0,
    0,
    0
  ) committed;
  if finalized_job.status <> 'completed'
     or finalized_job.current_stage <> 'completed'
     or finalized_job.progress_percent <> 100
     or finalized_job.result_count <> 0 then
    raise exception 'zero-match single-file job did not finish successfully';
  end if;

  -- An unverified virtual snapshot remains invalid.
  job_id := 'a6100000-0000-4000-8000-000000000001';
  lock_token := 'a6400000-0000-4000-8000-000000000001';
  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, comparison_mode, status, current_stage,
    file_a_role, file_b_role, locked_by, lock_token, processing_fence
  ) values (
    job_id, actor_id, actor_id, 'single_file', 'parsing', 'grouping_quantities',
    'demand', 'stock', 'virtual-hotfix-runtime', lock_token, 1
  );
  insert into public.opportunity_finder_files (
    id, job_id, side, original_file_name, storage_bucket, storage_path,
    mime_type, size_bytes, actual_size_bytes, content_sha256, detected_type,
    selected_role, parse_status, validation_status, source_kind
  ) values
    ('a6200000-0000-4000-8000-000000000001', job_id, 'A', 'demand.csv', 'ignored', 'ignored/a.csv',
     'text/csv', 20, 20, repeat('4', 64), 'demand', 'demand', 'parsed', 'verified', 'uploaded'),
    ('a6300000-0000-4000-8000-000000000001', job_id, 'B', 'Base QuikSol autorizada', 'ignored', 'ignored/snapshot.json',
     'application/json', 1, null, repeat('5', 64), 'stock', 'stock', 'parsed',
     'pending', 'platform_snapshot');
  rejected := false;
  begin
    perform * from public.materialize_opportunity_finder_entities(
      job_id, 'virtual-hotfix-runtime', lock_token
    );
  exception when check_violation then
    rejected := sqlerrm = 'opportunity_file_not_verified';
  end;
  if not rejected then raise exception 'unverified virtual snapshot was accepted'; end if;

  -- An internal snapshot with an invalid type is rejected even though its path
  -- is canonicalized. This is defense in depth beyond the upload trigger.
  job_id := 'a7100000-0000-4000-8000-000000000001';
  lock_token := 'a7400000-0000-4000-8000-000000000001';
  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, comparison_mode, status, current_stage,
    file_a_role, file_b_role, locked_by, lock_token, processing_fence
  ) values (
    job_id, actor_id, actor_id, 'single_file', 'parsing', 'grouping_quantities',
    'demand', 'stock', 'virtual-hotfix-runtime', lock_token, 1
  );
  insert into public.opportunity_finder_files (
    id, job_id, side, original_file_name, storage_bucket, storage_path,
    mime_type, size_bytes, actual_size_bytes, content_sha256, detected_type,
    selected_role, parse_status, validation_status, source_kind
  ) values
    ('a7200000-0000-4000-8000-000000000001', job_id, 'A', 'demand.csv', 'ignored', 'ignored/a.csv',
     'text/csv', 20, 20, repeat('6', 64), 'demand', 'demand', 'parsed', 'verified', 'uploaded'),
    ('a7300000-0000-4000-8000-000000000001', job_id, 'B', 'Base QuikSol autorizada', 'ignored', 'ignored/snapshot.json',
     'text/plain', 1, null, repeat('7', 64), 'stock', 'stock', 'parsed',
     'verified', 'platform_snapshot');
  rejected := false;
  begin
    perform * from public.materialize_opportunity_finder_entities(
      job_id, 'virtual-hotfix-runtime', lock_token
    );
  exception when check_violation then
    rejected := sqlerrm = 'opportunity_file_not_verified';
  end;
  if not rejected then raise exception 'virtual snapshot with invalid type was accepted'; end if;

  -- Simulate a corrupted legacy locator by temporarily bypassing only the
  -- canonicalization trigger; materialization must still reject it.
  alter table public.opportunity_finder_files
    disable trigger opportunity_finder_files_canonical_storage;
  update public.opportunity_finder_files
  set storage_path = 'invalid/platform-snapshot.json'
  where id = 'a7300000-0000-4000-8000-000000000001';
  alter table public.opportunity_finder_files
    enable trigger opportunity_finder_files_canonical_storage;
  update public.opportunity_finder_files
  set mime_type = 'application/json'
  where id = 'a7300000-0000-4000-8000-000000000001';
  rejected := false;
  begin
    perform * from public.materialize_opportunity_finder_entities(
      job_id, 'virtual-hotfix-runtime', lock_token
    );
  exception when check_violation then
    rejected := sqlerrm = 'opportunity_file_not_verified';
  end;
  if not rejected then raise exception 'virtual snapshot with invalid locator was accepted'; end if;
end
$$;

-- Idempotency regression: failed/cancelled/expired jobs do not block a fresh
-- snapshot; active and successful unexpired jobs retain reuse semantics.
create function pg_temp.create_hotfix_single_job(
  input_job_id uuid,
  input_actor_id uuid,
  input_status text,
  input_key text,
  input_expires_at timestamptz,
  include_virtual_file boolean
)
returns void
language plpgsql
as $$
begin
  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, comparison_mode, status, current_stage,
    uploaded_role, opposite_dataset_role, dataset_version, dataset_scope,
    dataset_manifest, snapshot_status, idempotency_key, expires_at, created_at
  ) values (
    input_job_id, input_actor_id, input_actor_id, 'single_file', input_status,
    case
      when input_status in ('completed', 'completed_with_warnings', 'failed', 'cancelled') then 'completed'
      when input_status in ('parsing', 'matching') then 'finding_matches'
      else 'confirming_roles'
    end,
    'demand', 'stock', repeat('8', 64), 'own', '[]'::jsonb,
    case when input_status = 'awaiting_roles' then 'pending' else 'ready' end,
    input_key, input_expires_at, clock_timestamp()
  );
  if include_virtual_file then
    insert into public.opportunity_finder_files (
      id, job_id, side, original_file_name, storage_bucket, storage_path,
      mime_type, size_bytes, actual_size_bytes, content_sha256, detected_type,
      selected_role, parse_status, validation_status, source_kind
    ) values (
      gen_random_uuid(), input_job_id, 'B', 'Base QuikSol autorizada',
      'ignored', 'ignored/snapshot.json', 'application/json', 1, null,
      repeat('8', 64), 'stock', 'stock', 'profiled', 'verified', 'platform_snapshot'
    );
  end if;
end
$$;

do $$
declare
  actor_id uuid := 'b1000000-0000-4000-8000-000000000001';
  prior_id uuid;
  current_id uuid;
  persisted record;
  identity_key text;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    actor_id,
    'idempotency-hotfix-runtime@example.invalid',
    '{"full_name":"Idempotency Hotfix","role":"admin"}'::jsonb
  );
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- failed -> do not reuse; preserve the failed row and its key.
  identity_key := 'opportunity-finder:v4:' || repeat('a', 64);
  prior_id := 'b1100000-0000-4000-8000-000000000001';
  current_id := 'b1200000-0000-4000-8000-000000000001';
  perform pg_temp.create_hotfix_single_job(prior_id, actor_id, 'failed', identity_key, now() + interval '1 day', false);
  perform pg_temp.create_hotfix_single_job(current_id, actor_id, 'awaiting_roles', null, now() + interval '1 day', true);
  select * into persisted from public.persist_opportunity_finder_dataset_snapshot(
    current_id, actor_id, gen_random_uuid(), repeat('8', 64), 'own', '[]'::jsonb,
    '[]'::jsonb, identity_key, '{}'::jsonb
  );
  if persisted.reused or persisted.committed_job_id <> current_id then
    raise exception 'failed job was reused';
  end if;
  if not exists (
    select 1 from public.opportunity_finder_jobs
    where id = prior_id and status = 'failed' and idempotency_key = identity_key
  ) then raise exception 'failed job history was mutated'; end if;

  -- cancelled -> do not reuse.
  identity_key := 'opportunity-finder:v4:' || repeat('b', 64);
  prior_id := 'b2100000-0000-4000-8000-000000000001';
  current_id := 'b2200000-0000-4000-8000-000000000001';
  perform pg_temp.create_hotfix_single_job(prior_id, actor_id, 'cancelled', identity_key, now() + interval '1 day', false);
  perform pg_temp.create_hotfix_single_job(current_id, actor_id, 'awaiting_roles', null, now() + interval '1 day', true);
  select * into persisted from public.persist_opportunity_finder_dataset_snapshot(
    current_id, actor_id, gen_random_uuid(), repeat('8', 64), 'own', '[]'::jsonb,
    '[]'::jsonb, identity_key, '{}'::jsonb
  );
  if persisted.reused or persisted.committed_job_id <> current_id then
    raise exception 'cancelled job was reused';
  end if;

  -- expired successful -> do not reuse.
  identity_key := 'opportunity-finder:v4:' || repeat('c', 64);
  prior_id := 'b3100000-0000-4000-8000-000000000001';
  current_id := 'b3200000-0000-4000-8000-000000000001';
  perform pg_temp.create_hotfix_single_job(prior_id, actor_id, 'completed', identity_key, now() - interval '1 minute', false);
  perform pg_temp.create_hotfix_single_job(current_id, actor_id, 'awaiting_roles', null, now() + interval '1 day', true);
  select * into persisted from public.persist_opportunity_finder_dataset_snapshot(
    current_id, actor_id, gen_random_uuid(), repeat('8', 64), 'own', '[]'::jsonb,
    '[]'::jsonb, identity_key, '{}'::jsonb
  );
  if persisted.reused or persisted.committed_job_id <> current_id then
    raise exception 'expired job was reused';
  end if;

  -- completed -> preserve existing successful reuse behavior.
  identity_key := 'opportunity-finder:v4:' || repeat('d', 64);
  prior_id := 'b4100000-0000-4000-8000-000000000001';
  current_id := 'b4200000-0000-4000-8000-000000000001';
  perform pg_temp.create_hotfix_single_job(prior_id, actor_id, 'completed', identity_key, now() + interval '1 day', false);
  perform pg_temp.create_hotfix_single_job(current_id, actor_id, 'awaiting_roles', null, now() + interval '1 day', true);
  select * into persisted from public.persist_opportunity_finder_dataset_snapshot(
    current_id, actor_id, gen_random_uuid(), repeat('8', 64), 'own', '[]'::jsonb,
    '[]'::jsonb, identity_key, '{}'::jsonb
  );
  if not persisted.reused or persisted.committed_job_id <> prior_id then
    raise exception 'completed job was not reused';
  end if;

  -- processing -> preserve concurrent/idempotent reuse behavior.
  identity_key := 'opportunity-finder:v4:' || repeat('e', 64);
  prior_id := 'b5100000-0000-4000-8000-000000000001';
  current_id := 'b5200000-0000-4000-8000-000000000001';
  perform pg_temp.create_hotfix_single_job(prior_id, actor_id, 'matching', identity_key, now() + interval '1 day', false);
  perform pg_temp.create_hotfix_single_job(current_id, actor_id, 'awaiting_roles', null, now() + interval '1 day', true);
  select * into persisted from public.persist_opportunity_finder_dataset_snapshot(
    current_id, actor_id, gen_random_uuid(), repeat('8', 64), 'own', '[]'::jsonb,
    '[]'::jsonb, identity_key, '{}'::jsonb
  );
  if not persisted.reused or persisted.committed_job_id <> prior_id then
    raise exception 'processing job was not reused';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'opportunity_finder_jobs_two_file_idempotency_uidx'
      and indexdef like 'CREATE UNIQUE INDEX%'
      and indexdef like '%comparison_mode = ''two_files''%'
  ) then raise exception 'two-file idempotency uniqueness is missing'; end if;
end
$$;

-- Existing owner isolation and grants must remain unchanged by this hotfix.
do $$
begin
  if not exists (
    select 1 from pg_class relation
    where relation.oid = 'public.opportunity_finder_dataset_snapshots'::regclass
      and relation.relrowsecurity and relation.relforcerowsecurity
  ) then raise exception 'snapshot RLS/FORCE RLS changed'; end if;
  if has_function_privilege(
    'authenticated',
    'public.persist_opportunity_finder_dataset_snapshot(uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb)',
    'EXECUTE'
  ) then raise exception 'authenticated snapshot mutation privilege detected'; end if;
end
$$;

rollback;
