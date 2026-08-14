\set ON_ERROR_STOP on
\timing on
begin;

-- Isolated synthetic evidence: no application table or index is removed.
create temporary table performance_business_records (
  id uuid primary key,
  mpn text,
  created_at timestamptz not null,
  archived_at timestamptz
);

insert into performance_business_records(id,mpn,created_at)
select gen_random_uuid(),
  case when n % 1000 = 0 then 'NEEDLE-' || n else 'PART-' || n end,
  '2026-01-01'::timestamptz + n * interval '1 microsecond'
from generate_series(1,100000) n;
analyze performance_business_records;

\echo BEFORE_KEYSET
explain (analyze,buffers,format text)
select id,mpn,created_at from performance_business_records
where archived_at is null order by created_at desc,id desc limit 25;

\echo BEFORE_TRIGRAM
explain (analyze,buffers,format text)
select count(*) from performance_business_records
where archived_at is null and mpn ilike '%NEEDLE%';

create index performance_business_records_keyset_idx
  on performance_business_records(created_at desc,id desc)
  where archived_at is null;
create index performance_business_records_mpn_trgm_idx
  on performance_business_records using gin(mpn gin_trgm_ops)
  where archived_at is null and mpn is not null;
analyze performance_business_records;

\echo AFTER_KEYSET
explain (analyze,buffers,format text)
select id,mpn,created_at from performance_business_records
where archived_at is null order by created_at desc,id desc limit 25;

\echo AFTER_TRIGRAM
explain (analyze,buffers,format text)
select count(*) from performance_business_records
where archived_at is null and mpn ilike '%NEEDLE%';

select indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) size
from pg_stat_user_indexes
where indexrelname in ('performance_business_records_keyset_idx','performance_business_records_mpn_trgm_idx')
order by indexrelname;

rollback;
