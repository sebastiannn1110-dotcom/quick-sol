-- Real two-connection claim race. Disposable Ronda 4 database only.
\set ON_ERROR_STOP on

do $$
begin
  if current_database() !~ '^quiksol_import_round4_test(_[a-z0-9]+)?$' then
    raise exception 'REFUSING_NON_RONDA4_TEST_DATABASE';
  end if;
end;
$$;

create extension if not exists dblink;
set request.jwt.claim.role='service_role';

insert into auth.users(id,email,raw_user_meta_data) values (
  '10000000-0000-4000-8000-000000000020','round4-race@example.invalid','{"full_name":"Synthetic Race"}'
);
select public.create_import_upload_v2(
  '10000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000020',
  '30000000-0000-4000-8000-000000000020','race.csv','text/csv',16,
  'Auto Detect','QA','LATAM','','standard','round4-race',3
);
insert into storage.objects(id,bucket_id,name,owner,metadata) values (
  '40000000-0000-4000-8000-000000000020','excel-uploads',
  '10000000-0000-4000-8000-000000000020/20000000-0000-4000-8000-000000000020/race.csv',
  '10000000-0000-4000-8000-000000000020','{"size":"16"}'
);
select public.finalize_import_upload_v2(
  '10000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000020',
  '30000000-0000-4000-8000-000000000020'
);

select dblink_connect(
  'round4_worker_a',
  format('host=127.0.0.1 port=%s dbname=%I user=%I options=''-c request.jwt.claim.role=service_role''',inet_server_port(),current_database(),current_user)
);
select dblink_connect(
  'round4_worker_b',
  format('host=127.0.0.1 port=%s dbname=%I user=%I options=''-c request.jwt.claim.role=service_role''',inet_server_port(),current_database(),current_user)
);

select dblink_send_query('round4_worker_a','select id from public.claim_import_job_v2(''race-worker-a'',120)');
select dblink_send_query('round4_worker_b','select id from public.claim_import_job_v2(''race-worker-b'',120)');

create temporary table round4_concurrent_claims(id uuid);
insert into round4_concurrent_claims select id from dblink_get_result('round4_worker_a') as result(id uuid);
insert into round4_concurrent_claims select id from dblink_get_result('round4_worker_b') as result(id uuid);

do $$
begin
  if (select count(*) from round4_concurrent_claims)<>1 then
    raise exception 'TWO_WORKER_CLAIM_RACE_FAILED: expected one claim';
  end if;
  if (select count(distinct id) from round4_concurrent_claims)<>1 then
    raise exception 'TWO_WORKER_CLAIM_RACE_DUPLICATED_JOB';
  end if;
end;
$$;

select dblink_disconnect('round4_worker_a');
select dblink_disconnect('round4_worker_b');
select 'ROUND4_TWO_WORKER_RACE_OK' as result;
