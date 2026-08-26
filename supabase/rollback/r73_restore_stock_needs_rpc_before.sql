-- R7.3 rollback: restore the exact PRE-R7.3 get_stock_needs_page_v1 catalog
-- definition verified against the linked remote database on 2026-08-26.
--
-- This changes only the function definition, owner, comment and EXECUTE ACL.
-- It does not modify data, tables, indexes, views, jobs or watermarks.

begin;

create or replace function public.get_stock_needs_page_v1(
  p_limit integer default 50,
  p_offset integer default 0,
  p_q text default null,
  p_customer text default null,
  p_supplier text default null,
  p_manufacturer text default null,
  p_status text default null,
  p_coverage text default null,
  p_upload_batch_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
with visible_uploads as materialized (
  select
    upload.id as upload_batch_id,
    upload.original_file_name,
    upload.detected_category,
    upload.status as import_status,
    upload.created_at as upload_created_at,
    version.data_version,
    version.summary_version,
    version.dirty,
    profile.detected_template,
    profile.upload_batch_id is null as missing_profile
  from public.upload_batches upload left join public.business_upload_versions version on version.upload_batch_id = upload.id
  left join public.file_schema_profiles profile
    on profile.upload_batch_id = upload.id
  where upload.archived_at is null
    and upload.status in ('completed', 'completed_with_warnings')
    and (p_upload_batch_id is null or upload.id = p_upload_batch_id)
    and (
      auth.role() = 'service_role'
      or public.can_read_upload(upload.uploaded_by)
    )
), readiness as (
  select not exists (
    select 1
    from visible_uploads visible
    where visible.data_version is null or visible.dirty is distinct from false or visible.summary_version is distinct from visible.data_version
  ) as summary_ready
), grouped as (
  select
    summary.normalized_mpn,
    min(summary.display_mpn) as display_mpn,
    (
      array_agg(
        summary.stock_customer_name
        order by visible.upload_created_at desc, visible.upload_batch_id desc
      ) filter (where summary.stock_customer_name is not null)
    )[1] as customer_name,
    (
      array_agg(
        summary.stock_supplier_name
        order by visible.upload_created_at desc, visible.upload_batch_id desc
      ) filter (where summary.stock_supplier_name is not null)
    )[1] as supplier_name,
    (
      array_agg(
        summary.stock_manufacturer_name
        order by visible.upload_created_at desc, visible.upload_batch_id desc
      ) filter (where summary.stock_manufacturer_name is not null)
    )[1] as manufacturer_name,
    nullif(sum(summary.stock_required_qty), 0) as demand_qty,
    nullif(sum(summary.stock_available_qty), 0) as stock_qty,
    (
      array_agg(
        summary.required_date
        order by visible.upload_created_at desc, visible.upload_batch_id desc
      ) filter (where summary.required_date is not null)
    )[1] as required_date,
    (
      array_agg(
        summary.lead_time
        order by visible.upload_created_at desc, visible.upload_batch_id desc
      ) filter (where summary.lead_time is not null)
    )[1] as lead_time,
    bool_or(visible.missing_profile) as missing_profile,
    bool_or(p_status is not null and visible.import_status = p_status) as status_match
  from public.business_mpn_summaries_safe_v1 summary
  join visible_uploads visible
    on visible.upload_batch_id = summary.upload_batch_id
   and visible.summary_version = summary.data_version
   and not visible.dirty
  group by summary.normalized_mpn
), classified as (
  select
    grouped.*,
    greatest(coalesce(demand_qty, 0) - coalesce(stock_qty, 0), 0) as shortage_qty,
    case
      when demand_qty is null and coalesce(stock_qty, 0) > 0 then 'overstock'
      when demand_qty is null then 'unknown'
      when coalesce(stock_qty, 0) <= 0 then 'no_stock'
      when stock_qty < demand_qty then 'partial_stock'
      when stock_qty > demand_qty then 'overstock'
      else 'in_stock'
    end as coverage_status
  from grouped
), filtered as (
  select classified.*
  from classified
  where (
      p_q is null
      or classified.normalized_mpn like '%' || public.normalize_business_mpn_v1(p_q) || '%'
    )
    and (p_customer is null or classified.customer_name ilike '%' || p_customer || '%')
    and case
      when p_supplier is not null
       and p_manufacturer is not null
       and p_supplier = p_manufacturer
      then coalesce(classified.supplier_name ilike '%' || p_supplier || '%', false)
        or coalesce(classified.manufacturer_name ilike '%' || p_manufacturer || '%', false)
      else (p_supplier is null or classified.supplier_name ilike '%' || p_supplier || '%')
        and (p_manufacturer is null or classified.manufacturer_name ilike '%' || p_manufacturer || '%')
    end
    and (p_status is null or classified.status_match)
    and (p_coverage is null or classified.coverage_status = p_coverage)
), totals as (
  select
    count(*) as total_items,
    count(*) filter (where coverage_status = 'in_stock') as in_stock,
    count(*) filter (where coverage_status = 'partial_stock') as partial_stock,
    count(*) filter (where coverage_status = 'no_stock') as no_stock,
    count(*) filter (where coverage_status = 'overstock') as overstock,
    count(*) filter (where coverage_status = 'unknown') as unknown,
    coalesce(sum(demand_qty), 0) as total_required_qty,
    coalesce(sum(stock_qty), 0) as total_stock_qty
  from filtered
), page as materialized (
  select
    filtered.*,
    case coverage_status
      when 'no_stock' then 0
      when 'partial_stock' then 1
      when 'unknown' then 2
      when 'in_stock' then 3
      else 4
    end as sort_rank
  from filtered
  order by sort_rank, normalized_mpn
  limit least(greatest(p_limit, 1), 200)
  offset greatest(p_offset, 0)
), page_sources as (
  select
    page.normalized_mpn,
    to_jsonb((
      array_agg(
        jsonb_build_object(
          'uploadBatchId', visible.upload_batch_id,
          'fileName', visible.original_file_name,
          'detectedTemplate', coalesce(visible.detected_template, visible.detected_category),
          'importStatus', visible.import_status
        )
        order by visible.upload_created_at desc, visible.upload_batch_id desc
      )
    )[1:5]) as source_uploads
  from page
  join public.business_mpn_summaries_safe_v1 summary
    on summary.normalized_mpn = page.normalized_mpn
  join visible_uploads visible
    on visible.upload_batch_id = summary.upload_batch_id
   and visible.summary_version = summary.data_version
   and not visible.dirty
  group by page.normalized_mpn
)
select jsonb_build_object(
  'items', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'mpn', page.display_mpn,
        'customerName', page.customer_name,
        'manufacturerName', page.manufacturer_name,
        'supplierName', page.supplier_name,
        'requiredQty', page.demand_qty,
        'stockQty', page.stock_qty,
        'availableQty', page.stock_qty,
        'shortageQty', page.shortage_qty,
        'coverageStatus', page.coverage_status,
        'requiredDate', page.required_date,
        'leadTime', page.lead_time,
        'sourceUploads', coalesce(page_sources.source_uploads, '[]'::jsonb),
        'warnings', '[]'::jsonb
      )
      order by page.sort_rank, page.normalized_mpn
    )
    from page
    left join page_sources using (normalized_mpn)
  ), '[]'::jsonb),
  'totals', (
    select jsonb_build_object(
      'totalItems', total_items,
      'inStock', in_stock,
      'partialStock', partial_stock,
      'noStock', no_stock,
      'overstock', overstock,
      'unknown', unknown,
      'totalRequiredQty', total_required_qty,
      'totalStockQty', total_stock_qty
    )
    from totals
  ),
  'meta', jsonb_build_object(
    'limit', least(greatest(p_limit, 1), 200),
    'offset', greatest(p_offset, 0),
    'returnedItems', (select count(*) from page),
    'scannedRecords', 0,
    'missingProfileCount', 0,
    'missingProfileUploadIds', '[]'::jsonb,
    'hasMissingProfiles', coalesce((select bool_or(missing_profile) from filtered), false)
  ),
  'summaryReady', (select summary_ready from readiness)
);
$$;

alter function public.get_stock_needs_page_v1(
  integer, integer, text, text, text, text, text, text, uuid
) owner to postgres;

revoke all on function public.get_stock_needs_page_v1(
  integer, integer, text, text, text, text, text, text, uuid
) from public, anon;

grant execute on function public.get_stock_needs_page_v1(
  integer, integer, text, text, text, text, text, text, uuid
) to authenticated, service_role;

comment on function public.get_stock_needs_page_v1(
  integer, integer, text, text, text, text, text, text, uuid
) is
  'Exact role-scoped Stock Needs rollup; authorization is bounded by visible uploads and source JSON is page-only.';

commit;
