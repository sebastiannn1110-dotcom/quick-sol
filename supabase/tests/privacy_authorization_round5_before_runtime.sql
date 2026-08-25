\set ON_ERROR_STOP on

begin;

do $$
begin
  if current_database() !~ '^quiksol_privacy_round5_test_before[0-9]*$' then
    raise exception 'REFUSING_NON_RONDA5_BEFORE_TEST_DATABASE';
  end if;
end;
$$;

insert into auth.users(id,email,raw_user_meta_data) values
  ('61000000-0000-4000-8000-000000000001','employee-before@example.invalid','{}'),
  ('61000000-0000-4000-8000-000000000002','manager-before@example.invalid','{}'),
  ('61000000-0000-4000-8000-000000000003','admin-before@example.invalid','{}'),
  ('61000000-0000-4000-8000-000000000004','superadmin-before@example.invalid','{}'),
  ('61000000-0000-4000-8000-000000000005','outside-before@example.invalid','{}');

update public.profiles set role='employee',department='Sales',region='NA' where id='61000000-0000-4000-8000-000000000001';
update public.profiles set role='manager',department='Sales',region='NA' where id='61000000-0000-4000-8000-000000000002';
update public.profiles set role='admin',department='Operations',region='Global' where id='61000000-0000-4000-8000-000000000003';
update public.profiles set role='super_admin_dev',department='Engineering',region='Global' where id='61000000-0000-4000-8000-000000000004';
update public.profiles set role='employee',department='Finance',region='EU' where id='61000000-0000-4000-8000-000000000005';

insert into public.upload_batches(id,uploaded_by,original_file_name,status,detected_category) values
  ('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','synthetic-before-a.xlsx','completed','Inventory'),
  ('62000000-0000-4000-8000-000000000005','61000000-0000-4000-8000-000000000005','synthetic-before-b.xlsx','completed','Inventory');

insert into public.business_records(
  id,upload_batch_id,uploaded_by,category,raw_data,normalized_data,searchable_text,
  mpn,supplier,customer,po,cost,price,gp_rate,gp,commission,comments,qty
) values
  ('63000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','Inventory','{"private":"RAW-BEFORE-A"}','{"private":"NORMAL-BEFORE-A"}','SYN-BEFORE-A','SYN-BEFORE-A','SUPPLIER-BEFORE-A','CUSTOMER-BEFORE-A','PO-BEFORE-A',10,20,.5,10,1,'NOTE-BEFORE-A',5),
  ('63000000-0000-4000-8000-000000000005','62000000-0000-4000-8000-000000000005','61000000-0000-4000-8000-000000000005','Inventory','{"private":"RAW-BEFORE-X"}','{"private":"NORMAL-BEFORE-X"}','SYN-BEFORE-X','SYN-BEFORE-X','SUPPLIER-BEFORE-X','CUSTOMER-BEFORE-X','PO-BEFORE-X',11,21,.4,9,1,'NOTE-BEFORE-X',6);

insert into public.business_mpn_summaries(
  upload_batch_id,owner_id,data_version,normalized_mpn,display_mpn,
  customer_name,supplier_name,manufacturer_name,demand_qty,stock_qty
) select
  '62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001',version.data_version,
  'SYNBEFOREA','SYN-BEFORE-A','CUSTOMER-BEFORE-A','SUPPLIER-BEFORE-A','MFG-BEFORE-A',5,5
from public.business_upload_versions version
where version.upload_batch_id='62000000-0000-4000-8000-000000000001';

insert into public.business_opportunity_entities(
  upload_batch_id,owner_id,data_version,source_record_id,entity_kind,entity_key,
  normalized_mpn,display_mpn,manufacturer_name,customer_name,supplier_name,required_qty
) select
  '62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001',version.data_version,
  '63000000-0000-4000-8000-000000000001','demand','63000000-0000-4000-8000-000000000001:demand',
  'SYNBEFOREA','SYN-BEFORE-A','MFG-BEFORE-A','CUSTOMER-BEFORE-A','SUPPLIER-BEFORE-A',5
from public.business_upload_versions version
where version.upload_batch_id='62000000-0000-4000-8000-000000000001';

update public.business_upload_versions
set summary_version=data_version, opportunity_entity_version=data_version, dirty=false
where upload_batch_id='62000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);

select set_config('request.jwt.claim.sub','61000000-0000-4000-8000-000000000001',true);
do $$
declare payload jsonb;
begin
  select to_jsonb(record) into payload from public.business_records record limit 1;
  if not payload ?& array['raw_data','normalized_data','cost','price','gp_rate','gp','commission','po','supplier','customer','comments'] then
    raise exception 'BEFORE_EMPLOYEE_FULL_ROW_NOT_REPRODUCED';
  end if;
  if (select raw_data->>'private' from public.business_records limit 1) <> 'RAW-BEFORE-A' then
    raise exception 'BEFORE_EMPLOYEE_EXPLICIT_RAW_COLUMN_NOT_REPRODUCED';
  end if;
  if not exists(select 1 from public.business_mpn_summaries where supplier_name='SUPPLIER-BEFORE-A') then
    raise exception 'BEFORE_EMPLOYEE_SUMMARY_LEAK_NOT_REPRODUCED';
  end if;
  if not exists(select 1 from public.business_opportunity_entities where customer_name='CUSTOMER-BEFORE-A') then
    raise exception 'BEFORE_EMPLOYEE_ENTITY_LEAK_NOT_REPRODUCED';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub','61000000-0000-4000-8000-000000000002',true);
do $$
begin
  if not exists(select 1 from public.business_records where mpn='SYN-BEFORE-A' and price=20 and po='PO-BEFORE-A') then
    raise exception 'BEFORE_MANAGER_COMMERCIAL_LEAK_NOT_REPRODUCED';
  end if;
  if exists(select 1 from public.business_records where mpn='SYN-BEFORE-X') then
    raise exception 'BEFORE_MANAGER_ROW_SCOPE_REGRESSION';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub','61000000-0000-4000-8000-000000000003',true);
do $$
begin
  if (select count(*) from public.business_records where raw_data is not null and price is not null) <> 2 then
    raise exception 'BEFORE_ADMIN_POLICY_NOT_REPRODUCED';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub','61000000-0000-4000-8000-000000000004',true);
do $$
begin
  if (select count(*) from public.business_records where raw_data is not null and price is not null) <> 2 then
    raise exception 'BEFORE_SUPERADMIN_POLICY_NOT_REPRODUCED';
  end if;
end;
$$;

reset role;
select 'ROUND5_BEFORE_DIRECT_BYPASS_REPRODUCED' as result;

rollback;
