-- Run only against a disposable local Supabase database after applying
-- 20260822130000_optimize_stock_needs_summary_fast_path.sql.
-- All synthetic writes and harness-only grants are rolled back.
\set ON_ERROR_STOP on
begin;

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

insert into auth.users (id, email)
values
  ('e4000000-0000-4000-8000-000000000001', 'stock-employee@example.invalid'),
  ('e4000000-0000-4000-8000-000000000002', 'stock-manager@example.invalid'),
  ('e4000000-0000-4000-8000-000000000003', 'stock-other@example.invalid'),
  ('e4000000-0000-4000-8000-000000000004', 'stock-admin@example.invalid'),
  ('e4000000-0000-4000-8000-000000000005', 'stock-superadmin@example.invalid');

update public.profiles set role = 'employee', department = 'North', region = 'East'
where id = 'e4000000-0000-4000-8000-000000000001';
update public.profiles set role = 'manager', department = 'North', region = 'West'
where id = 'e4000000-0000-4000-8000-000000000002';
update public.profiles set role = 'employee', department = 'South', region = 'South'
where id = 'e4000000-0000-4000-8000-000000000003';
update public.profiles set role = 'admin', department = 'HQ', region = 'Global'
where id = 'e4000000-0000-4000-8000-000000000004';
update public.profiles set role = 'super_admin_dev', department = 'HQ', region = 'Global'
where id = 'e4000000-0000-4000-8000-000000000005';

insert into public.upload_batches (
  id, uploaded_by, original_file_name, detected_category, status, created_at
)
values
  ('e4000000-0000-4000-8000-000000000011', 'e4000000-0000-4000-8000-000000000001', 'employee.xlsx', 'Inventory', 'completed', '2026-01-01'),
  ('e4000000-0000-4000-8000-000000000012', 'e4000000-0000-4000-8000-000000000002', 'manager.xlsx', 'Inventory', 'completed', '2026-01-02'),
  ('e4000000-0000-4000-8000-000000000013', 'e4000000-0000-4000-8000-000000000003', 'other.xlsx', 'Inventory', 'completed', '2026-01-03'),
  ('e4000000-0000-4000-8000-000000000014', 'e4000000-0000-4000-8000-000000000004', 'admin.xlsx', 'Inventory', 'completed', '2026-01-04'),
  ('e4000000-0000-4000-8000-000000000015', 'e4000000-0000-4000-8000-000000000005', 'super.xlsx', 'Inventory', 'completed', '2026-01-05');

update public.business_upload_versions
set summary_version = data_version, dirty = false
where upload_batch_id::text like 'e4000000-%';

insert into public.business_mpn_summaries (
  upload_batch_id, owner_id, data_version, normalized_mpn, display_mpn,
  stock_required_qty, stock_available_qty, stock_customer_name,
  stock_supplier_name, stock_manufacturer_name, source_record_count
)
select
  version.upload_batch_id,
  version.owner_id,
  version.data_version,
  case right(version.upload_batch_id::text, 2)
    when '11' then 'EMP-1'
    when '12' then 'MGR-1'
    when '13' then 'OTHER-1'
    when '14' then 'ADMIN-1'
    else 'SUPER-1'
  end,
  case right(version.upload_batch_id::text, 2)
    when '11' then 'EMP-1'
    when '12' then 'MGR-1'
    when '13' then 'OTHER-1'
    when '14' then 'ADMIN-1'
    else 'SUPER-1'
  end,
  10,
  case when right(version.upload_batch_id::text, 2) = '11' then 5 else 12 end,
  case when right(version.upload_batch_id::text, 2) in ('11', '12') then 'North Buyer' else 'Restricted Buyer' end,
  'Synthetic Supplier',
  'Synthetic Maker',
  1
from public.business_upload_versions version
where version.upload_batch_id::text like 'e4000000-%';

do $$
begin
  if has_function_privilege('anon', 'public.get_stock_needs_page_v1(integer,integer,text,text,text,text,text,text,uuid)', 'execute') then
    raise exception 'ANON_STOCK_RPC_EXECUTE_ALLOWED';
  end if;
  if not has_function_privilege('authenticated', 'public.get_stock_needs_page_v1(integer,integer,text,text,text,text,text,text,uuid)', 'execute') then
    raise exception 'AUTHENTICATED_STOCK_RPC_EXECUTE_MISSING';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

select set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000001', true);
do $$
declare result jsonb;
begin
  result := public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);
  if result #>> '{totals,totalItems}' <> '1'
     or result #>> '{items,0,mpn}' <> 'EMP-1'
     or result::text like '%MGR-1%'
     or result::text like '%OTHER-1%' then
    raise exception 'EMPLOYEE_STOCK_SCOPE_REGRESSION:%', result;
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000002', true);
do $$
declare result jsonb;
begin
  result := public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);
  if result #>> '{totals,totalItems}' <> '2'
     or result::text not like '%EMP-1%'
     or result::text not like '%MGR-1%'
     or result::text like '%OTHER-1%'
     or result::text like '%ADMIN-1%'
     or result::text like '%SUPER-1%' then
    raise exception 'MANAGER_STOCK_SCOPE_REGRESSION:%', result;
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000003', true);
do $$
declare result jsonb;
begin
  result := public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);
  if result #>> '{totals,totalItems}' <> '1'
     or result #>> '{items,0,mpn}' <> 'OTHER-1'
     or result::text like '%EMP-1%' then
    raise exception 'OTHER_EMPLOYEE_CROSS_SCOPE_REGRESSION:%', result;
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000004', true);
do $$
declare result jsonb; filtered jsonb;
begin
  result := public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);
  filtered := public.get_stock_needs_page_v1(1, 1, null, 'North Buyer', null, null, 'completed', null, null);
  if result #>> '{totals,totalItems}' <> '5'
     or result #>> '{summaryReady}' <> 'true'
     or filtered #>> '{totals,totalItems}' <> '2'
     or filtered #>> '{meta,returnedItems}' <> '1' then
    raise exception 'ADMIN_STOCK_CONTRACT_REGRESSION:%,%', result, filtered;
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', 'e4000000-0000-4000-8000-000000000005', true);
do $$
declare result jsonb;
begin
  result := public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);
  if result #>> '{totals,totalItems}' <> '5'
     or result #>> '{summaryReady}' <> 'true'
     or not public.is_admin()
     or not public.is_super_admin_dev() then
    raise exception 'SUPERADMIN_STOCK_INHERITANCE_REGRESSION:%', result;
  end if;
end;
$$;

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare result jsonb;
begin
  result := public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);
  if result #>> '{totals,totalItems}' <> '5' then
    raise exception 'SERVICE_ROLE_STOCK_REGRESSION:%', result;
  end if;
end;
$$;

reset role;
rollback;
