-- Local-only executable RLS check. Apply all migrations first.
begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('10000000-0000-4000-8000-000000000001', 'single-a@example.invalid', '{"full_name":"Single A","role":"employee"}'),
  ('20000000-0000-4000-8000-000000000002', 'single-b@example.invalid', '{"full_name":"Single B","role":"employee"}');

insert into public.opportunity_finder_jobs (
  id, created_by, tenant_id, comparison_mode, status, current_stage,
  dataset_version, dataset_scope, snapshot_status
) values
  ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'single_file', 'uploading', 'uploading', repeat('a', 64), 'own', 'pending'),
  ('22000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
   'single_file', 'uploading', 'uploading', repeat('b', 64), 'own', 'pending');

insert into public.opportunity_finder_dataset_snapshots (
  id, job_id, tenant_id, created_by, uploaded_role, opposite_dataset_role,
  dataset_version, dataset_scope, manifest
) values
  ('12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 'demand', 'stock', repeat('a', 64), 'own', '[]'),
  ('23000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000002', 'demand', 'stock', repeat('b', 64), 'own', '[]');

-- These fixtures represent finalized snapshots. R7 intentionally hides a
-- snapshot until the job's atomic visibility pointer references it.
update public.opportunity_finder_jobs
set snapshot_status='ready',
    dataset_snapshot_id=case id
      when '11000000-0000-4000-8000-000000000001' then '12000000-0000-4000-8000-000000000001'::uuid
      else '23000000-0000-4000-8000-000000000002'::uuid
    end,
    dataset_snapshot_at=clock_timestamp()
where id in (
  '11000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000002'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);

do $$
begin
  if (select count(*) from public.opportunity_finder_dataset_snapshots) <> 1 then
    raise exception 'snapshot cross-tenant isolation failed';
  end if;
  if exists (
    select 1 from public.opportunity_finder_dataset_snapshots
    where created_by = '20000000-0000-4000-8000-000000000002'
  ) then raise exception 'tenant B snapshot leaked to tenant A'; end if;
end $$;

reset role;
rollback;
