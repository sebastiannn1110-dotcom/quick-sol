-- Run after applying the Opportunity Finder migrations through
-- 20260824140000_stream_opportunity_finder_staged_commit.sql.
-- Read-only catalog/security contract; the transaction is always rolled back.
begin;

do $$
declare
  missing_table text;
  insecure_table text;
  canonical_storage_function text;
  staged_output_commit_function text;
  staged_output_replace_function text;
  staged_output_replace_oid oid;
  staged_output_replace_count integer;
  staged_output_commit_jsonb_agg_count integer;
  staged_output_replace_jsonb_agg_count integer;
  allocation_commit_function text;
  allocation_identity_function text;
  materialize_function text;
  replace_output_function text;
  queue_profile_function text;
  prepare_job_deletion_function text;
  prepare_expired_job_deletion_function text;
  finalize_job_deletion_function text;
  claim_file_retention_function text;
  finalize_file_retention_function text;
  abort_file_retention_function text;
begin
  select expected.table_name
  into missing_table
  from unnest(array[
    'opportunity_finder_tenants',
    'opportunity_finder_tenant_memberships',
    'opportunity_finder_demand_events',
    'opportunity_finder_demand_part_options',
    'opportunity_finder_supply_lots',
    'opportunity_finder_historical_signals',
    'opportunity_finder_allocations',
    'opportunity_finder_result_commercials',
    'opportunity_finder_result_financials',
    'opportunity_finder_rejected_rows',
    'opportunity_finder_manufacturer_registry_versions',
    'opportunity_finder_manufacturers',
    'opportunity_finder_manufacturer_aliases',
    'opportunity_finder_part_equivalence_versions',
    'opportunity_finder_part_equivalences',
    'opportunity_finder_review_decisions',
    'opportunity_finder_audit_events',
    'opportunity_finder_output_runs',
    'opportunity_finder_output_items'
  ]) as expected(table_name)
  where to_regclass('public.' || expected.table_name) is null
  limit 1;

  if missing_table is not null then
    raise exception 'missing Opportunity Finder table: %', missing_table;
  end if;

  select expected.table_name
  into insecure_table
  from unnest(array[
    'opportunity_finder_jobs',
    'opportunity_finder_files',
    'opportunity_finder_rows',
    'opportunity_finder_results',
    'opportunity_finder_possible_matches',
    'opportunity_finder_demand_events',
    'opportunity_finder_demand_part_options',
    'opportunity_finder_supply_lots',
    'opportunity_finder_historical_signals',
    'opportunity_finder_allocations',
    'opportunity_finder_result_commercials',
    'opportunity_finder_result_financials',
    'opportunity_finder_rejected_rows',
    'opportunity_finder_manufacturer_registry_versions',
    'opportunity_finder_manufacturers',
    'opportunity_finder_manufacturer_aliases',
    'opportunity_finder_part_equivalence_versions',
    'opportunity_finder_part_equivalences',
    'opportunity_finder_review_decisions',
    'opportunity_finder_audit_events',
    'opportunity_finder_output_runs',
    'opportunity_finder_output_items'
  ]) as expected(table_name)
  left join pg_class relation
    on relation.oid = to_regclass('public.' || expected.table_name)
  where not coalesce(relation.relrowsecurity, false)
     or not coalesce(relation.relforcerowsecurity, false)
  limit 1;

  if insecure_table is not null then
    raise exception 'RLS/FORCE RLS missing on table: %', insecure_table;
  end if;

  if has_table_privilege(
    'authenticated',
    'public.opportunity_finder_result_commercials',
    'SELECT'
  ) then
    raise exception 'authenticated unexpectedly has direct commercial SELECT';
  end if;

  if has_table_privilege(
    'authenticated',
    'public.opportunity_finder_result_financials',
    'SELECT'
  ) then
    raise exception 'authenticated unexpectedly has direct finance SELECT';
  end if;

  if has_table_privilege(
    'authenticated',
    'public.opportunity_finder_rows',
    'SELECT'
  ) then
    raise exception 'authenticated unexpectedly has staging SELECT';
  end if;

  if not has_table_privilege('authenticated', 'public.opportunity_finder_jobs', 'SELECT')
     or not has_table_privilege('authenticated', 'public.opportunity_finder_files', 'SELECT') then
    raise exception 'authenticated must retain SELECT on opportunity jobs/files';
  end if;

  if has_table_privilege('authenticated', 'public.opportunity_finder_jobs', 'INSERT')
     or has_table_privilege('authenticated', 'public.opportunity_finder_jobs', 'UPDATE')
     or has_table_privilege('authenticated', 'public.opportunity_finder_jobs', 'DELETE')
     or has_table_privilege('authenticated', 'public.opportunity_finder_jobs', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.opportunity_finder_jobs', 'REFERENCES')
     or has_table_privilege('authenticated', 'public.opportunity_finder_jobs', 'TRIGGER')
     or has_table_privilege('authenticated', 'public.opportunity_finder_files', 'INSERT')
     or has_table_privilege('authenticated', 'public.opportunity_finder_files', 'UPDATE')
     or has_table_privilege('authenticated', 'public.opportunity_finder_files', 'DELETE')
     or has_table_privilege('authenticated', 'public.opportunity_finder_files', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.opportunity_finder_files', 'REFERENCES')
     or has_table_privilege('authenticated', 'public.opportunity_finder_files', 'TRIGGER') then
    raise exception 'authenticated retains direct DML on opportunity jobs/files';
  end if;

  if exists (
    select 1
    from pg_policies policy_row
    where policy_row.schemaname = 'public'
      and policy_row.tablename in ('opportunity_finder_jobs', 'opportunity_finder_files')
      and upper(policy_row.cmd) in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
      and (
        'authenticated'::name = any(policy_row.roles)
        or 'public'::name = any(policy_row.roles)
      )
  ) then
    raise exception 'opportunity jobs/files retain an authenticated write policy';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.materialize_opportunity_finder_entities(uuid,text,uuid)',
    'EXECUTE'
  ) then
    raise exception 'service_role cannot execute materialize RPC';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.reset_opportunity_finder_job_attempt(uuid,text,uuid,bigint)',
    'EXECUTE'
  ) then
    raise exception 'service_role cannot execute fenced reset RPC';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.reset_opportunity_finder_job_attempt(uuid,text,uuid,bigint)',
    'EXECUTE'
  ) then
    raise exception 'authenticated unexpectedly can execute fenced reset RPC';
  end if;

  if not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'opportunity_finder_files'
      and column_row.column_name = 'validity_override_expires_at'
  ) then
    raise exception 'file-level supplier-offer validity attestation is missing';
  end if;

  if (
    select count(*)
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'opportunity_finder_files'
      and column_row.column_name in (
        'storage_deletion_token', 'storage_deletion_started_at'
      )
  ) <> 2 then
    raise exception 'file retention two-phase claim columns are missing';
  end if;

  if not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'opportunity_finder_demand_part_options'
      and column_row.column_name = 'unit_of_measure'
  ) then
    raise exception 'demand option-level UOM is missing';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.confirm_opportunity_finder_roles(uuid,uuid,uuid,text,timestamptz,uuid,text,timestamptz)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.cancel_opportunity_finder_job(uuid,uuid)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.retry_opportunity_finder_job(uuid,uuid)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.queue_opportunity_finder_profile(uuid,uuid,text,timestamptz)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.prepare_opportunity_finder_job_deletion(uuid,uuid)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.finalize_opportunity_finder_job_deletion(uuid,uuid)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.prepare_opportunity_finder_expired_job_deletion(uuid,text,timestamptz)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.claim_opportunity_finder_file_retention(integer,timestamptz)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.finalize_opportunity_finder_file_retention(uuid,timestamptz)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.abort_opportunity_finder_file_retention(uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'service_role lacks an atomic transition/deletion RPC';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.confirm_opportunity_finder_roles(uuid,uuid,uuid,text,timestamptz,uuid,text,timestamptz)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.cancel_opportunity_finder_job(uuid,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.retry_opportunity_finder_job(uuid,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.queue_opportunity_finder_profile(uuid,uuid,text,timestamptz)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.prepare_opportunity_finder_job_deletion(uuid,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.finalize_opportunity_finder_job_deletion(uuid,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.prepare_opportunity_finder_expired_job_deletion(uuid,text,timestamptz)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.claim_opportunity_finder_file_retention(integer,timestamptz)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.finalize_opportunity_finder_file_retention(uuid,timestamptz)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.abort_opportunity_finder_file_retention(uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated can bypass the API through a transition/deletion RPC';
  end if;

  if public.normalize_opportunity_manufacturer_exact('Ａ-Ｂ') <> 'A-B'
     or public.normalize_opportunity_manufacturer_exact('A-B') =
        public.normalize_opportunity_manufacturer_exact('AB')
     or public.normalize_opportunity_manufacturer_exact('华为') is null then
    raise exception 'exact manufacturer normalization loses punctuation or Unicode identity';
  end if;

  if to_regprocedure('public.normalize_opportunity_unit_of_measure(text)') is null
     or public.normalize_opportunity_unit_of_measure('  ＥＡ  ') <> 'EA'
     or public.normalize_opportunity_unit_of_measure(E'ea\t ') <> 'EA'
     or not has_function_privilege(
       'service_role', 'public.normalize_opportunity_unit_of_measure(text)', 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', 'public.normalize_opportunity_unit_of_measure(text)', 'EXECUTE'
     ) then
    raise exception 'SQL UOM normalization does not match the fenced worker contract';
  end if;

  if to_regprocedure('public.opportunity_finder_candidate_uuid(text)') is null
     or public.opportunity_finder_candidate_uuid(repeat('f', 64)) <>
        'ffffffff-ffff-5fff-bfff-ffffffffffff'::uuid
     or not has_function_privilege(
       'service_role', 'public.opportunity_finder_candidate_uuid(text)', 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', 'public.opportunity_finder_candidate_uuid(text)', 'EXECUTE'
     ) then
    raise exception 'candidate UUID derivation diverges from deterministicUuidFromHex';
  end if;

  if not has_table_privilege('service_role', 'public.opportunity_finder_rows', 'SELECT')
     or not has_table_privilege('service_role', 'public.opportunity_finder_rows', 'INSERT')
     or has_table_privilege('service_role', 'public.opportunity_finder_rows', 'UPDATE')
     or has_table_privilege('service_role', 'public.opportunity_finder_rows', 'DELETE')
     or has_table_privilege('service_role', 'public.opportunity_finder_rows', 'TRUNCATE') then
    raise exception 'canonical row grants do not enforce insert/select-only ingestion';
  end if;

  select expected.table_name
  into insecure_table
  from unnest(array[
    'opportunity_finder_results',
    'opportunity_finder_possible_matches',
    'opportunity_finder_demand_events',
    'opportunity_finder_demand_part_options',
    'opportunity_finder_supply_lots',
    'opportunity_finder_historical_signals',
    'opportunity_finder_allocations',
    'opportunity_finder_result_commercials',
    'opportunity_finder_result_financials',
    'opportunity_finder_rejected_rows',
    'opportunity_finder_review_decisions'
  ]) as expected(table_name)
  where has_table_privilege('service_role', 'public.' || expected.table_name, 'INSERT')
     or has_table_privilege('service_role', 'public.' || expected.table_name, 'UPDATE')
     or has_table_privilege('service_role', 'public.' || expected.table_name, 'DELETE')
     or has_table_privilege('service_role', 'public.' || expected.table_name, 'TRUNCATE')
     or has_table_privilege('service_role', 'public.' || expected.table_name, 'REFERENCES')
     or has_table_privilege('service_role', 'public.' || expected.table_name, 'TRIGGER')
  limit 1;

  if insecure_table is not null then
    raise exception 'service_role can bypass fenced RPCs on table: %', insecure_table;
  end if;

  if not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'opportunity_finder_rows'
      and column_row.column_name = 'ingestion_lock_token'
  ) or not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'opportunity_finder_rows'
      and column_row.column_name = 'ingestion_fence'
  ) or not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'opportunity_finder_rejected_rows'
      and column_row.column_name = 'ingestion_lock_token'
  ) or not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'opportunity_finder_rejected_rows'
      and column_row.column_name = 'ingestion_fence'
  ) then
    raise exception 'attempt fence columns are missing from staging/rejected rows';
  end if;

  if not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.opportunity_finder_rows'::regclass
      and trigger_row.tgname = 'opportunity_finder_rows_assert_ingestion_fence'
      and not trigger_row.tgisinternal
  ) or not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.opportunity_finder_rejected_rows'::regclass
      and trigger_row.tgname = 'opportunity_finder_rejected_assert_ingestion_fence'
      and not trigger_row.tgisinternal
  ) then
    raise exception 'attempt fence triggers are missing from staging/rejected rows';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.replace_opportunity_finder_job_output(uuid,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,integer,integer,integer)',
    'EXECUTE'
  ) then
    raise exception 'service_role cannot execute atomic output RPC';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.replace_opportunity_finder_job_output(uuid,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,integer,integer,integer)',
    'EXECUTE'
  ) then
    raise exception 'authenticated unexpectedly can execute worker output RPC';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.begin_opportunity_finder_output(uuid,text,uuid,bigint,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.append_opportunity_finder_output(uuid,text,uuid,bigint,text,text,bigint,jsonb)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.commit_staged_opportunity_finder_output(uuid,text,uuid,bigint,text,jsonb,jsonb,integer,integer,integer)',
    'EXECUTE'
  ) then
    raise exception 'service_role cannot execute the fenced staged-output RPC family';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.begin_opportunity_finder_output(uuid,text,uuid,bigint,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.append_opportunity_finder_output(uuid,text,uuid,bigint,text,text,bigint,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.commit_staged_opportunity_finder_output(uuid,text,uuid,bigint,text,jsonb,jsonb,integer,integer,integer)',
    'EXECUTE'
  ) then
    raise exception 'authenticated unexpectedly can execute staged-output RPCs';
  end if;

  if has_table_privilege('authenticated', 'public.opportunity_finder_output_runs', 'SELECT')
     or has_table_privilege('authenticated', 'public.opportunity_finder_output_runs', 'INSERT')
     or has_table_privilege('authenticated', 'public.opportunity_finder_output_runs', 'UPDATE')
     or has_table_privilege('authenticated', 'public.opportunity_finder_output_runs', 'DELETE')
     or has_table_privilege('authenticated', 'public.opportunity_finder_output_items', 'SELECT')
     or has_table_privilege('authenticated', 'public.opportunity_finder_output_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.opportunity_finder_output_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.opportunity_finder_output_items', 'DELETE')
     or has_table_privilege('service_role', 'public.opportunity_finder_output_runs', 'SELECT')
     or has_table_privilege('service_role', 'public.opportunity_finder_output_runs', 'INSERT')
     or has_table_privilege('service_role', 'public.opportunity_finder_output_runs', 'UPDATE')
     or has_table_privilege('service_role', 'public.opportunity_finder_output_runs', 'DELETE')
     or has_table_privilege('service_role', 'public.opportunity_finder_output_items', 'SELECT')
     or has_table_privilege('service_role', 'public.opportunity_finder_output_items', 'INSERT')
     or has_table_privilege('service_role', 'public.opportunity_finder_output_items', 'UPDATE')
     or has_table_privilege('service_role', 'public.opportunity_finder_output_items', 'DELETE') then
    raise exception 'staged output tables expose direct grants instead of RPC-only access';
  end if;

  if exists (
    select 1
    from information_schema.role_table_grants table_grant
    where table_grant.table_schema = 'public'
      and table_grant.table_name in (
        'opportunity_finder_output_runs',
        'opportunity_finder_output_items'
      )
      and table_grant.grantee in ('authenticated', 'service_role')
  ) then
    raise exception 'staged output tables retain an authenticated/service_role grant';
  end if;

  select pg_get_functiondef(
    'public.commit_staged_opportunity_finder_output(uuid,text,uuid,bigint,text,jsonb,jsonb,integer,integer,integer)'::regprocedure
  ) into staged_output_commit_function;

  select count(*)
  into staged_output_replace_count
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'replace_opportunity_finder_job_output_from_stage';

  if staged_output_replace_count <> 1 then
    raise exception
      'expected exactly one replace_opportunity_finder_job_output_from_stage helper, found %',
      staged_output_replace_count;
  end if;

  staged_output_replace_oid := to_regprocedure(
    'public.replace_opportunity_finder_job_output_from_stage(uuid,text,uuid,bigint,text,uuid,jsonb,integer,integer,integer)'
  )::oid;

  if staged_output_replace_oid is null then
    raise exception 'staged replacement helper has an unexpected signature';
  end if;

  select pg_get_functiondef(staged_output_replace_oid)
  into staged_output_replace_function;

  if staged_output_commit_function not ilike '%incomplete_opportunity_output_manifest%'
     or staged_output_commit_function not ilike '%replace_opportunity_finder_job_output_from_stage%'
     or staged_output_commit_function not ilike '%for update%'
     or staged_output_commit_function not ilike '%stale_opportunity_worker_fence%'
     or staged_output_commit_function not ilike '%stale_opportunity_output_run%'
     or staged_output_commit_function not ilike '%processing_fence%'
     or staged_output_commit_function !~* 'delete[[:space:]]+from[[:space:]]+public[.]opportunity_finder_output_runs' then
    raise exception
      'staged output commit lacks manifest validation, fenced atomic replacement, row locking or success cleanup';
  end if;

  select count(*)
  into staged_output_commit_jsonb_agg_count
  from regexp_matches(
    staged_output_commit_function,
    'jsonb_agg[[:space:]]*[(]',
    'gi'
  );

  select count(*)
  into staged_output_replace_jsonb_agg_count
  from regexp_matches(
    staged_output_replace_function,
    'jsonb_agg[[:space:]]*[(]',
    'gi'
  );

  if staged_output_commit_jsonb_agg_count <> 0
     or staged_output_replace_jsonb_agg_count > 1
     or (
       staged_output_replace_jsonb_agg_count = 1
       and (
         staged_output_replace_function !~*
           'jsonb_agg[[:space:]]*[(][[:space:]]*allocation_item[.]payload[[:space:]]+order[[:space:]]+by[[:space:]]+allocation_item[.]item_index'
         or staged_output_replace_function !~*
           'allocation_item[.]item_index[[:space:]]+between[[:space:]]+allocation_offset[[:space:]]+and[[:space:]]+allocation_end'
         or staged_output_replace_function not ilike '%allocation_chunk_row_limit constant integer := 10000%'
         or staged_output_replace_function not ilike '%allocation_chunk_byte_limit constant bigint := 8388608%'
         or staged_output_replace_function not ilike '%accumulated_payload_bytes <= allocation_chunk_byte_limit%'
         or staged_output_replace_function not ilike '%limit allocation_chunk_row_limit%'
       )
     ) then
    raise exception
      'staged output publication contains a whole-kind or otherwise unbounded jsonb_agg';
  end if;

  if staged_output_replace_function not ilike '%opportunity_finder_output_items%'
     or staged_output_replace_function not ilike '%output_kind%'
     or staged_output_replace_function not ilike '%run_id%'
     or staged_output_replace_function not ilike '%item_index%'
     or staged_output_replace_function not ilike '%for update%'
     or staged_output_replace_function not ilike '%stale_opportunity_worker_fence%'
     or staged_output_replace_function not ilike '%processing_fence%' then
    raise exception
      'staged replacement helper does not consume ordered staged rows under the worker fence';
  end if;

  if exists (
    select 1
    from pg_proc procedure
    where procedure.oid = staged_output_replace_oid
      and (
        not procedure.prosecdef
        or procedure.proretset
        or procedure.prorettype <> 'public.opportunity_finder_jobs'::regtype
        or procedure.proargnames is distinct from array[
          'job_id',
          'worker_id',
          'lock_token',
          'processing_fence',
          'commit_key',
          'run_id',
          'summary',
          'warning_count',
          'missing_mpn_rows',
          'invalid_quantity_rows'
        ]::text[]
        or not exists (
          select 1
          from unnest(coalesce(procedure.proconfig, array[]::text[])) configuration
          where configuration like 'search_path=%'
        )
      )
  ) then
    raise exception
      'staged replacement helper has an unsafe or incomplete security/fencing signature';
  end if;

  if has_function_privilege('anon', staged_output_replace_oid, 'EXECUTE')
     or has_function_privilege('authenticated', staged_output_replace_oid, 'EXECUTE')
     or has_function_privilege('service_role', staged_output_replace_oid, 'EXECUTE') then
    raise exception 'internal staged replacement helper is directly executable by an API role';
  end if;

  select pg_get_functiondef(
    'public.commit_opportunity_finder_allocations(uuid,text,uuid,jsonb)'::regprocedure
  ) into allocation_commit_function;

  select pg_get_functiondef(
    'public.opportunity_finder_allocation_identity_kind(uuid,uuid,uuid,uuid)'::regprocedure
  ) into allocation_identity_function;

  select pg_get_functiondef(
    'public.materialize_opportunity_finder_entities(uuid,text,uuid)'::regprocedure
  ) into materialize_function;

  select pg_get_functiondef(
    'public.replace_opportunity_finder_job_output(uuid,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,integer,integer,integer)'::regprocedure
  ) into replace_output_function;

  select pg_get_functiondef(
    'public.queue_opportunity_finder_profile(uuid,uuid,text,timestamptz)'::regprocedure
  ) into queue_profile_function;
  select pg_get_functiondef(
    'public.prepare_opportunity_finder_job_deletion(uuid,uuid)'::regprocedure
  ) into prepare_job_deletion_function;
  select pg_get_functiondef(
    'public.finalize_opportunity_finder_job_deletion(uuid,uuid)'::regprocedure
  ) into finalize_job_deletion_function;
  select pg_get_functiondef(
    'public.prepare_opportunity_finder_expired_job_deletion(uuid,text,timestamptz)'::regprocedure
  ) into prepare_expired_job_deletion_function;
  select pg_get_functiondef(
    'public.claim_opportunity_finder_file_retention(integer,timestamptz)'::regprocedure
  ) into claim_file_retention_function;
  select pg_get_functiondef(
    'public.finalize_opportunity_finder_file_retention(uuid,timestamptz)'::regprocedure
  ) into finalize_file_retention_function;
  select pg_get_functiondef(
    'public.abort_opportunity_finder_file_retention(uuid,text)'::regprocedure
  ) into abort_file_retention_function;

  if queue_profile_function not ilike '%for update%'
     or queue_profile_function not ilike '%storage_deletion_token%'
     or prepare_job_deletion_function not ilike '%JOB_DELETION_REQUESTED%'
     or prepare_job_deletion_function not ilike '%storage_deletion_token%'
     or finalize_job_deletion_function not ilike '%job_deleted%'
     or prepare_expired_job_deletion_function not ilike '%status is distinct from input_expected_status%'
     or prepare_expired_job_deletion_function not ilike '%expires_at >= input_observed_at%'
     or claim_file_retention_function not ilike '%for update of job skip locked%'
     or claim_file_retention_function not ilike '%for update of file skip locked%'
     or claim_file_retention_function not ilike '%interval ''2 hours''%'
     or claim_file_retention_function not ilike '%source_file_retention_reclaimed%'
     or claim_file_retention_function not ilike
        '%JOB_DELETION_REQUESTED%updated_at < input_claimed_at - interval ''2 hours''%'
     or finalize_file_retention_function not ilike '%source_file_deleted%'
     or abort_file_retention_function not ilike '%source_file_deletion_failed%' then
    raise exception 'atomic profile/deletion RPCs lost locking, fencing or audit semantics';
  end if;

  if allocation_commit_function ilike '%allocation_batch_too_large%'
     or allocation_commit_function not ilike '%result_allocation_total_mismatch%'
     or allocation_commit_function not ilike '%allocation_option_lot_identity_mismatch%'
     or allocation_commit_function not ilike '%durable_review_required_before_allocation%'
     or allocation_commit_function not ilike
        '%normalize_opportunity_unit_of_measure%coalesce(option_row.unit_of_measure, event_row.unit_of_measure)%'
     or allocation_commit_function ilike '%target_result.review_status%' then
    raise exception 'allocation commit retains the 10k cap or lost the per-result invariant';
  end if;

  if allocation_identity_function not ilike
       '%normalize_opportunity_unit_of_measure%coalesce(option_row.unit_of_measure, event_row.unit_of_measure)%'
     or materialize_function not ilike '%option_row.unit_of_measure%' then
    raise exception 'option UOM is not materialized or identity falls back to event before checking the option';
  end if;

  if replace_output_function ilike '%coalesce(candidate.id, gen_random_uuid())%'
     or replace_output_function not ilike '%opportunity_finder_candidate_uuid%'
     or replace_output_function not ilike '%candidate_id_key_mismatch%'
     or replace_output_function not ilike '%durable_review.decision%'
     or replace_output_function not ilike '%result_candidate_not_found_for_job%' then
    raise exception 'atomic replace does not preserve and reconnect durable candidate identity/review';
  end if;

  if to_regprocedure(
    'public.opportunity_finder_allocation_identity_kind(uuid,uuid,uuid,uuid)'
  ) is null or to_regprocedure(
    'public.has_approved_opportunity_finder_allocation_review(uuid,uuid,uuid,uuid)'
  ) is null then
    raise exception 'allocation identity/review boundary functions are missing';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.opportunity_finder_allocation_identity_kind(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.has_approved_opportunity_finder_allocation_review(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ) then
    raise exception 'authenticated can call service-only allocation validation functions';
  end if;

  if has_table_privilege('service_role', 'public.opportunity_finder_allocations', 'INSERT')
     or has_table_privilege('service_role', 'public.opportunity_finder_allocations', 'UPDATE')
     or has_table_privilege('service_role', 'public.opportunity_finder_allocations', 'DELETE')
     or has_table_privilege('service_role', 'public.opportunity_finder_allocations', 'TRUNCATE') then
    raise exception 'service_role can bypass the fenced allocation commit RPC';
  end if;

  if exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'opportunity_finder_allocations'
      and column_row.column_name in (
        'demand_event_id', 'demand_part_option_id', 'supply_lot_id', 'supply_lot_key'
      )
      and column_row.is_nullable <> 'NO'
  ) then
    raise exception 'allocation durable identity columns remain nullable';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.opportunity_finder_manufacturer_registry_versions'::regclass
      and constraint_row.conname = 'opportunity_finder_manufacturer_active_version_approval_check'
      and constraint_row.contype = 'c'
  ) or not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.opportunity_finder_part_equivalence_versions'::regclass
      and constraint_row.conname = 'opportunity_finder_equivalence_active_version_approval_check'
      and constraint_row.contype = 'c'
  ) then
    raise exception 'active catalog versions are not constrained to human approval';
  end if;

  if not exists (
    select 1
    from pg_policies policy_row
    where policy_row.schemaname = 'public'
      and policy_row.tablename = 'opportunity_finder_manufacturer_aliases'
      and policy_row.policyname = 'opportunity_finder_aliases_select_approved'
      and policy_row.qual ilike '%version.status = ''active''%'
      and policy_row.qual ilike '%version.approved_at is not null%'
  ) or not exists (
    select 1
    from pg_policies policy_row
    where policy_row.schemaname = 'public'
      and policy_row.tablename = 'opportunity_finder_part_equivalences'
      and policy_row.policyname = 'opportunity_finder_equivalences_select_approved'
      and policy_row.qual ilike '%version.status = ''active''%'
      and policy_row.qual ilike '%version.approved_at is not null%'
  ) then
    raise exception 'catalog RLS does not require an active approved version';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.decide_opportunity_finder_review(uuid,text,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated cannot execute atomic review RPC';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.opportunity_finder_review_decisions'::regclass
      and constraint_row.conname = 'opportunity_finder_review_entity_uidx'
      and constraint_row.contype = 'u'
  ) then
    raise exception 'review decision idempotency constraint is missing';
  end if;

  if exists (
    select 1
    from pg_indexes index_row
    where index_row.schemaname = 'public'
      and index_row.tablename = 'opportunity_finder_allocations'
      and index_row.indexdef ilike 'CREATE UNIQUE INDEX% (supply_lot_id)%'
  ) then
    raise exception 'supply_lot_id must not be globally unique; deterministic splits are allowed';
  end if;

  if exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.opportunity_finder_possible_matches'::regclass
      and constraint_row.conname = 'opportunity_finder_possible_m_job_id_demand_normalized_mpn__key'
  ) then
    raise exception 'legacy candidate uniqueness still collapses distinct events/lots';
  end if;

  if to_regprocedure('public.canonicalize_opportunity_finder_file_storage()') is null then
    raise exception 'canonical file-storage trigger function is missing';
  end if;

  if not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.opportunity_finder_files'::regclass
      and trigger_row.tgname = 'opportunity_finder_files_canonical_storage'
      and not trigger_row.tgisinternal
      and pg_get_triggerdef(trigger_row.oid) ilike '%BEFORE INSERT OR UPDATE%'
  ) then
    raise exception 'canonical file-storage trigger is missing or has the wrong timing';
  end if;

  select pg_get_functiondef(
    'public.canonicalize_opportunity_finder_file_storage()'::regprocedure
  ) into canonical_storage_function;

  if canonical_storage_function not ilike '%new.storage_bucket := ''opportunity-finder''%'
     or canonical_storage_function not ilike '%parent_created_by::text%new.job_id::text%new.id::text%canonical_extension%'
     or canonical_storage_function not ilike '%\.csv$%'
     or canonical_storage_function not ilike '%\.xlsx$%' then
    raise exception 'canonical file-storage function does not enforce the bucket/path/extension contract';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.canonicalize_opportunity_finder_file_storage()',
    'EXECUTE'
  ) then
    raise exception 'authenticated can execute the canonical storage trigger function directly';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.opportunity_finder_audit_events'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.opportunity_finder_jobs'::regclass
      and constraint_row.confdeltype = 'n'
      and pg_get_constraintdef(constraint_row.oid) ilike 'FOREIGN KEY (job_id)%'
  ) then
    raise exception 'audit event job FK must preserve events with ON DELETE SET NULL';
  end if;

  if not has_table_privilege('service_role', 'public.opportunity_finder_audit_events', 'SELECT')
     or not has_table_privilege('service_role', 'public.opportunity_finder_audit_events', 'INSERT') then
    raise exception 'service_role lacks SELECT/INSERT on opportunity audit events';
  end if;

  if has_table_privilege('service_role', 'public.opportunity_finder_audit_events', 'UPDATE')
     or has_table_privilege('service_role', 'public.opportunity_finder_audit_events', 'DELETE')
     or has_table_privilege('service_role', 'public.opportunity_finder_audit_events', 'TRUNCATE')
     or has_table_privilege('service_role', 'public.opportunity_finder_audit_events', 'REFERENCES')
     or has_table_privilege('service_role', 'public.opportunity_finder_audit_events', 'TRIGGER') then
    raise exception 'service_role has non-append-only privileges on opportunity audit events';
  end if;

  if not exists (
    select 1
    from storage.buckets bucket
    where bucket.id = 'opportunity-finder'
      and bucket.public = false
  ) then
    raise exception 'opportunity-finder storage bucket is not private';
  end if;
end;
$$;

rollback;
