set statement_timeout = '8s';
set work_mem = '4MB';
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',false);
select set_config('request.jwt.claim.sub', :actor_id, false);
select public.get_stock_needs_snapshot_page_v1(
  100, 0, null, 'Concurrent Customer 42', null, null, null, null, null
);
reset role;
