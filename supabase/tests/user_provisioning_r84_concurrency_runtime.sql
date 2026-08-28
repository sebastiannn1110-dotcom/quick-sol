-- Real two-connection R8.4 proof. The database, GUC and local dblink sessions
-- are mandatory; no mocked Promise is used for a database concurrency claim.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r83_user_provisioning_test'
     or current_setting('quiksol.allow_r83_user_provisioning_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_R83_USER_PROVISIONING_TEST_DATABASE';
  end if;
  if public.user_provisioning_intent_required_v1() is distinct from true then
    raise exception 'R84_REQUIRES_R83B_GATE';
  end if;
end;
$$;

-- A dedicated effective actor makes this proof independent from the sequential
-- runtime file. Trigger bypass is fixture-only and restored immediately.
set session_replication_role = replica;

insert into auth.users (
  id, email, email_confirmed_at, banned_until, raw_app_meta_data, raw_user_meta_data
) values (
  '84000000-0000-4000-8000-000000000002',
  'r84_concurrency_actor@example.invalid',
  pg_catalog.now(),
  null,
  '{}'::jsonb,
  '{"full_name":"R84 Concurrency Actor"}'::jsonb
)
on conflict (id) do nothing;

insert into public.profiles (
  id, full_name, email, role, department, region, is_active
) values (
  '84000000-0000-4000-8000-000000000002',
  'R84 Concurrency Actor',
  'r84_concurrency_actor@example.invalid',
  'super_admin_dev',
  'Security',
  'Disposable',
  true
)
on conflict (id) do nothing;

set session_replication_role = origin;

create extension if not exists dblink;
drop schema if exists r84_concurrency_test cascade;
create schema r84_concurrency_test;

create table r84_concurrency_test.attempt_results (
  scenario text not null,
  iteration integer not null,
  contender text not null check (contender in ('A', 'B')),
  result_status text not null,
  state text,
  sqlstate text,
  intent_id uuid,
  auth_user_id uuid,
  attempt_count integer,
  backend_pid integer not null,
  transaction_id text not null,
  elapsed_ms numeric not null,
  primary key (scenario, iteration, contender)
);

create table r84_concurrency_test.iteration_results (
  scenario text not null,
  iteration integer not null,
  intent_rows integer not null,
  minimum_attempt_count integer,
  maximum_attempt_count integer,
  auth_rows integer not null default 0,
  profile_rows integer not null default 0,
  completion_audits integer not null default 0,
  primary key (scenario, iteration)
);

create table r84_concurrency_test.auth_race_results (
  iteration integer not null,
  contender text not null check (contender in ('A', 'B')),
  result_status text not null,
  sqlstate text,
  requested_user_id uuid not null,
  backend_pid integer not null,
  transaction_id text not null,
  elapsed_ms numeric not null,
  primary key (iteration, contender)
);

create table r84_concurrency_test.recovery_results (
  iteration integer not null,
  contender text not null check (contender in ('A', 'B')),
  state text not null,
  intent_id uuid not null,
  auth_user_id uuid not null,
  attempt_count integer not null,
  backend_pid integer not null,
  transaction_id text not null,
  elapsed_ms numeric not null,
  primary key (iteration, contender)
);

create or replace function r84_concurrency_test.begin_attempt(
  input_idempotency_key uuid,
  input_email text,
  input_full_name text,
  input_role text,
  input_barrier_key bigint default null
)
returns jsonb
language plpgsql
volatile
set search_path = pg_catalog, public, r84_concurrency_test
as $$
declare
  started_at timestamptz := pg_catalog.clock_timestamp();
  transaction_id text := pg_catalog.pg_current_xact_id()::text;
  response jsonb;
  error_state text;
  result_status text;
begin
  begin
    if input_barrier_key is not null then
      perform pg_catalog.pg_advisory_xact_lock_shared(input_barrier_key);
    end if;
    perform pg_catalog.set_config('lock_timeout', '3000ms', true);

    response := public.begin_user_provisioning_v2(
      input_idempotency_key,
      input_email,
      input_full_name,
      input_role,
      'Concurrency',
      'Disposable',
      true,
      null,
      null
    );

    return pg_catalog.jsonb_build_object(
      'resultStatus', 'success',
      'state', response->>'state',
      'sqlstate', null,
      'intentId', response->>'intent_id',
      'authUserId', response->>'auth_user_id',
      'attemptCount', response->>'attempt_count',
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'elapsedMs', extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  exception when query_canceled then
    return pg_catalog.jsonb_build_object(
      'resultStatus', 'timeout',
      'state', null,
      'sqlstate', sqlstate,
      'intentId', null,
      'authUserId', null,
      'attemptCount', null,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'elapsedMs', extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  when others then
    error_state := sqlstate;
    result_status := case
      when error_state in ('QS841', 'QS843') then 'expected_conflict'
      when error_state = '40P01' then 'deadlock'
      when error_state in ('55P03', '57014') then 'timeout'
      else 'error'
    end;

    return pg_catalog.jsonb_build_object(
      'resultStatus', result_status,
      'state', null,
      'sqlstate', error_state,
      'intentId', null,
      'authUserId', null,
      'attemptCount', null,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'elapsedMs', extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  end;
end;
$$;

create or replace function r84_concurrency_test.auth_insert_attempt(
  input_user_id uuid,
  input_email text,
  input_intent_id uuid,
  input_barrier_key bigint
)
returns jsonb
language plpgsql
volatile
set search_path = pg_catalog, public, r84_concurrency_test
as $$
declare
  started_at timestamptz := pg_catalog.clock_timestamp();
  transaction_id text := pg_catalog.pg_current_xact_id()::text;
  error_state text;
  result_status text;
begin
  begin
    perform pg_catalog.pg_advisory_xact_lock_shared(input_barrier_key);
    perform pg_catalog.set_config('lock_timeout', '3000ms', true);

    insert into auth.users (
      id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
    ) values (
      input_user_id,
      input_email,
      pg_catalog.now(),
      '{}'::jsonb,
      pg_catalog.jsonb_build_object(
        'quiksol_provisioning_intent_id', input_intent_id
      )
    );

    return pg_catalog.jsonb_build_object(
      'resultStatus', 'success',
      'sqlstate', null,
      'requestedUserId', input_user_id,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'elapsedMs', extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  exception when query_canceled then
    return pg_catalog.jsonb_build_object(
      'resultStatus', 'timeout',
      'sqlstate', sqlstate,
      'requestedUserId', input_user_id,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'elapsedMs', extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  when others then
    error_state := sqlstate;
    result_status := case
      when error_state = 'QS834' then 'expected_conflict'
      when error_state = '40P01' then 'deadlock'
      when error_state in ('55P03', '57014') then 'timeout'
      else 'error'
    end;

    return pg_catalog.jsonb_build_object(
      'resultStatus', result_status,
      'sqlstate', error_state,
      'requestedUserId', input_user_id,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'elapsedMs', extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  end;
end;
$$;

create or replace procedure r84_concurrency_test.record_attempt(
  input_scenario text,
  input_iteration integer,
  input_contender text,
  input_result jsonb
)
language plpgsql
set search_path = pg_catalog, public, r84_concurrency_test
as $$
begin
  insert into r84_concurrency_test.attempt_results (
    scenario,
    iteration,
    contender,
    result_status,
    state,
    sqlstate,
    intent_id,
    auth_user_id,
    attempt_count,
    backend_pid,
    transaction_id,
    elapsed_ms
  ) values (
    input_scenario,
    input_iteration,
    input_contender,
    input_result->>'resultStatus',
    input_result->>'state',
    input_result->>'sqlstate',
    nullif(input_result->>'intentId', '')::uuid,
    nullif(input_result->>'authUserId', '')::uuid,
    nullif(input_result->>'attemptCount', '')::integer,
    (input_result->>'backendPid')::integer,
    input_result->>'transactionId',
    (input_result->>'elapsedMs')::numeric
  );
end;
$$;

create or replace procedure r84_concurrency_test.run_pair(
  input_scenario text,
  input_iteration integer,
  input_key_a uuid,
  input_key_b uuid,
  input_email text,
  input_name_a text,
  input_name_b text,
  input_role_a text,
  input_role_b text
)
language plpgsql
set search_path = pg_catalog, public, r84_concurrency_test
as $$
declare
  barrier_key constant bigint := 8404202608272001;
  query_a text;
  query_b text;
  result_a jsonb;
  result_b jsonb;
  waiting_backends integer := 0;
  wait_attempt integer;
  intent_count integer;
  minimum_attempt integer;
  maximum_attempt integer;
begin
  query_a := pg_catalog.format(
    'select r84_concurrency_test.begin_attempt(%L::uuid,%L,%L,%L,%s::bigint)',
    input_key_a::text,
    input_email,
    input_name_a,
    input_role_a,
    barrier_key
  );
  query_b := pg_catalog.format(
    'select r84_concurrency_test.begin_attempt(%L::uuid,%L,%L,%L,%s::bigint)',
    input_key_b::text,
    input_email,
    input_name_b,
    input_role_b,
    barrier_key
  );

  perform pg_catalog.pg_advisory_lock(barrier_key);
  perform public.dblink_send_query('r84_concurrency_a', query_a);
  perform public.dblink_send_query('r84_concurrency_b', query_b);

  for wait_attempt in 1..300 loop
    select count(*)::integer
    into waiting_backends
    from pg_catalog.pg_stat_activity activity
    where activity.datname = pg_catalog.current_database()
      and activity.application_name in (
        'r84_user_provisioning_a',
        'r84_user_provisioning_b'
      )
      and activity.state = 'active'
      and activity.wait_event_type = 'Lock'
      and pg_catalog.lower(activity.wait_event) = 'advisory';
    exit when waiting_backends = 2;
    perform pg_catalog.pg_sleep(0.01);
  end loop;

  if waiting_backends <> 2 then
    perform pg_catalog.pg_advisory_unlock(barrier_key);
    raise exception 'R84_TWO_CONNECTION_BARRIER_FAILED:%:%', input_scenario, input_iteration;
  end if;

  perform pg_catalog.pg_advisory_unlock(barrier_key);

  select payload into result_a
  from public.dblink_get_result('r84_concurrency_a') as response(payload jsonb);
  select payload into result_b
  from public.dblink_get_result('r84_concurrency_b') as response(payload jsonb);

  -- Drain libpq terminal results before reusing either persistent connection.
  perform payload
  from public.dblink_get_result('r84_concurrency_a') as response(payload jsonb);
  perform payload
  from public.dblink_get_result('r84_concurrency_b') as response(payload jsonb);

  if result_a->>'backendPid' = result_b->>'backendPid'
     or result_a->>'transactionId' = result_b->>'transactionId' then
    raise exception 'R84_NOT_DISTINCT_BACKENDS_OR_TRANSACTIONS:%:%',
      input_scenario, input_iteration;
  end if;

  call r84_concurrency_test.record_attempt(
    input_scenario, input_iteration, 'A', result_a
  );
  call r84_concurrency_test.record_attempt(
    input_scenario, input_iteration, 'B', result_b
  );

  select
    count(*)::integer,
    min(intent.attempt_count)::integer,
    max(intent.attempt_count)::integer
  into intent_count, minimum_attempt, maximum_attempt
  from public.user_provisioning_intents intent
  where intent.requested_email_hash = extensions.digest(
    pg_catalog.lower(pg_catalog.btrim(input_email)),
    'sha256'
  );

  insert into r84_concurrency_test.iteration_results (
    scenario,
    iteration,
    intent_rows,
    minimum_attempt_count,
    maximum_attempt_count
  ) values (
    input_scenario,
    input_iteration,
    intent_count,
    minimum_attempt,
    maximum_attempt
  );
exception when others then
  perform pg_catalog.pg_advisory_unlock(barrier_key);
  raise;
end;
$$;

create or replace procedure r84_concurrency_test.run_auth_race_and_recovery(
  input_iteration integer,
  input_idempotency_key uuid,
  input_email text,
  input_full_name text,
  input_intent_id uuid,
  input_user_a uuid,
  input_user_b uuid
)
language plpgsql
set search_path = pg_catalog, public, r84_concurrency_test
as $$
declare
  barrier_key constant bigint := 8404202608272002;
  query_a text;
  query_b text;
  recovery_query text;
  result_a jsonb;
  result_b jsonb;
  recovery_a jsonb;
  recovery_b jsonb;
  winning_user_id uuid;
  waiting_backends integer := 0;
  wait_attempt integer;
  intent_count integer;
  minimum_attempt integer;
  maximum_attempt integer;
  auth_count integer;
  profile_count integer;
  audit_count integer;
begin
  query_a := pg_catalog.format(
    'select r84_concurrency_test.auth_insert_attempt(%L::uuid,%L,%L::uuid,%s::bigint)',
    input_user_a::text,
    input_email,
    input_intent_id::text,
    barrier_key
  );
  query_b := pg_catalog.format(
    'select r84_concurrency_test.auth_insert_attempt(%L::uuid,%L,%L::uuid,%s::bigint)',
    input_user_b::text,
    input_email,
    input_intent_id::text,
    barrier_key
  );

  perform pg_catalog.pg_advisory_lock(barrier_key);
  perform public.dblink_send_query('r84_concurrency_a', query_a);
  perform public.dblink_send_query('r84_concurrency_b', query_b);

  for wait_attempt in 1..300 loop
    select count(*)::integer
    into waiting_backends
    from pg_catalog.pg_stat_activity activity
    where activity.datname = pg_catalog.current_database()
      and activity.application_name in (
        'r84_user_provisioning_a',
        'r84_user_provisioning_b'
      )
      and activity.state = 'active'
      and activity.wait_event_type = 'Lock'
      and pg_catalog.lower(activity.wait_event) = 'advisory';
    exit when waiting_backends = 2;
    perform pg_catalog.pg_sleep(0.01);
  end loop;

  if waiting_backends <> 2 then
    perform pg_catalog.pg_advisory_unlock(barrier_key);
    raise exception 'R84_AUTH_TWO_CONNECTION_BARRIER_FAILED:%', input_iteration;
  end if;

  perform pg_catalog.pg_advisory_unlock(barrier_key);

  select payload into result_a
  from public.dblink_get_result('r84_concurrency_a') as response(payload jsonb);
  select payload into result_b
  from public.dblink_get_result('r84_concurrency_b') as response(payload jsonb);
  perform payload
  from public.dblink_get_result('r84_concurrency_a') as response(payload jsonb);
  perform payload
  from public.dblink_get_result('r84_concurrency_b') as response(payload jsonb);

  if result_a->>'backendPid' = result_b->>'backendPid'
     or result_a->>'transactionId' = result_b->>'transactionId' then
    raise exception 'R84_AUTH_RACE_NOT_DISTINCT:%', input_iteration;
  end if;

  insert into r84_concurrency_test.auth_race_results (
    iteration, contender, result_status, sqlstate, requested_user_id,
    backend_pid, transaction_id, elapsed_ms
  ) values
    (
      input_iteration,
      'A',
      result_a->>'resultStatus',
      result_a->>'sqlstate',
      (result_a->>'requestedUserId')::uuid,
      (result_a->>'backendPid')::integer,
      result_a->>'transactionId',
      (result_a->>'elapsedMs')::numeric
    ),
    (
      input_iteration,
      'B',
      result_b->>'resultStatus',
      result_b->>'sqlstate',
      (result_b->>'requestedUserId')::uuid,
      (result_b->>'backendPid')::integer,
      result_b->>'transactionId',
      (result_b->>'elapsedMs')::numeric
    );

  if (result_a->>'resultStatus' = 'success') =
       (result_b->>'resultStatus' = 'success')
     or (result_a->>'resultStatus' <> 'success'
         and (result_a->>'resultStatus' <> 'expected_conflict'
              or result_a->>'sqlstate' <> 'QS834'))
     or (result_b->>'resultStatus' <> 'success'
         and (result_b->>'resultStatus' <> 'expected_conflict'
              or result_b->>'sqlstate' <> 'QS834')) then
    raise exception 'R84_AUTH_RACE_OUTCOME_INVALID:%:%:%',
      input_iteration, result_a, result_b;
  end if;

  winning_user_id := case
    when result_a->>'resultStatus' = 'success'
      then (result_a->>'requestedUserId')::uuid
    else (result_b->>'requestedUserId')::uuid
  end;

  recovery_query := pg_catalog.format(
    'select r84_concurrency_test.begin_attempt(%L::uuid,%L,%L,%L,null)',
    input_idempotency_key::text,
    input_email,
    input_full_name,
    'employee'
  );
  select payload into recovery_a
  from public.dblink('r84_concurrency_a', recovery_query) as response(payload jsonb);
  select payload into recovery_b
  from public.dblink('r84_concurrency_b', recovery_query) as response(payload jsonb);

  if recovery_a->>'backendPid' = recovery_b->>'backendPid'
     or recovery_a->>'transactionId' = recovery_b->>'transactionId'
     or recovery_a->>'state' <> 'EXISTING_COMPLETED'
     or recovery_b->>'state' <> 'EXISTING_COMPLETED'
     or (recovery_a->>'intentId')::uuid <> input_intent_id
     or (recovery_b->>'intentId')::uuid <> input_intent_id
     or (recovery_a->>'authUserId')::uuid <> winning_user_id
     or (recovery_b->>'authUserId')::uuid <> winning_user_id then
    raise exception 'R84_AUTH_RACE_RECOVERY_INVALID:%:%:%',
      input_iteration, recovery_a, recovery_b;
  end if;

  insert into r84_concurrency_test.recovery_results (
    iteration, contender, state, intent_id, auth_user_id, attempt_count,
    backend_pid, transaction_id, elapsed_ms
  ) values
    (
      input_iteration,
      'A',
      recovery_a->>'state',
      (recovery_a->>'intentId')::uuid,
      (recovery_a->>'authUserId')::uuid,
      (recovery_a->>'attemptCount')::integer,
      (recovery_a->>'backendPid')::integer,
      recovery_a->>'transactionId',
      (recovery_a->>'elapsedMs')::numeric
    ),
    (
      input_iteration,
      'B',
      recovery_b->>'state',
      (recovery_b->>'intentId')::uuid,
      (recovery_b->>'authUserId')::uuid,
      (recovery_b->>'attemptCount')::integer,
      (recovery_b->>'backendPid')::integer,
      recovery_b->>'transactionId',
      (recovery_b->>'elapsedMs')::numeric
    );

  select
    count(*)::integer,
    min(intent.attempt_count)::integer,
    max(intent.attempt_count)::integer
  into intent_count, minimum_attempt, maximum_attempt
  from public.user_provisioning_intents intent
  where intent.id = input_intent_id;

  select count(*)::integer into auth_count
  from auth.users auth_user
  where pg_catalog.lower(pg_catalog.btrim(auth_user.email)) =
    pg_catalog.lower(pg_catalog.btrim(input_email));
  select count(*)::integer into profile_count
  from public.profiles profile
  where profile.id in (input_user_a, input_user_b);
  select count(*)::integer into audit_count
  from public.audit_logs audit
  where audit.action = 'user_provisioning_completed'
    and audit.entity_type = 'user_provisioning_intent'
    and audit.entity_id = input_intent_id;

  update r84_concurrency_test.iteration_results result
  set intent_rows = intent_count,
      minimum_attempt_count = minimum_attempt,
      maximum_attempt_count = maximum_attempt,
      auth_rows = auth_count,
      profile_rows = profile_count,
      completion_audits = audit_count
  where result.scenario = 'same_key_same_payload'
    and result.iteration = input_iteration;
exception when others then
  perform pg_catalog.pg_advisory_unlock(barrier_key);
  raise;
end;
$$;

create or replace procedure r84_concurrency_test.run_all()
language plpgsql
set search_path = pg_catalog, public, r84_concurrency_test
as $$
declare
  connection_base text;
  iteration_number integer;
  operation_key uuid;
  operation_key_b uuid;
  fixture_email text;
  fixture_user_id uuid;
  fixture_user_id_b uuid;
  query_a text;
  query_b text;
  result_a jsonb;
  result_b jsonb;
  created_intent_id uuid;
  intent_count integer;
  minimum_attempt integer;
  maximum_attempt integer;
  auth_count integer;
  profile_count integer;
  audit_count integer;
begin
  connection_base := pg_catalog.format(
    'host=%s port=%s dbname=%s user=%s options=''-c quiksol.allow_r83_user_provisioning_test=on -c request.jwt.claim.sub=84000000-0000-4000-8000-000000000002 -c request.jwt.claim.role=authenticated -c statement_timeout=15000''',
    coalesce(pg_catalog.host(pg_catalog.inet_server_addr()), '127.0.0.1'),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    current_user
  );

  perform public.dblink_connect(
    'r84_concurrency_a',
    connection_base || ' application_name=r84_user_provisioning_a'
  );
  perform public.dblink_connect(
    'r84_concurrency_b',
    connection_base || ' application_name=r84_user_provisioning_b'
  );

  -- Same key and payload: one insert, then one pending reuse.
  for iteration_number in 1..20 loop
    operation_key := (
      '84110000-0000-4000-8000-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    fixture_email := pg_catalog.format(
      'r84c_same_key_same_%s@example.invalid', iteration_number
    );
    call r84_concurrency_test.run_pair(
      'same_key_same_payload',
      iteration_number,
      operation_key,
      operation_key,
      fixture_email,
      pg_catalog.format('R84 Same Payload %s', iteration_number),
      pg_catalog.format('R84 Same Payload %s', iteration_number),
      'employee',
      'employee'
    );

    select intent.id
    into created_intent_id
    from public.user_provisioning_intents intent
    where intent.requested_email_hash = extensions.digest(fixture_email, 'sha256');

    fixture_user_id := (
      '84610000-0000-4000-8001-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    fixture_user_id_b := (
      '84610000-0000-4000-8002-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;

    call r84_concurrency_test.run_auth_race_and_recovery(
      iteration_number,
      operation_key,
      fixture_email,
      pg_catalog.format('R84 Same Payload %s', iteration_number),
      created_intent_id,
      fixture_user_id,
      fixture_user_id_b
    );
  end loop;

  -- Same key but a different logical payload: exactly one QS841 loser.
  for iteration_number in 1..20 loop
    operation_key := (
      '84120000-0000-4000-8000-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    fixture_email := pg_catalog.format(
      'r84c_same_key_conflict_%s@example.invalid', iteration_number
    );
    call r84_concurrency_test.run_pair(
      'same_key_different_payload',
      iteration_number,
      operation_key,
      operation_key,
      fixture_email,
      pg_catalog.format('R84 Payload A %s', iteration_number),
      pg_catalog.format('R84 Payload B %s', iteration_number),
      'employee',
      'manager'
    );
  end loop;

  -- Different keys reserve one normalized email under the shared email mutex.
  for iteration_number in 1..20 loop
    operation_key := (
      '84130000-0000-4000-8001-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    operation_key_b := (
      '84130000-0000-4000-8002-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    fixture_email := pg_catalog.format(
      'r84c_same_email_%s@example.invalid', iteration_number
    );
    call r84_concurrency_test.run_pair(
      'different_keys_same_email',
      iteration_number,
      operation_key,
      operation_key_b,
      fixture_email,
      pg_catalog.format('R84 Same Email %s', iteration_number),
      pg_catalog.format('R84 Same Email %s', iteration_number),
      'employee',
      'employee'
    );

    select intent.id
    into created_intent_id
    from public.user_provisioning_intents intent
    where intent.requested_email_hash = extensions.digest(fixture_email, 'sha256');

    fixture_user_id := (
      '84630000-0000-4000-8000-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;

    perform public.dblink_exec(
      'r84_concurrency_a',
      pg_catalog.format(
        'insert into auth.users (id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values (%L::uuid,%L,pg_catalog.now(),''{}''::jsonb,pg_catalog.jsonb_build_object(''quiksol_provisioning_intent_id'',%L::uuid))',
        fixture_user_id::text,
        fixture_email,
        created_intent_id::text
      )
    );

    select count(*)::integer into auth_count
    from auth.users auth_user
    where pg_catalog.lower(pg_catalog.btrim(auth_user.email)) = fixture_email;

    select count(*)::integer into profile_count
    from public.profiles profile
    where profile.id = fixture_user_id;

    select count(*)::integer into audit_count
    from public.audit_logs audit
    where audit.action = 'user_provisioning_completed'
      and audit.entity_type = 'user_provisioning_intent'
      and audit.entity_id = created_intent_id;

    update r84_concurrency_test.iteration_results result
    set auth_rows = auth_count,
        profile_rows = profile_count,
        completion_audits = audit_count
    where result.scenario = 'different_keys_same_email'
      and result.iteration = iteration_number;
  end loop;

  -- Pending retry: two independent real transactions converge to one intent.
  for iteration_number in 1..20 loop
    operation_key := (
      '84140000-0000-4000-8000-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    fixture_email := pg_catalog.format(
      'r84c_pending_retry_%s@example.invalid', iteration_number
    );
    query_a := pg_catalog.format(
      'select r84_concurrency_test.begin_attempt(%L::uuid,%L,%L,%L,null)',
      operation_key::text,
      fixture_email,
      pg_catalog.format('R84 Pending Retry %s', iteration_number),
      'employee'
    );
    query_b := query_a;

    select payload into result_a
    from public.dblink('r84_concurrency_a', query_a) as response(payload jsonb);
    select payload into result_b
    from public.dblink('r84_concurrency_b', query_b) as response(payload jsonb);

    if result_a->>'backendPid' = result_b->>'backendPid'
       or result_a->>'transactionId' = result_b->>'transactionId' then
      raise exception 'R84_PENDING_RETRY_NOT_DISTINCT:%', iteration_number;
    end if;

    call r84_concurrency_test.record_attempt(
      'pending_retry', iteration_number, 'A', result_a
    );
    call r84_concurrency_test.record_attempt(
      'pending_retry', iteration_number, 'B', result_b
    );

    select
      count(*)::integer,
      min(intent.attempt_count)::integer,
      max(intent.attempt_count)::integer
    into intent_count, minimum_attempt, maximum_attempt
    from public.user_provisioning_intents intent
    where intent.requested_email_hash = extensions.digest(fixture_email, 'sha256');

    insert into r84_concurrency_test.iteration_results (
      scenario, iteration, intent_rows, minimum_attempt_count, maximum_attempt_count
    ) values (
      'pending_retry', iteration_number, intent_count, minimum_attempt, maximum_attempt
    );
  end loop;

  -- Completed response replay: Auth/Profile/audit are created once; the second
  -- transaction reads the same completed intent and never inserts another Auth.
  for iteration_number in 1..20 loop
    operation_key := (
      '84150000-0000-4000-8000-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    fixture_user_id := (
      '84550000-0000-4000-8000-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    fixture_email := pg_catalog.format(
      'r84c_completed_replay_%s@example.invalid', iteration_number
    );
    query_a := pg_catalog.format(
      'select r84_concurrency_test.begin_attempt(%L::uuid,%L,%L,%L,null)',
      operation_key::text,
      fixture_email,
      pg_catalog.format('R84 Completed Replay %s', iteration_number),
      'employee'
    );

    select payload into result_a
    from public.dblink('r84_concurrency_a', query_a) as response(payload jsonb);
    created_intent_id := (result_a->>'intentId')::uuid;

    perform public.dblink_exec(
      'r84_concurrency_a',
      pg_catalog.format(
        'insert into auth.users (id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values (%L::uuid,%L,pg_catalog.now(),''{}''::jsonb,pg_catalog.jsonb_build_object(''quiksol_provisioning_intent_id'',%L::uuid))',
        fixture_user_id::text,
        fixture_email,
        created_intent_id::text
      )
    );

    select payload into result_b
    from public.dblink('r84_concurrency_b', query_a) as response(payload jsonb);

    if result_a->>'backendPid' = result_b->>'backendPid'
       or result_a->>'transactionId' = result_b->>'transactionId'
       or result_a->>'state' <> 'NEW'
       or result_b->>'state' <> 'EXISTING_COMPLETED'
       or (result_b->>'intentId')::uuid <> created_intent_id
       or (result_b->>'authUserId')::uuid <> fixture_user_id then
      raise exception 'R84_COMPLETED_REPLAY_DID_NOT_CONVERGE:%:%:%',
        iteration_number, result_a, result_b;
    end if;

    call r84_concurrency_test.record_attempt(
      'completed_replay', iteration_number, 'A', result_a
    );
    call r84_concurrency_test.record_attempt(
      'completed_replay', iteration_number, 'B', result_b
    );

    select
      count(*)::integer,
      min(intent.attempt_count)::integer,
      max(intent.attempt_count)::integer
    into intent_count, minimum_attempt, maximum_attempt
    from public.user_provisioning_intents intent
    where intent.requested_email_hash = extensions.digest(fixture_email, 'sha256');

    select count(*)::integer into auth_count
    from auth.users where id = fixture_user_id;
    select count(*)::integer into profile_count
    from public.profiles where id = fixture_user_id;
    select count(*)::integer into audit_count
    from public.audit_logs audit
    where audit.action = 'user_provisioning_completed'
      and audit.entity_type = 'user_provisioning_intent'
      and audit.entity_id = created_intent_id;

    insert into r84_concurrency_test.iteration_results (
      scenario,
      iteration,
      intent_rows,
      minimum_attempt_count,
      maximum_attempt_count,
      auth_rows,
      profile_rows,
      completion_audits
    ) values (
      'completed_replay',
      iteration_number,
      intent_count,
      minimum_attempt,
      maximum_attempt,
      auth_count,
      profile_count,
      audit_count
    );
  end loop;

  perform public.dblink_disconnect('r84_concurrency_a');
  perform public.dblink_disconnect('r84_concurrency_b');
exception when others then
  perform pg_catalog.pg_advisory_unlock(8404202608272001::bigint);
  begin
    perform public.dblink_disconnect('r84_concurrency_a');
  exception when others then null;
  end;
  begin
    perform public.dblink_disconnect('r84_concurrency_b');
  exception when others then null;
  end;
  raise;
end;
$$;

call r84_concurrency_test.run_all();

-- Exact outcome matrix and physical-state convergence.
do $$
begin
  if (select count(*) from r84_concurrency_test.attempt_results) <> 200
     or exists (
       select 1
       from (values
         ('same_key_same_payload'),
         ('same_key_different_payload'),
         ('different_keys_same_email'),
         ('pending_retry'),
         ('completed_replay')
       ) scenario(name)
       where (select count(*) from r84_concurrency_test.attempt_results attempt
              where attempt.scenario = scenario.name) <> 40
     ) then
    raise exception 'R84_CONCURRENCY_ATTEMPT_CARDINALITY_INVALID';
  end if;

  if (select count(*) from r84_concurrency_test.attempt_results
      where scenario = 'same_key_same_payload' and state = 'NEW') <> 20
     or (select count(*) from r84_concurrency_test.attempt_results
         where scenario = 'same_key_same_payload' and state = 'EXISTING_PENDING') <> 20
     or (select count(*) from r84_concurrency_test.attempt_results
         where scenario = 'same_key_different_payload' and state = 'NEW') <> 20
     or (select count(*) from r84_concurrency_test.attempt_results
         where scenario = 'same_key_different_payload'
           and result_status = 'expected_conflict' and sqlstate = 'QS841') <> 20
     or (select count(*) from r84_concurrency_test.attempt_results
         where scenario = 'different_keys_same_email' and state = 'NEW') <> 20
     or (select count(*) from r84_concurrency_test.attempt_results
         where scenario = 'different_keys_same_email'
           and result_status = 'expected_conflict' and sqlstate = 'QS843') <> 20
     or (select count(*) from r84_concurrency_test.attempt_results
         where scenario = 'pending_retry' and state = 'NEW') <> 20
     or (select count(*) from r84_concurrency_test.attempt_results
         where scenario = 'pending_retry' and state = 'EXISTING_PENDING') <> 20
     or (select count(*) from r84_concurrency_test.attempt_results
         where scenario = 'completed_replay' and state = 'NEW') <> 20
     or (select count(*) from r84_concurrency_test.attempt_results
         where scenario = 'completed_replay' and state = 'EXISTING_COMPLETED') <> 20 then
    raise exception 'R84_CONCURRENCY_OUTCOME_MATRIX_INVALID';
  end if;

  if exists (
    select 1
    from r84_concurrency_test.attempt_results
    where result_status in ('deadlock', 'timeout', 'error')
  ) or exists (
    select 1
    from r84_concurrency_test.auth_race_results
    where result_status in ('deadlock', 'timeout', 'error')
  ) then
    raise exception 'R84_CONCURRENCY_UNEXPECTED_ERROR';
  end if;

  if exists (
    select scenario, iteration
    from r84_concurrency_test.attempt_results
    group by scenario, iteration
    having count(distinct backend_pid) <> 2
       or count(distinct transaction_id) <> 2
  ) then
    raise exception 'R84_CONCURRENCY_NOT_TWO_REAL_TRANSACTIONS';
  end if;

  if (select count(*) from r84_concurrency_test.auth_race_results) <> 40
     or (select count(*) from r84_concurrency_test.auth_race_results
         where result_status = 'success') <> 20
     or (select count(*) from r84_concurrency_test.auth_race_results
         where result_status = 'expected_conflict' and sqlstate = 'QS834') <> 20
     or exists (
       select iteration
       from r84_concurrency_test.auth_race_results
       group by iteration
       having count(*) <> 2
          or count(*) filter (where result_status = 'success') <> 1
          or count(*) filter (
            where result_status = 'expected_conflict' and sqlstate = 'QS834'
          ) <> 1
          or count(distinct backend_pid) <> 2
          or count(distinct transaction_id) <> 2
     ) then
    raise exception 'R84_AUTH_RACE_MATRIX_INVALID';
  end if;

  if (select count(*) from r84_concurrency_test.recovery_results) <> 40
     or exists (
       select iteration
       from r84_concurrency_test.recovery_results
       group by iteration
       having count(*) <> 2
          or count(*) filter (where state = 'EXISTING_COMPLETED') <> 2
          or count(distinct intent_id) <> 1
          or count(distinct auth_user_id) <> 1
          or count(distinct backend_pid) <> 2
          or count(distinct transaction_id) <> 2
          or min(attempt_count) <> 3
          or max(attempt_count) <> 4
     ) then
    raise exception 'R84_AUTH_RACE_RECOVERY_MATRIX_INVALID';
  end if;

  if (select count(*) from r84_concurrency_test.iteration_results) <> 100
     or exists (
       select 1
       from r84_concurrency_test.iteration_results result
       where result.intent_rows <> 1
          or (
            result.scenario in ('pending_retry', 'completed_replay')
            and (
              result.minimum_attempt_count <> 2
              or result.maximum_attempt_count <> 2
            )
          )
          or (
            result.scenario = 'same_key_same_payload'
            and (
              result.minimum_attempt_count <> 4
              or result.maximum_attempt_count <> 4
            )
          )
          or (
            result.scenario in ('same_key_different_payload', 'different_keys_same_email')
            and (
              result.minimum_attempt_count <> 1
              or result.maximum_attempt_count <> 1
            )
          )
          or (
            result.scenario in (
              'same_key_same_payload',
              'different_keys_same_email',
              'completed_replay'
            )
            and (
              result.auth_rows <> 1
              or result.profile_rows <> 1
              or result.completion_audits <> 1
            )
          )
          or (
            result.scenario not in (
              'same_key_same_payload',
              'different_keys_same_email',
              'completed_replay'
            )
            and (
              result.auth_rows <> 0
              or result.profile_rows <> 0
              or result.completion_audits <> 0
            )
          )
     ) then
    raise exception 'R84_CONCURRENCY_PHYSICAL_STATE_INVALID';
  end if;
end;
$$;

select
  scenario,
  count(distinct iteration)::integer as iterations,
  count(*) filter (where state = 'NEW')::integer as logical_new,
  count(*) filter (where state in ('EXISTING_PENDING', 'EXISTING_COMPLETED'))::integer as reuses,
  count(*) filter (where result_status = 'expected_conflict')::integer as conflicts,
  0::integer as duplicates,
  count(*) filter (where result_status = 'deadlock')::integer as deadlocks,
  count(*) filter (where result_status = 'timeout')::integer as timeouts,
  count(*) filter (where result_status = 'error')::integer as unexpected_errors,
  pg_catalog.round(avg(elapsed_ms), 3) as average_elapsed_ms,
  pg_catalog.round(max(elapsed_ms), 3) as maximum_elapsed_ms
from r84_concurrency_test.attempt_results
group by scenario
order by scenario;

select
  'same_key_same_payload_auth_race'::text as scenario,
  count(distinct iteration)::integer as iterations,
  count(*) filter (where result_status = 'success')::integer as auth_winners,
  count(*) filter (
    where result_status = 'expected_conflict' and sqlstate = 'QS834'
  )::integer as consumed_intent_conflicts,
  0::integer as duplicate_auth_users,
  count(*) filter (where result_status = 'deadlock')::integer as deadlocks,
  count(*) filter (where result_status = 'timeout')::integer as timeouts,
  count(*) filter (where result_status = 'error')::integer as unexpected_errors,
  pg_catalog.round(avg(elapsed_ms), 3) as average_elapsed_ms,
  pg_catalog.round(max(elapsed_ms), 3) as maximum_elapsed_ms
from r84_concurrency_test.auth_race_results;

select
  'same_key_same_payload_completed_recovery'::text as scenario,
  count(distinct iteration)::integer as iterations,
  count(*) filter (where state = 'EXISTING_COMPLETED')::integer as completed_reuses,
  count(distinct intent_id)::integer as completed_intents,
  count(distinct auth_user_id)::integer as winning_auth_users,
  pg_catalog.round(avg(elapsed_ms), 3) as average_elapsed_ms,
  pg_catalog.round(max(elapsed_ms), 3) as maximum_elapsed_ms
from r84_concurrency_test.recovery_results;

select 'USER_PROVISIONING_R84_CONCURRENCY_PASS' as result,
  20 as iterations_per_scenario,
  0 as duplicates,
  (select count(*) from r84_concurrency_test.attempt_results
   where result_status = 'deadlock')
    + (select count(*) from r84_concurrency_test.auth_race_results
       where result_status = 'deadlock') as deadlocks,
  (select count(*) from r84_concurrency_test.attempt_results
   where result_status = 'timeout')
    + (select count(*) from r84_concurrency_test.auth_race_results
       where result_status = 'timeout') as timeouts,
  (select count(*) from r84_concurrency_test.attempt_results
   where result_status = 'error')
    + (select count(*) from r84_concurrency_test.auth_race_results
       where result_status = 'error') as unexpected_errors;
