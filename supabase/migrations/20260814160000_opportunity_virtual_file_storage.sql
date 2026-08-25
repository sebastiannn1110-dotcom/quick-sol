-- Single-file Opportunity Finder stores one database-only virtual file that
-- represents the authorized QuikSol snapshot. It is never uploaded to Storage,
-- while user-provided files remain restricted to CSV/XLSX.
create or replace function public.canonicalize_opportunity_finder_file_storage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  parent_created_by uuid;
  canonical_extension text;
begin
  select job.created_by
  into parent_created_by
  from public.opportunity_finder_jobs job
  where job.id = new.job_id;

  if parent_created_by is null then
    raise exception using errcode = '23503', message = 'opportunity_job_not_found';
  end if;

  if new.id is null then
    raise exception using errcode = '23514', message = 'opportunity_file_id_required';
  end if;

  canonical_extension := case
    when new.source_kind = 'platform_snapshot' then '.json'
    when lower(new.original_file_name) ~ '\.csv$' then '.csv'
    when lower(new.original_file_name) ~ '\.xlsx$' then '.xlsx'
    else null
  end;

  if canonical_extension is null then
    raise exception using errcode = '23514', message = 'opportunity_file_extension_invalid';
  end if;

  new.storage_bucket := 'opportunity-finder';
  new.storage_path := parent_created_by::text
    || '/' || new.job_id::text
    || '/' || new.id::text
    || canonical_extension;

  return new;
end;
$$;

revoke all on function public.canonicalize_opportunity_finder_file_storage()
  from public, anon, authenticated, service_role;

comment on function public.canonicalize_opportunity_finder_file_storage() is
  'Derives canonical locators; real uploads stay CSV/XLSX and database-only platform snapshots use JSON.';
