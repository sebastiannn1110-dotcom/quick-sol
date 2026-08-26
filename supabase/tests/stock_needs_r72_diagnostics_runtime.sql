-- R7.2 Stock Needs execution-plan diagnostic. Disposable PostgreSQL only.
-- Usage: psql -v scale_rows=10000 -f supabase/tests/stock_needs_r72_diagnostics_runtime.sql
\set ON_ERROR_STOP on
\timing on

\if :{?scale_rows}
\else
\set scale_rows 10000
\endif

do $$
begin
  if current_database() !~ '^quiksol_privacy_round5_test_r7[a-z0-9_]*$' then
    raise exception 'REFUSING_NON_R7_DIAGNOSTIC_DATABASE';
  end if;
end;
$$;

begin;

insert into auth.users (id, email, raw_user_meta_data)
select
  ('d7200000-0000-4000-8000-' || lpad(actor_number::text, 12, '0'))::uuid,
  format('r72-actor-%s@example.invalid', actor_number),
  '{}'::jsonb
from generate_series(0, 20) actor_number;

update public.profiles
set role = case when id = 'd7200000-0000-4000-8000-000000000000' then 'admin' else 'employee' end,
    department = 'R72 Synthetic',
    region = 'R72 Synthetic'
where id::text like 'd7200000-0000-4000-8000-%';

insert into public.upload_batches (
  id, uploaded_by, original_file_name, status, created_at
)
select
  ('d7210000-0000-4000-8000-' || lpad(owner_number::text, 12, '0'))::uuid,
  ('d7200000-0000-4000-8000-' || lpad(owner_number::text, 12, '0'))::uuid,
  format('r72-synthetic-%s.xlsx', owner_number),
  'completed',
  '2026-08-25 00:00:00+00'::timestamptz + owner_number * interval '1 minute'
from generate_series(1, 20) owner_number;

update public.business_upload_versions
set summary_version = data_version,
    dirty = false,
    rebuild_status = 'ready'
where owner_id::text like 'd7200000-0000-4000-8000-%';

insert into public.business_mpn_summaries (
  upload_batch_id, owner_id, data_version, normalized_mpn, display_mpn,
  stock_required_qty, stock_available_qty, stock_customer_name,
  stock_supplier_name, stock_manufacturer_name, source_record_count
)
select
  version.upload_batch_id,
  version.owner_id,
  version.data_version,
  format('MPN%s', lpad(part_number::text, 9, '0')),
  format('MPN-%s', lpad(part_number::text, 9, '0')),
  10,
  case when part_number % 3 = 0 then 0 else 12 end,
  format('Synthetic Customer %s', part_number % 100),
  format('Synthetic Supplier %s', part_number % 50),
  format('Synthetic Maker %s', part_number % 25),
  1
from generate_series(1, :'scale_rows'::integer) part_number
join public.business_upload_versions version
  on version.upload_batch_id = (
    'd7210000-0000-4000-8000-' || lpad((1 + ((part_number - 1) % 20))::text, 12, '0')
  )::uuid;

analyze public.business_mpn_summaries;
analyze public.upload_batches;
analyze public.business_upload_versions;
analyze public.profiles;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd7200000-0000-4000-8000-000000000000', true);
set local statement_timeout = '8s';

select greatest(:'scale_rows'::integer - 100, 0) as last_offset \gset
select greatest((:'scale_rows'::integer / 2) - 50, 0) as middle_offset \gset

-- Administrator: first, middle, last and filtered pages.
explain (analyze, buffers, settings, summary, format text)
select public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);

explain (analyze, buffers, settings, summary, format text)
select public.get_stock_needs_page_v1(100, :middle_offset, null, null, null, null, null, null, null);

explain (analyze, buffers, settings, summary, format text)
select public.get_stock_needs_page_v1(100, :last_offset, null, null, null, null, null, null, null);

explain (analyze, buffers, settings, summary, format text)
select public.get_stock_needs_page_v1(100, 0, 'MPN000000100', null, null, null, null, null, null);

-- Manager: all synthetic owners are in the same department and region.
reset role;
update public.profiles set role = 'manager'
where id = 'd7200000-0000-4000-8000-000000000000';
set local role authenticated;
explain (analyze, buffers, settings, summary, format text)
select public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);

-- Employee: only that employee's own upload is visible.
select set_config('request.jwt.claim.sub', 'd7200000-0000-4000-8000-000000000001', true);
explain (analyze, buffers, settings, summary, format text)
select public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);

select
  count(*) filter (where granted) as granted_locks,
  count(*) filter (where not granted) as waiting_locks
from pg_locks
where pid = pg_backend_pid();

reset role;
rollback;
