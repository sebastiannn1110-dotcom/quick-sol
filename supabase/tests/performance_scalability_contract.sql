\set ON_ERROR_STOP on
begin;

do $$
declare relation_name text;
begin
  foreach relation_name in array array[
    'business_upload_versions',
    'business_scope_counters',
    'business_mpn_summaries',
    'observability_log_outbox'
  ] loop
    if not exists (
      select 1
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = relation_name
        and relation.relrowsecurity
        and relation.relforcerowsecurity
    ) then
      raise exception 'RLS/FORCE RLS missing:%', relation_name;
    end if;
  end loop;
end $$;

insert into auth.users(id,email) values
  ('10000000-0000-4000-8000-000000000001','perf-a@example.test'),
  ('20000000-0000-4000-8000-000000000002','perf-b@example.test');
update public.profiles set full_name='Perf A',role='employee',department='A',region='A'
where id='10000000-0000-4000-8000-000000000001';
update public.profiles set full_name='Perf B',role='employee',department='B',region='B'
where id='20000000-0000-4000-8000-000000000002';
insert into public.upload_batches(id,uploaded_by,original_file_name,status) values
  ('10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001','a.xlsx','completed');
insert into public.upload_batches(id,uploaded_by,original_file_name,status) values
  ('20000000-0000-4000-8000-000000000022','20000000-0000-4000-8000-000000000002','b.xlsx','completed');

insert into public.clients(id,name,created_by) values
  ('10000000-0000-4000-8000-000000000033','Performance Client','10000000-0000-4000-8000-000000000001');
insert into public.client_upload_assignments(client_id,upload_batch_id,assigned_by) values
  ('10000000-0000-4000-8000-000000000033','10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001');

insert into public.business_records(upload_batch_id,uploaded_by,mpn,has_errors,created_at) values
  ('10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001','ABC-1',false,'2026-01-01'),
  ('10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001',null,true,'2026-01-02'),
  ('20000000-0000-4000-8000-000000000022','20000000-0000-4000-8000-000000000002','SECRET-2',false,'2026-01-03');
update public.business_records set mpn='FIXED',has_errors=false
where upload_batch_id='10000000-0000-4000-8000-000000000011' and mpn is null;
do $$ declare counter record; begin
  select * into counter from public.business_scope_counters where owner_id='10000000-0000-4000-8000-000000000001';
  if counter.records_with_errors<>0 or counter.records_missing_mpn<>0 then raise exception 'counter_update_delta_failed'; end if;
end $$;
update public.business_records set mpn=null,has_errors=true
where upload_batch_id='10000000-0000-4000-8000-000000000011' and mpn='FIXED';

update public.business_upload_versions set summary_version=data_version,dirty=false where upload_batch_id in
  ('10000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000022');
insert into public.business_mpn_summaries(
  upload_batch_id,owner_id,data_version,normalized_mpn,display_mpn,demand_qty,stock_qty,
  stock_required_qty,stock_available_qty,source_record_count
)
select version.upload_batch_id,version.owner_id,version.data_version,
  case when version.owner_id='10000000-0000-4000-8000-000000000001' then 'ABC-1' else 'SECRET-2' end,
  case when version.owner_id='10000000-0000-4000-8000-000000000001' then 'ABC-1' else 'SECRET-2' end,
  4,10,4,10,1 from public.business_upload_versions version;

-- Supabase grants these schema privileges outside project migrations; the
-- standalone PostgreSQL harness reproduces them before exercising RLS.
grant select on public.upload_batches, public.file_schema_profiles, public.client_upload_assignments,
  public.business_records, public.profiles to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);

do $$
declare visible_count bigint; counter record; stock jsonb; opportunities jsonb; client_metrics record; mpn_search record;
begin
  select count(*) into visible_count from public.business_mpn_summaries;
  if visible_count <> 1 then raise exception 'cross_tenant_summary_leak:%', visible_count; end if;
  select * into counter from public.get_dashboard_summary_v1();
  if counter.total_records <> 2 or counter.records_with_errors <> 1 or counter.records_missing_mpn <> 1 then
    raise exception 'counter_mismatch:%', row_to_json(counter);
  end if;
  select public.get_stock_needs_page_v1(25,0,null,null,null,null,null,null,null) into stock;
  if (stock #>> '{totals,totalItems}')::int <> 1 or stock #>> '{items,0,coverageStatus}' <> 'overstock' then
    raise exception 'stock_summary_mismatch:%', stock;
  end if;
  select public.get_sales_opportunities_page_v1(25,0,null,null,null,null,null,null,null,null) into opportunities;
  if opportunities #>> '{items,0,opportunityType}' <> 'immediate_sale' then
    raise exception 'opportunity_summary_mismatch:%', opportunities;
  end if;
  select * into client_metrics
  from public.get_client_business_metrics_v1(array['10000000-0000-4000-8000-000000000033'::uuid]);
  if client_metrics.mpn_count <> 1 or client_metrics.immediate_sale_count <> 1 or not client_metrics.summary_ready then
    raise exception 'client_metrics_mismatch:%', row_to_json(client_metrics);
  end if;
  select * into mpn_search from public.search_executive_mpn_v1('abc-1', 25, 0);
  if mpn_search.total_count <> 1 or mpn_search.records #>> '{0,mpn}' <> 'ABC-1' then
    raise exception 'executive_mpn_search_mismatch:%', row_to_json(mpn_search);
  end if;
  if mpn_search.records::text like '%SECRET-2%' then
    raise exception 'executive_mpn_cross_tenant_leak';
  end if;
  if has_table_privilege('authenticated','public.observability_log_outbox','select') then
    raise exception 'outbox_must_not_be_readable';
  end if;
end $$;

select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
do $$
declare visible_count bigint;
begin
  select count(*) into visible_count
  from public.business_mpn_summaries
  where normalized_mpn = 'ABC-1';
  if visible_count <> 0 then
    raise exception 'user_b_can_read_user_a_summary:%', visible_count;
  end if;
end $$;

reset role;

insert into public.observability_log_outbox(event_key,payload)
values ('performance-force-rls-contract', '{"event_type":"contract"}'::jsonb);
set local role service_role;
do $$
declare claimed_count bigint;
begin
  select count(*) into claimed_count
  from public.claim_observability_log_outbox_v1('performance-contract-worker', 10);
  if claimed_count <> 1 then
    raise exception 'service_role_outbox_claim_failed:%', claimed_count;
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from pg_indexes where indexname='business_records_active_keyset_idx') then
    raise exception 'missing_keyset_index';
  end if;
  if not exists (select 1 from pg_indexes where indexname='business_records_active_mpn_trgm_idx') then
    raise exception 'missing_trigram_index';
  end if;
  if not exists (select 1 from pg_indexes where indexname='opportunity_finder_results_job_created_id_idx') then
    raise exception 'missing_opportunity_finder_index';
  end if;
end $$;

rollback;
