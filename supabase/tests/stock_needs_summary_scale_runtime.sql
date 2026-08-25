-- Disposable scale contract matching the production summary cardinality.
-- The optimized fast path must finish inside the authenticated 8s timeout.
\set ON_ERROR_STOP on
\timing on
begin;

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

insert into auth.users (id, email)
values ('e5000000-0000-4000-8000-000000000001', 'stock-scale-admin@example.invalid');
update public.profiles set role = 'admin'
where id = 'e5000000-0000-4000-8000-000000000001';

insert into public.upload_batches (
  id, uploaded_by, original_file_name, status, created_at
)
select
  ('e5000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'e5000000-0000-4000-8000-000000000001',
  format('stock-scale-%s.xlsx', series),
  'completed',
  '2026-01-01'::timestamptz + series * interval '1 minute'
from generate_series(11, 26) series;

update public.business_upload_versions
set summary_version = data_version, dirty = false
where owner_id = 'e5000000-0000-4000-8000-000000000001';

insert into public.business_mpn_summaries (
  upload_batch_id, owner_id, data_version, normalized_mpn, display_mpn,
  stock_required_qty, stock_available_qty, stock_customer_name,
  stock_supplier_name, stock_manufacturer_name, source_record_count
)
select
  version.upload_batch_id,
  version.owner_id,
  version.data_version,
  format('MPN-%s', part),
  format('MPN-%s', part),
  10,
  case when part % 3 = 0 then 0 else 12 end,
  'Synthetic Customer',
  'Synthetic Supplier',
  'Synthetic Maker',
  1
from public.business_upload_versions version
cross join generate_series(1, 10410) part
where version.owner_id = 'e5000000-0000-4000-8000-000000000001';

-- CREATE INDEX in the migration and normal production autovacuum both have
-- table statistics; make the disposable fixture equivalent before timing.
analyze public.business_mpn_summaries;
analyze public.upload_batches;
analyze public.business_upload_versions;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'e5000000-0000-4000-8000-000000000001', true);
set local statement_timeout = '8s';

do $$
declare
  unfiltered jsonb;
  filtered jsonb;
  paged jsonb;
begin
  unfiltered := public.get_stock_needs_page_v1(100, 0, null, null, null, null, null, null, null);
  filtered := public.get_stock_needs_page_v1(100, 0, null, 'Synthetic Customer', null, null, null, 'no_stock', null);
  paged := public.get_stock_needs_page_v1(25, 100, null, null, null, null, null, null, null);

  if unfiltered #>> '{totals,totalItems}' <> '10410'
     or unfiltered #>> '{meta,returnedItems}' <> '100'
     or unfiltered #>> '{summaryReady}' <> 'true' then
    raise exception 'STOCK_SCALE_UNFILTERED_REGRESSION';
  end if;
  if filtered #>> '{totals,totalItems}' <> '3470'
     or filtered #>> '{meta,returnedItems}' <> '100' then
    raise exception 'STOCK_SCALE_FILTER_REGRESSION';
  end if;
  if paged #>> '{meta,returnedItems}' <> '25' then
    raise exception 'STOCK_SCALE_PAGINATION_REGRESSION';
  end if;
end;
$$;

reset role;
rollback;
