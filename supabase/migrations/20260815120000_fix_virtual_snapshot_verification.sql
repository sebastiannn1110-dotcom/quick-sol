-- Opportunity Finder hotfix: distinguish physical uploads from the internal
-- database-only snapshot, and keep failed/expired single-file jobs from
-- blocking a fresh comparison. This migration intentionally leaves RLS,
-- tenant isolation, matching, quantities and financial logic unchanged.

do $migration$
declare
  function_definition text;
  previous_guard constant text := $previous_guard$
        file.validation_status <> 'verified'
        or file.content_sha256 is null
        or file.actual_size_bytes is null
$previous_guard$;
  corrected_guard constant text := $corrected_guard$
        file.validation_status <> 'verified'
        or file.content_sha256 is null
        or (file.source_kind = 'uploaded' and file.actual_size_bytes is null)
        or (
          file.source_kind = 'platform_snapshot'
          and (
            file.mime_type is distinct from 'application/json'
            or file.storage_bucket is distinct from 'opportunity-finder'
            or file.storage_path is distinct from (
              locked_job.created_by::text || '/' || input_job_id::text || '/'
              || file.id::text || '.json'
            )
          )
        )
$corrected_guard$;
begin
  select pg_get_functiondef(
    'public.materialize_opportunity_finder_entities(uuid,text,uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
     or strpos(function_definition, previous_guard) = 0 then
    raise exception 'unexpected materialize_opportunity_finder_entities definition';
  end if;

  function_definition := replace(function_definition, previous_guard, corrected_guard);
  execute function_definition;
end
$migration$;

-- Two-file comparisons retain their existing database uniqueness guarantee.
-- Single-file comparisons choose a reusable job inside the persistence RPC,
-- where an advisory transaction lock serializes the same tenant/owner/key.
drop index if exists public.opportunity_finder_jobs_tenant_owner_idempotency_uidx;

create unique index opportunity_finder_jobs_two_file_idempotency_uidx
  on public.opportunity_finder_jobs (tenant_id, created_by, idempotency_key)
  where idempotency_key is not null and comparison_mode = 'two_files';

create index opportunity_finder_jobs_single_file_idempotency_lookup_idx
  on public.opportunity_finder_jobs (
    tenant_id, created_by, idempotency_key, created_at desc
  )
  where idempotency_key is not null and comparison_mode = 'single_file';

do $migration$
declare
  function_definition text;
  previous_lookup constant text := $previous_lookup$
  select job.id into existing_job_id
  from public.opportunity_finder_jobs job
  where job.tenant_id = locked_job.tenant_id
    and job.created_by = input_actor_id
    and job.idempotency_key = input_idempotency_key
    and job.id <> input_job_id
  order by job.created_at desc
  limit 1;
$previous_lookup$;
  corrected_lookup constant text := $corrected_lookup$
  -- Serialize one-file snapshot decisions without mutating historical jobs.
  perform pg_advisory_xact_lock(
    hashtextextended(
      locked_job.tenant_id::text || chr(31) || input_actor_id::text
      || chr(31) || input_idempotency_key,
      0
    )
  );

  select job.id into existing_job_id
  from public.opportunity_finder_jobs job
  where job.tenant_id = locked_job.tenant_id
    and job.created_by = input_actor_id
    and job.idempotency_key = input_idempotency_key
    and job.id <> input_job_id
    and job.comparison_mode = 'single_file'
    and job.status in (
      'uploading', 'queued', 'profiling', 'awaiting_roles',
      'parsing', 'matching', 'completed', 'completed_with_warnings'
    )
    and job.expires_at > now()
  order by job.created_at desc
  limit 1;
$corrected_lookup$;
begin
  select pg_get_functiondef(
    'public.persist_opportunity_finder_dataset_snapshot(uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb)'::regprocedure
  ) into function_definition;

  if function_definition is null
     or strpos(function_definition, previous_lookup) = 0 then
    raise exception 'unexpected persist_opportunity_finder_dataset_snapshot definition';
  end if;

  function_definition := replace(function_definition, previous_lookup, corrected_lookup);
  execute function_definition;
end
$migration$;

comment on index public.opportunity_finder_jobs_two_file_idempotency_uidx is
  'Preserves strict concurrent idempotency for physical two-file comparisons.';
comment on index public.opportunity_finder_jobs_single_file_idempotency_lookup_idx is
  'Supports advisory-lock-protected lookup of reusable, unexpired single-file jobs.';
