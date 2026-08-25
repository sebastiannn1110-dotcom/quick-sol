-- Run locally after 20260813120000 and 20260814120000. No remote writes.
begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'opportunity_finder_jobs'
      and column_name = 'comparison_mode'
  ) then raise exception 'comparison_mode missing'; end if;
  if not exists (
    select 1 from pg_class relation
    where relation.oid = 'public.opportunity_finder_dataset_snapshots'::regclass
      and relation.relrowsecurity and relation.relforcerowsecurity
  ) then raise exception 'snapshot RLS/FORCE RLS missing'; end if;
  if has_table_privilege('authenticated', 'public.opportunity_finder_dataset_snapshots', 'INSERT')
     or has_table_privilege('authenticated', 'public.opportunity_finder_dataset_snapshot_rows', 'UPDATE') then
    raise exception 'authenticated snapshot mutation grant detected';
  end if;
  if has_function_privilege('authenticated',
    'public.persist_opportunity_finder_dataset_snapshot(uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb)',
    'EXECUTE') then
    raise exception 'authenticated can persist untrusted snapshots directly';
  end if;
  if not has_function_privilege('authenticated',
    'public.get_opportunity_finder_uploaded_mpns(uuid)', 'EXECUTE') then
    raise exception 'owner-scoped uploaded MPN reader unavailable';
  end if;
end $$;

rollback;
