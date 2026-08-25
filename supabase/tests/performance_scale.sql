\set ON_ERROR_STOP on
\timing on
begin;

insert into auth.users(id,email)
values ('31000000-0000-4000-8000-000000000003','scale@example.test');
insert into public.upload_batches(id,uploaded_by,original_file_name,status)
values ('31000000-0000-4000-8000-000000000033','31000000-0000-4000-8000-000000000003','scale.xlsx','completed');

alter table public.business_records disable trigger user;

\echo SCALE_10000
insert into public.business_records(id,upload_batch_id,uploaded_by,mpn,mpn_quoted,created_at)
select gen_random_uuid(),'31000000-0000-4000-8000-000000000033','31000000-0000-4000-8000-000000000003',
  'SCALE-' || n,'QUOTE-' || n,'2026-01-01'::timestamptz + n * interval '1 microsecond'
from generate_series(1,10000) n;
analyze public.business_records;
explain (analyze,buffers,format text)
select id,mpn,created_at from public.business_records
where archived_at is null order by created_at desc,id desc limit 25;

\echo SCALE_100000
insert into public.business_records(id,upload_batch_id,uploaded_by,mpn,mpn_quoted,created_at)
select gen_random_uuid(),'31000000-0000-4000-8000-000000000033','31000000-0000-4000-8000-000000000003',
  'SCALE-' || n,'QUOTE-' || n,'2026-01-01'::timestamptz + n * interval '1 microsecond'
from generate_series(10001,100000) n;
analyze public.business_records;
explain (analyze,buffers,format text)
select id,mpn,created_at from public.business_records
where archived_at is null order by created_at desc,id desc limit 25;

\echo SCALE_500000
insert into public.business_records(id,upload_batch_id,uploaded_by,mpn,mpn_quoted,created_at)
select gen_random_uuid(),'31000000-0000-4000-8000-000000000033','31000000-0000-4000-8000-000000000003',
  'SCALE-' || n,'QUOTE-' || n,'2026-01-01'::timestamptz + n * interval '1 microsecond'
from generate_series(100001,500000) n;
analyze public.business_records;
explain (analyze,buffers,format text)
select id,mpn,created_at from public.business_records
where archived_at is null order by created_at desc,id desc limit 25;

\echo SCALE_1000000
insert into public.business_records(id,upload_batch_id,uploaded_by,mpn,mpn_quoted,created_at)
select gen_random_uuid(),'31000000-0000-4000-8000-000000000033','31000000-0000-4000-8000-000000000003',
  'SCALE-' || n,'QUOTE-' || n,'2026-01-01'::timestamptz + n * interval '1 microsecond'
from generate_series(500001,1000000) n;
analyze public.business_records;
explain (analyze,buffers,format text)
select id,mpn,created_at from public.business_records
where archived_at is null order by created_at desc,id desc limit 25;

select count(*) rows, pg_size_pretty(pg_total_relation_size('public.business_records')) total_table_size,
  pg_size_pretty(pg_relation_size('public.business_records_active_keyset_idx')) keyset_index_size
from public.business_records;

rollback;
