begin;

-- R5 hotfix: keep the explicit, role-masked read boundary while allowing the
-- existing active keyset index to drive ORDER BY created_at DESC, id DESC.
-- The materialized actor CTE in the original views forced PostgreSQL to scan
-- and sort the complete visible data set before applying LIMIT.
revoke select on table public.business_records from public, anon, authenticated;

create or replace view public.business_records_safe_v1
with (security_barrier = true)
as
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
left join public.profiles profile on profile.id = record.uploaded_by
left join public.upload_batches upload on upload.id = record.upload_batch_id
where record.archived_at is null
  and public.is_active_profile()
  and public.can_read_upload(record.uploaded_by)
order by record.created_at desc, record.id desc;

create or replace view public.business_records_commercial_v1
with (security_barrier = true)
as
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
  case when public.is_admin() then record.po else null end as po,
  record.qty,
  record.req_qty,
  case when public.is_admin() then record.cost else null end as cost,
  case when public.is_admin() then record.price else null end as price,
  case when public.is_admin() then record.total_price else null end as total_price,
  case when public.is_admin() then record.gp_rate else null end as gp_rate,
  case when public.is_admin() then record.gp else null end as gp,
  case when public.is_admin() then record.commission else null end as commission,
  case when public.is_admin() then record.potential_amount_usd else null end as potential_amount_usd,
  case when public.is_admin() then record.target_to_vendor else null end as target_to_vendor,
  case when public.is_admin() then record.best_price_offered else null end as best_price_offered,
  record.date_code,
  record.moq,
  record.spq,
  record.on_hand,
  record.lead_time_weeks,
  record.transit_time_weeks,
  record.earliest_shipping_date,
  record.shipping_point_country,
  record.delivery_point,
  case when public.is_admin() then record.comments else null end as comments,
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
left join public.profiles profile on profile.id = record.uploaded_by
left join public.upload_batches upload on upload.id = record.upload_batch_id
where record.archived_at is null
  and public.current_profile_role() in ('manager', 'admin', 'super_admin_dev')
  and public.can_read_upload(record.uploaded_by)
order by record.created_at desc, record.id desc;

revoke all on table public.business_records_safe_v1 from public, anon;
revoke all on table public.business_records_commercial_v1 from public, anon;
grant select on table public.business_records_safe_v1 to authenticated, service_role;
grant select on table public.business_records_commercial_v1 to authenticated, service_role;

comment on view public.business_records_safe_v1 is
  'R5 employee/AI-safe row-scoped contract with indexable keyset ordering. Raw and commercial columns are absent.';
comment on view public.business_records_commercial_v1 is
  'R5 manager/admin row-scoped contract with indexable keyset ordering. Manager finance, PO and notes remain null.';

commit;
