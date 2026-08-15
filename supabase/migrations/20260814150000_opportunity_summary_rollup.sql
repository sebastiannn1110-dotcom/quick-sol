-- Keep the global opportunity rollup inside the authenticated statement
-- timeout as summary volume grows. The covering order lets PostgreSQL group by
-- normalized MPN without sorting the wide materialized rows.
create index if not exists business_mpn_summaries_rollup_idx
  on public.business_mpn_summaries (normalized_mpn, upload_batch_id, data_version)
  include (demand_qty, stock_qty, excess_qty, approved_part_signal, received_signal);

create or replace function public.get_opportunity_summary_v1()
returns table(
  ready boolean, data_version bigint, total_opportunities bigint, immediate_sale bigint,
  partial_sale bigint, excess_resale bigint, sourcing_needed bigint,
  stock_without_demand bigint, approved_part_matches bigint, received_history_matches bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with visible_uploads as materialized (
    select upload.id, version.data_version, version.summary_version, version.dirty
    from public.upload_batches upload
    left join public.business_upload_versions version on version.upload_batch_id = upload.id
    where upload.archived_at is null
      and upload.status <> 'archived'
      and public.can_read_upload(upload.uploaded_by)
  ), readiness as (
    select not exists (
      select 1 from visible_uploads
      where dirty is distinct from false or summary_version is distinct from data_version
    ) ready, coalesce(max(data_version), 0)::bigint data_version
    from visible_uploads
  ), grouped as (
    select summary.normalized_mpn,
      coalesce(sum(summary.demand_qty), 0) demand_qty,
      coalesce(sum(summary.stock_qty), 0) stock_qty,
      coalesce(sum(summary.excess_qty), 0) excess_qty,
      bool_or(summary.approved_part_signal) approved,
      bool_or(summary.received_signal) received
    from public.business_mpn_summaries summary
    where exists (
      select 1 from visible_uploads visible
      where visible.id = summary.upload_batch_id
        and visible.summary_version = summary.data_version
    )
    group by summary.normalized_mpn
  ), classified as (
    select *,
      (demand_qty > 0 and stock_qty >= demand_qty)::int immediate,
      (demand_qty > 0 and stock_qty > 0 and stock_qty < demand_qty)::int partial,
      (demand_qty > 0 and excess_qty > 0)::int excess,
      (demand_qty > 0 and stock_qty <= 0 and excess_qty <= 0)::int sourcing,
      (demand_qty <= 0 and (stock_qty > 0 or excess_qty > 0))::int stock_only
    from grouped
  )
  select readiness.ready, readiness.data_version,
    coalesce(sum(immediate + partial + excess + sourcing + stock_only), 0)::bigint,
    coalesce(sum(immediate), 0)::bigint,
    coalesce(sum(partial), 0)::bigint,
    coalesce(sum(excess), 0)::bigint,
    coalesce(sum(sourcing), 0)::bigint,
    coalesce(sum(stock_only), 0)::bigint,
    coalesce(sum((immediate + partial + excess + sourcing + stock_only) * approved::int), 0)::bigint,
    coalesce(sum((immediate + partial + excess + sourcing + stock_only) * received::int), 0)::bigint
  from readiness
  left join classified on true
  group by readiness.ready, readiness.data_version;
$$;

revoke all on function public.get_opportunity_summary_v1() from public, anon;
grant execute on function public.get_opportunity_summary_v1() to authenticated, service_role;

comment on function public.get_opportunity_summary_v1() is
  'Exact visible-upload opportunity rollup with bounded authorization checks and covering-index grouping.';
