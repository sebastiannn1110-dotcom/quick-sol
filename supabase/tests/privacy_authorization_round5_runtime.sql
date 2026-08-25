\set ON_ERROR_STOP on

begin;

do $$
begin
  if current_database() !~ '^quiksol_privacy_round5_test(_[a-z0-9]+)?$' then
    raise exception 'REFUSING_NON_RONDA5_TEST_DATABASE';
  end if;
end;
$$;

insert into auth.users(id,email,raw_user_meta_data) values
  ('51000000-0000-4000-8000-000000000001','employee-a@example.invalid','{}'),
  ('51000000-0000-4000-8000-000000000002','employee-b@example.invalid','{}'),
  ('51000000-0000-4000-8000-000000000003','manager@example.invalid','{}'),
  ('51000000-0000-4000-8000-000000000004','admin@example.invalid','{}'),
  ('51000000-0000-4000-8000-000000000005','superadmin@example.invalid','{}'),
  ('51000000-0000-4000-8000-000000000006','outside@example.invalid','{}');

update public.profiles set role='employee',department='Sales',region='NA' where id in (
  '51000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000002'
);
update public.profiles set role='manager',department='Sales',region='NA' where id='51000000-0000-4000-8000-000000000003';
update public.profiles set role='admin',department='Operations',region='Global' where id='51000000-0000-4000-8000-000000000004';
update public.profiles set role='super_admin_dev',department='Engineering',region='Global' where id='51000000-0000-4000-8000-000000000005';
update public.profiles set role='employee',department='Finance',region='EU' where id='51000000-0000-4000-8000-000000000006';

insert into public.upload_batches(id,uploaded_by,original_file_name,status,detected_category) values
  ('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','synthetic-a.xlsx','completed','Inventory'),
  ('52000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000002','synthetic-b.xlsx','completed','Inventory'),
  ('52000000-0000-4000-8000-000000000006','51000000-0000-4000-8000-000000000006','synthetic-outside.xlsx','completed','Inventory');

insert into public.business_records(
  id,upload_batch_id,uploaded_by,category,raw_data,normalized_data,searchable_text,
  line_id,mpn,supplier,customer,po,cost,price,gp_rate,gp,commission,comments,qty
) values
  ('53000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','Inventory','{"private":"RAW-A"}','{"private":"NORMAL-A"}','SYN-A SUPPLIER-A CUSTOMER-A PO-A','LINE-A','SYN-A','SUPPLIER-A','CUSTOMER-A','PO-A',10,20,.5,10,1,'NOTE-A',5),
  ('53000000-0000-4000-8000-000000000002','52000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000002','Inventory','{"private":"RAW-B"}','{"private":"NORMAL-B"}','SYN-B SUPPLIER-B CUSTOMER-B PO-B','LINE-B','SYN-B','SUPPLIER-B','CUSTOMER-B','PO-B',11,21,.48,10,1,'NOTE-B',6),
  ('53000000-0000-4000-8000-000000000006','52000000-0000-4000-8000-000000000006','51000000-0000-4000-8000-000000000006','Inventory','{"private":"RAW-X"}','{"private":"NORMAL-X"}','SYN-X SUPPLIER-X CUSTOMER-X PO-X','LINE-X','SYN-X','SUPPLIER-X','CUSTOMER-X','PO-X',12,22,.45,10,1,'NOTE-X',7);

insert into public.import_errors(id,upload_batch_id,row_index,column_name,error_type,message,raw_value,severity) values
  ('54000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',1,'Synthetic','invalid_value','Synthetic safe summary','RAW-CELL-SECRET','low');

insert into public.business_mpn_summaries(
  upload_batch_id,owner_id,data_version,normalized_mpn,display_mpn,
  customer_name,supplier_name,manufacturer_name,stock_customer_name,stock_supplier_name,
  stock_manufacturer_name,demand_qty,stock_qty,stock_required_qty,stock_available_qty
) select
  '52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001',version.data_version,
  'SYNA','SYN-A','CUSTOMER-A','SUPPLIER-A','MFG-A','CUSTOMER-A','SUPPLIER-A','MFG-A',5,5,5,5
from public.business_upload_versions version
where version.upload_batch_id='52000000-0000-4000-8000-000000000001';

insert into public.business_opportunity_entities(
  upload_batch_id,owner_id,data_version,source_record_id,entity_kind,entity_key,
  normalized_mpn,display_mpn,manufacturer_name,customer_name,supplier_name,required_qty
) select
  '52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001',version.data_version,
  '53000000-0000-4000-8000-000000000001','demand','53000000-0000-4000-8000-000000000001:demand',
  'SYNA','SYN-A','MFG-A','CUSTOMER-A','SUPPLIER-A',5
from public.business_upload_versions version
where version.upload_batch_id='52000000-0000-4000-8000-000000000001';

update public.business_upload_versions
set summary_version=data_version, opportunity_entity_version=data_version, dirty=false
where upload_batch_id='52000000-0000-4000-8000-000000000001';

do $$
begin
  if has_table_privilege('authenticated','public.business_records','select') then raise exception 'AUTHENTICATED_RAW_RECORD_SELECT_PRESENT'; end if;
  if has_table_privilege('authenticated','public.import_errors','select') then raise exception 'AUTHENTICATED_RAW_ERROR_SELECT_PRESENT'; end if;
  if has_table_privilege('authenticated','public.business_mpn_summaries','select') then raise exception 'AUTHENTICATED_RAW_SUMMARY_SELECT_PRESENT'; end if;
  if has_table_privilege('authenticated','public.business_opportunity_entities','select') then raise exception 'AUTHENTICATED_RAW_ENTITY_SELECT_PRESENT'; end if;
  if not has_table_privilege('service_role','public.business_records','select') then raise exception 'SERVICE_RECORD_SELECT_MISSING'; end if;
  if not has_table_privilege('authenticated','public.business_records_safe_v1','select') then raise exception 'SAFE_VIEW_GRANT_MISSING'; end if;
  if not has_table_privilege('authenticated','public.business_mpn_summaries_safe_v1','select') then raise exception 'SAFE_SUMMARY_VIEW_GRANT_MISSING'; end if;
  if not has_table_privilege('authenticated','public.business_opportunity_entities_safe_v1','select') then raise exception 'SAFE_ENTITY_VIEW_GRANT_MISSING'; end if;
  if has_table_privilege('anon','public.business_records_safe_v1','select') then raise exception 'ANON_SAFE_VIEW_GRANT_PRESENT'; end if;
  if has_function_privilege('authenticated','public.search_executive_mpn_v1(text,integer,integer)','execute') then raise exception 'LEGACY_EXECUTIVE_GRANT_PRESENT'; end if;
  if has_function_privilege('service_role','public.search_executive_mpn_v1(text,integer,integer)','execute') then raise exception 'LEGACY_EXECUTIVE_SERVICE_GRANT_PRESENT'; end if;
  if not has_function_privilege('authenticated','public.search_executive_mpn_safe_v2(text,integer,integer)','execute') then raise exception 'SAFE_EXECUTIVE_GRANT_MISSING'; end if;
  if position('public.business_mpn_summaries_safe_v1' in pg_get_functiondef(to_regprocedure('public.get_stock_needs_page_v1(integer,integer,text,text,text,text,text,text,uuid)'))) = 0 then raise exception 'STOCK_RPC_SAFE_SOURCE_MISSING'; end if;
  if position('public.business_mpn_summaries_safe_v1' in pg_get_functiondef(to_regprocedure('public.get_sales_opportunities_page_v1(integer,integer,text,text,text,text,text,text,uuid,uuid)'))) = 0 then raise exception 'OPPORTUNITY_RPC_SAFE_SOURCE_MISSING'; end if;
  if position('public.business_mpn_summaries_safe_v1' in pg_get_functiondef(to_regprocedure('public.get_client_business_metrics_v1(uuid[])'))) = 0 then raise exception 'CLIENT_METRICS_SAFE_SOURCE_MISSING'; end if;
  if exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='public' and procedure.proname='search_executive_mpn_safe_v2'
      and coalesce(array_to_string(procedure.proargnames,','),'') ~ 'role'
  ) then raise exception 'CALLER_CONTROLLED_ROLE_PARAMETER'; end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);

-- Employee: own safe row only, no commercial contract and no raw base table.
select set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000001',true);
do $$
declare payload jsonb; rpc_payload jsonb; stock_payload jsonb; sales_payload jsonb;
begin
  begin
    perform raw_data from public.business_records limit 1;
    raise exception 'EMPLOYEE_RAW_TABLE_SELECT_SUCCEEDED';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.business_records_safe_v1) <> 1 then raise exception 'EMPLOYEE_ROW_SCOPE_FAILED'; end if;
  if (select count(*) from public.business_records_commercial_v1) <> 0 then raise exception 'EMPLOYEE_COMMERCIAL_VIEW_VISIBLE'; end if;
  select to_jsonb(record) into payload from public.business_records_safe_v1 record limit 1;
  if payload ?| array['raw_data','normalized_data','searchable_text','errors','supplier','customer','po','cost','price','gp_rate','gp','commission','comments'] then
    raise exception 'EMPLOYEE_SAFE_VIEW_LEAK';
  end if;
  begin
    perform price from public.business_records_safe_v1 limit 1;
    raise exception 'EMPLOYEE_EXPLICIT_PRICE_COLUMN_SUCCEEDED';
  exception when undefined_column then null;
  end;
  select result.records into rpc_payload from public.search_executive_mpn_safe_v2('SYN-A',10,0) result;
  if rpc_payload::text ~ 'SUPPLIER-A|CUSTOMER-A|PO-A|RAW-A' then raise exception 'EMPLOYEE_RPC_LEAK'; end if;
  select public.get_stock_needs_page_v1(50,0,null,null,null,null,null,null,null) into stock_payload;
  select public.get_sales_opportunities_page_v1(50,0,null,null,null,null,null,null,null,null) into sales_payload;
  if stock_payload::text ~ 'SUPPLIER-A|CUSTOMER-A|MFG-A' then raise exception 'EMPLOYEE_STOCK_RPC_PARTY_LEAK'; end if;
  if sales_payload::text ~ 'SUPPLIER-A|CUSTOMER-A|MFG-A' then raise exception 'EMPLOYEE_OPPORTUNITY_RPC_PARTY_LEAK'; end if;
  if (select count(*) from public.import_errors_safe_v1) <> 1 then raise exception 'EMPLOYEE_SAFE_ERRORS_SCOPE_FAILED'; end if;
  if (select to_jsonb(error_row) from public.import_errors_safe_v1 error_row limit 1) ? 'raw_value' then raise exception 'RAW_VALUE_LEAK'; end if;
  if (select message from public.import_errors_safe_v1 limit 1) ~ 'RAW-CELL-SECRET' then raise exception 'RAW_VALUE_IN_SAFE_MESSAGE'; end if;
  begin
    perform supplier_name from public.business_mpn_summaries limit 1;
    raise exception 'EMPLOYEE_RAW_SUMMARY_SELECT_SUCCEEDED';
  exception when insufficient_privilege then null;
  end;
  begin
    perform customer_name from public.business_opportunity_entities limit 1;
    raise exception 'EMPLOYEE_RAW_ENTITY_SELECT_SUCCEEDED';
  exception when insufficient_privilege then null;
  end;
  if exists(select 1 from public.business_mpn_summaries_safe_v1 where customer_name is not null or supplier_name is not null or manufacturer_name is not null) then
    raise exception 'EMPLOYEE_SAFE_SUMMARY_PARTY_LEAK';
  end if;
  if exists(select 1 from public.business_opportunity_entities_safe_v1 where customer_name is not null or supplier_name is not null or manufacturer_name is not null) then
    raise exception 'EMPLOYEE_SAFE_ENTITY_PARTY_LEAK';
  end if;
end;
$$;

-- Manager: current department/region scope, commercial parties visible,
-- financial/PO/notes values remain unavailable.
select set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000003',true);
do $$
declare visible_count bigint; outside_count bigint; leaked_count bigint; rpc_payload jsonb; sales_payload jsonb;
begin
  select count(*) into visible_count from public.business_records_commercial_v1;
  select count(*) into outside_count from public.business_records_commercial_v1 where mpn='SYN-X';
  select count(*) into leaked_count from public.business_records_commercial_v1
    where price is not null or cost is not null or gp is not null or gp_rate is not null
       or commission is not null or po is not null or comments is not null;
  if visible_count <> 2 or outside_count <> 0 then raise exception 'MANAGER_ROW_SCOPE_FAILED'; end if;
  if leaked_count <> 0 then raise exception 'MANAGER_FINANCIAL_LEAK'; end if;
  if not exists(select 1 from public.business_records_commercial_v1 where supplier='SUPPLIER-A' and customer='CUSTOMER-A') then
    raise exception 'MANAGER_ALLOWED_PARTY_FIELDS_MISSING';
  end if;
  if not exists(select 1 from public.business_mpn_summaries_safe_v1 where supplier_name='SUPPLIER-A' and customer_name='CUSTOMER-A') then
    raise exception 'MANAGER_SAFE_SUMMARY_PARTY_FIELDS_MISSING';
  end if;
  if not exists(select 1 from public.business_opportunity_entities_safe_v1 where supplier_name='SUPPLIER-A' and customer_name='CUSTOMER-A') then
    raise exception 'MANAGER_SAFE_ENTITY_PARTY_FIELDS_MISSING';
  end if;
  select result.records into rpc_payload from public.search_executive_mpn_safe_v2('SYN-A',10,0) result;
  if rpc_payload::text ~ 'PO-A|RAW-A|NOTE-A' then raise exception 'MANAGER_RPC_LEAK'; end if;
  select public.get_sales_opportunities_page_v1(50,0,null,null,null,null,null,null,null,null) into sales_payload;
  if sales_payload::text !~ 'SUPPLIER-A|CUSTOMER-A|MFG-A' then raise exception 'MANAGER_OPPORTUNITY_RPC_PARTY_FIELDS_MISSING'; end if;
end;
$$;

-- Admin and superadmin follow the currently explicit commercial-admin policy;
-- neither contract publishes raw source payloads.
select set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000004',true);
do $$
declare payload jsonb;
begin
  if (select count(*) from public.business_records_commercial_v1) <> 3 then raise exception 'ADMIN_SCOPE_FAILED'; end if;
  if not exists(select 1 from public.business_records_commercial_v1 where mpn='SYN-A' and price=20 and po='PO-A') then raise exception 'ADMIN_COMMERCIAL_FIELDS_MISSING'; end if;
  select to_jsonb(record) into payload from public.business_records_commercial_v1 record where mpn='SYN-A';
  if payload ?| array['raw_data','normalized_data','searchable_text','errors'] then raise exception 'ADMIN_RAW_LEAK'; end if;
end;
$$;

select set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000005',true);
do $$
begin
  if not exists(select 1 from public.business_records_commercial_v1 where mpn='SYN-A' and price=20) then raise exception 'SUPERADMIN_CURRENT_POLICY_REGRESSION'; end if;
end;
$$;

reset role;

do $$
begin
  if (select count(*) from public.business_records) <> 3 then raise exception 'FIXTURE_DATA_CHANGED'; end if;
  if (select count(*) from public.import_errors) <> 1 then raise exception 'FIXTURE_ERROR_DATA_CHANGED'; end if;
end;
$$;

rollback;
