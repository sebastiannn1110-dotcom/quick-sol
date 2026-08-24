begin;

-- Ronda 5: the raw tables remain the internal source of truth. Browser-facing
-- reads use explicit, security-barrier contracts whose row scope is derived
-- from auth.uid(); adding a future base-table column cannot publish it.
revoke select on table public.business_records from public, anon, authenticated;
revoke select on table public.import_errors from public, anon, authenticated;
revoke select on table public.business_mpn_summaries from public, anon, authenticated;
revoke select on table public.business_opportunity_entities from public, anon, authenticated;

create or replace view public.business_records_safe_v1
with (security_barrier = true)
as
with actor as materialized (
  select profile.id, profile.role, profile.department, profile.region
  from public.profiles profile
  where profile.id = auth.uid() and profile.is_active
)
select
  record.id,
  record.upload_batch_id,
  record.upload_sheet_id,
  record.uploaded_by,
  record.category,
  record.row_index,
  record.has_errors,
  record.created_at,
  record.archived_at,
  record.line_id,
  record.mpn,
  record.mpn_quoted,
  record.description,
  record.generic,
  record.qty,
  record.req_qty,
  record.date_code,
  record.moq,
  record.spq,
  record.on_hand,
  record.lead_time_weeks,
  record.transit_time_weeks,
  record.earliest_shipping_date,
  record.shipping_point_country,
  record.delivery_point,
  case when profile.id is null then null else jsonb_build_object(
    'full_name', profile.full_name,
    'department', profile.department,
    'region', profile.region,
    'role', profile.role
  ) end as profiles,
  case when upload.id is null then null else jsonb_build_object(
    'original_file_name', upload.original_file_name,
    'detected_category', upload.detected_category,
    'status', upload.status,
    'created_at', upload.created_at
  ) end as upload_batches
from public.business_records record
cross join actor
left join public.profiles profile on profile.id = record.uploaded_by
left join public.upload_batches upload on upload.id = record.upload_batch_id
where record.archived_at is null
  and (
    actor.role in ('admin', 'super_admin_dev')
    or record.uploaded_by = actor.id
    or (actor.role = 'manager' and exists (
      select 1 from public.profiles target
      where target.id = record.uploaded_by
        and (target.department = actor.department or target.region = actor.region)
    ))
  );

create or replace view public.business_records_commercial_v1
with (security_barrier = true)
as
with actor as materialized (
  select profile.id, profile.role, profile.department, profile.region
  from public.profiles profile
  where profile.id = auth.uid() and profile.is_active
)
select
  record.id,
  record.upload_batch_id,
  record.upload_sheet_id,
  record.uploaded_by,
  record.category,
  record.row_index,
  record.has_errors,
  record.created_at,
  record.archived_at,
  record.line_id,
  record.client,
  record.customer,
  record.supplier,
  record.supplier_name,
  record.mpn,
  record.mpn_quoted,
  record.manufacturer,
  record.clean_mfg,
  record.description,
  record.generic,
  case when actor.role in ('admin', 'super_admin_dev') then record.po else null end as po,
  record.qty,
  record.req_qty,
  case when actor.role in ('admin', 'super_admin_dev') then record.cost else null end as cost,
  case when actor.role in ('admin', 'super_admin_dev') then record.price else null end as price,
  case when actor.role in ('admin', 'super_admin_dev') then record.total_price else null end as total_price,
  case when actor.role in ('admin', 'super_admin_dev') then record.gp_rate else null end as gp_rate,
  case when actor.role in ('admin', 'super_admin_dev') then record.gp else null end as gp,
  case when actor.role in ('admin', 'super_admin_dev') then record.commission else null end as commission,
  case when actor.role in ('admin', 'super_admin_dev') then record.potential_amount_usd else null end as potential_amount_usd,
  case when actor.role in ('admin', 'super_admin_dev') then record.target_to_vendor else null end as target_to_vendor,
  case when actor.role in ('admin', 'super_admin_dev') then record.best_price_offered else null end as best_price_offered,
  record.date_code,
  record.moq,
  record.spq,
  record.on_hand,
  record.lead_time_weeks,
  record.transit_time_weeks,
  record.earliest_shipping_date,
  record.shipping_point_country,
  record.delivery_point,
  case when actor.role in ('admin', 'super_admin_dev') then record.comments else null end as comments,
  case when profile.id is null then null else jsonb_build_object(
    'full_name', profile.full_name,
    'department', profile.department,
    'region', profile.region,
    'role', profile.role
  ) end as profiles,
  case when upload.id is null then null else jsonb_build_object(
    'original_file_name', upload.original_file_name,
    'detected_category', upload.detected_category,
    'status', upload.status,
    'created_at', upload.created_at
  ) end as upload_batches
from public.business_records record
cross join actor
left join public.profiles profile on profile.id = record.uploaded_by
left join public.upload_batches upload on upload.id = record.upload_batch_id
where record.archived_at is null
  and actor.role in ('manager', 'admin', 'super_admin_dev')
  and (
    actor.role in ('admin', 'super_admin_dev')
    or record.uploaded_by = actor.id
    or (actor.role = 'manager' and exists (
      select 1 from public.profiles target
      where target.id = record.uploaded_by
        and (target.department = actor.department or target.region = actor.region)
    ))
  );

create or replace view public.import_errors_safe_v1
with (security_barrier = true)
as
with actor as materialized (
  select profile.id, profile.role, profile.department, profile.region
  from public.profiles profile
  where profile.id = auth.uid() and profile.is_active
)
select
  import_error.id,
  import_error.trace_id,
  import_error.upload_batch_id,
  import_error.upload_sheet_id,
  import_error.row_index,
  import_error.column_name,
  import_error.error_type,
  case
    when import_error.severity in ('critical', 'error') then 'A critical import validation issue occurred.'
    else 'An import validation issue occurred.'
  end as message,
  import_error.severity,
  import_error.created_at,
  case when upload.id is null then null else jsonb_build_object(
    'original_file_name', upload.original_file_name,
    'uploaded_by', upload.uploaded_by
  ) end as upload_batches,
  case when sheet.id is null then null else jsonb_build_object(
    'sheet_name', sheet.sheet_name
  ) end as upload_sheets
from public.import_errors import_error
cross join actor
join public.upload_batches upload on upload.id = import_error.upload_batch_id
left join public.upload_sheets sheet on sheet.id = import_error.upload_sheet_id
where actor.role in ('employee', 'manager', 'admin', 'super_admin_dev')
  and (
    actor.role in ('admin', 'super_admin_dev')
    or upload.uploaded_by = actor.id
    or (actor.role = 'manager' and exists (
      select 1 from public.profiles target
      where target.id = upload.uploaded_by
        and (target.department = actor.department or target.region = actor.region)
    ))
  );

create or replace view public.business_mpn_summaries_safe_v1
with (security_barrier = true)
as
with actor as materialized (
  select profile.id, profile.role, profile.department, profile.region
  from public.profiles profile
  where profile.id = auth.uid() and profile.is_active
)
select
  summary.upload_batch_id,
  summary.owner_id,
  summary.data_version,
  summary.normalized_mpn,
  summary.display_mpn,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then summary.customer_name else null end as customer_name,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then summary.supplier_name else null end as supplier_name,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then summary.manufacturer_name else null end as manufacturer_name,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then summary.manufacturer_names else '{}'::text[] end as manufacturer_names,
  summary.demand_qty,
  summary.stock_qty,
  summary.excess_qty,
  summary.received_qty,
  summary.stock_required_qty,
  summary.stock_available_qty,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then summary.stock_customer_name else null end as stock_customer_name,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then summary.stock_supplier_name else null end as stock_supplier_name,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then summary.stock_manufacturer_name else null end as stock_manufacturer_name,
  summary.required_date,
  summary.lead_time,
  summary.unit_of_measure,
  summary.approved_part_signal,
  summary.received_signal,
  summary.source_record_count,
  summary.warnings,
  summary.created_at
from public.business_mpn_summaries summary
cross join actor
where actor.role in ('employee', 'manager', 'admin', 'super_admin_dev')
  and (
    actor.role in ('admin', 'super_admin_dev')
    or summary.owner_id = actor.id
    or (actor.role = 'manager' and exists (
      select 1 from public.profiles target
      where target.id = summary.owner_id
        and (target.department = actor.department or target.region = actor.region)
    ))
  );

create or replace view public.business_opportunity_entities_safe_v1
with (security_barrier = true)
as
with actor as materialized (
  select profile.id, profile.role, profile.department, profile.region
  from public.profiles profile
  where profile.id = auth.uid() and profile.is_active
)
select
  entity.upload_batch_id,
  entity.owner_id,
  entity.data_version,
  entity.source_record_id,
  entity.entity_kind,
  entity.entity_key,
  entity.normalized_mpn,
  entity.display_mpn,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then entity.manufacturer_name else null end as manufacturer_name,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then entity.customer_name else null end as customer_name,
  case when actor.role in ('manager', 'admin', 'super_admin_dev') then entity.supplier_name else null end as supplier_name,
  entity.required_qty,
  entity.available_qty,
  entity.excess_qty,
  entity.required_date,
  entity.unit_of_measure,
  entity.lead_time_weeks,
  entity.moq,
  entity.spq,
  entity.date_code,
  entity.coo,
  entity.condition,
  entity.expires_at,
  entity.is_active_demand,
  entity.is_live_supply,
  entity.warnings,
  entity.created_at
from public.business_opportunity_entities entity
cross join actor
where actor.role in ('employee', 'manager', 'admin', 'super_admin_dev')
  and (
    actor.role in ('admin', 'super_admin_dev')
    or entity.owner_id = actor.id
    or (actor.role = 'manager' and exists (
      select 1 from public.profiles target
      where target.id = entity.owner_id
        and (target.department = actor.department or target.region = actor.region)
    ))
  );

revoke all on table public.business_records_safe_v1 from public, anon;
revoke all on table public.business_records_commercial_v1 from public, anon;
revoke all on table public.import_errors_safe_v1 from public, anon;
revoke all on table public.business_mpn_summaries_safe_v1 from public, anon;
revoke all on table public.business_opportunity_entities_safe_v1 from public, anon;
grant select on table public.business_records_safe_v1 to authenticated;
grant select on table public.business_records_commercial_v1 to authenticated;
grant select on table public.import_errors_safe_v1 to authenticated;
grant select on table public.business_mpn_summaries_safe_v1 to authenticated;
grant select on table public.business_opportunity_entities_safe_v1 to authenticated;
grant select on table public.business_records_safe_v1 to service_role;
grant select on table public.business_records_commercial_v1 to service_role;
grant select on table public.import_errors_safe_v1 to service_role;
grant select on table public.business_mpn_summaries_safe_v1 to service_role;
grant select on table public.business_opportunity_entities_safe_v1 to service_role;

-- Preserve the existing fast-path RPC signatures while moving their source to
-- the row-scoped, role-masked summary contract. The transformation is
-- deterministic and refuses to proceed if an expected deployed definition is
-- absent or no longer references the audited base table.
do $r5_contracts$
declare
  function_signature text;
  function_oid regprocedure;
  function_definition text;
begin
  foreach function_signature in array array[
    'public.get_stock_needs_page_v1(integer,integer,text,text,text,text,text,text,uuid)',
    'public.get_sales_opportunities_page_v1(integer,integer,text,text,text,text,text,text,uuid,uuid)',
    'public.get_client_business_metrics_v1(uuid[])'
  ] loop
    function_oid := to_regprocedure(function_signature);
    if function_oid is null then
      raise exception 'r5_expected_summary_rpc_missing:%', function_signature using errcode = '42883';
    end if;
    function_definition := pg_get_functiondef(function_oid);
    if position('public.business_mpn_summaries_safe_v1' in function_definition) > 0 then
      continue;
    end if;
    if position('public.business_mpn_summaries' in function_definition) = 0 then
      raise exception 'r5_expected_summary_source_missing:%', function_signature using errcode = '55000';
    end if;
    execute replace(
      function_definition,
      'public.business_mpn_summaries',
      'public.business_mpn_summaries_safe_v1'
    );
  end loop;
end;
$r5_contracts$;

-- The legacy executive RPC returned raw commercial columns to every
-- authenticated role. It is retained for migration compatibility but is no
-- longer executable through PostgREST.
revoke all on function public.search_executive_mpn_v1(text, integer, integer)
  from public, anon, authenticated, service_role;

create or replace function public.search_executive_mpn_safe_v2(
  p_mpn text,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table(records jsonb, total_count bigint)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with actor as (
    select public.current_profile_role() as role
  ), candidates as (
    select to_jsonb(record) as payload,
      record.id,
      record.created_at,
      case
        when public.normalize_business_mpn_v1(coalesce(record.mpn, '')) = public.normalize_business_mpn_v1(p_mpn)
          or public.normalize_business_mpn_v1(coalesce(record.mpn_quoted, '')) = public.normalize_business_mpn_v1(p_mpn) then 0
        when public.normalize_business_mpn_v1(coalesce(record.mpn, '')) like public.normalize_business_mpn_v1(p_mpn) || '%'
          or public.normalize_business_mpn_v1(coalesce(record.mpn_quoted, '')) like public.normalize_business_mpn_v1(p_mpn) || '%' then 1
        else 2
      end as match_rank
    from public.business_records_safe_v1 record
    cross join actor
    where actor.role = 'employee'
      and public.normalize_business_mpn_v1(p_mpn) <> ''
      and (
        public.normalize_business_mpn_v1(coalesce(record.mpn, '')) like '%' || public.normalize_business_mpn_v1(p_mpn) || '%'
        or public.normalize_business_mpn_v1(coalesce(record.mpn_quoted, '')) like '%' || public.normalize_business_mpn_v1(p_mpn) || '%'
      )
    union all
    select to_jsonb(record) as payload,
      record.id,
      record.created_at,
      case
        when public.normalize_business_mpn_v1(coalesce(record.mpn, '')) = public.normalize_business_mpn_v1(p_mpn)
          or public.normalize_business_mpn_v1(coalesce(record.mpn_quoted, '')) = public.normalize_business_mpn_v1(p_mpn) then 0
        when public.normalize_business_mpn_v1(coalesce(record.mpn, '')) like public.normalize_business_mpn_v1(p_mpn) || '%'
          or public.normalize_business_mpn_v1(coalesce(record.mpn_quoted, '')) like public.normalize_business_mpn_v1(p_mpn) || '%' then 1
        else 2
      end as match_rank
    from public.business_records_commercial_v1 record
    cross join actor
    where actor.role in ('manager', 'admin', 'super_admin_dev')
      and public.normalize_business_mpn_v1(p_mpn) <> ''
      and (
        public.normalize_business_mpn_v1(coalesce(record.mpn, '')) like '%' || public.normalize_business_mpn_v1(p_mpn) || '%'
        or public.normalize_business_mpn_v1(coalesce(record.mpn_quoted, '')) like '%' || public.normalize_business_mpn_v1(p_mpn) || '%'
      )
  ), page as (
    select *
    from candidates
    order by match_rank, created_at desc, id desc
    limit least(greatest(p_limit, 1), 100)
    offset greatest(p_offset, 0)
  )
  select
    coalesce((select jsonb_agg(page.payload order by page.match_rank, page.created_at desc, page.id desc) from page), '[]'::jsonb),
    (select count(*) from candidates)::bigint;
$$;

revoke all on function public.search_executive_mpn_safe_v2(text, integer, integer)
  from public, anon;
grant execute on function public.search_executive_mpn_safe_v2(text, integer, integer)
  to authenticated, service_role;

comment on view public.business_records_safe_v1 is
  'R5 employee-safe, row-scoped business-record contract. Raw and commercial columns are absent.';
comment on view public.business_records_commercial_v1 is
  'R5 manager/admin row-scoped contract. Manager financial values remain null; raw columns are absent.';
comment on view public.import_errors_safe_v1 is
  'R5 row-scoped import-error contract without raw_value or business_record_id.';
comment on view public.business_mpn_summaries_safe_v1 is
  'R5 row-scoped derived-summary contract. Employee party names are masked.';
comment on view public.business_opportunity_entities_safe_v1 is
  'R5 row-scoped Opportunity Finder source contract. Employee party names are masked.';
comment on function public.search_executive_mpn_safe_v2(text, integer, integer) is
  'R5 role-derived, row-scoped executive MPN search over explicit safe views.';

commit;
