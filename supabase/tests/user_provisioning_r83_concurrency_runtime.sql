-- Real two-connection proof that one durable intent can finalize exactly one
-- Auth/Profile pair. The race is repeated 20 times in a disposable database.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r83_user_provisioning_test'
     or current_setting('quiksol.allow_r83_user_provisioning_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_R83_USER_PROVISIONING_TEST_DATABASE';
  end if;
  if public.user_provisioning_intent_required_v1() is distinct from true then
    raise exception 'R83B_REQUIRED_FOR_CONCURRENCY_PROOF';
  end if;
end;
$$;

create extension if not exists dblink;
drop schema if exists r83_test cascade;
create schema r83_test;

create table r83_test.attempt_results (
  iteration integer not null,
  contender text not null check (contender in ('A', 'B')),
  status text not null,
  sqlstate text,
  backend_pid integer not null,
  transaction_id text not null,
  elapsed_ms numeric not null,
  primary key (iteration, contender)
);

create table r83_test.iteration_results (
  iteration integer primary key,
  intent_id uuid not null,
  auth_rows integer not null,
  profile_rows integer not null,
  completed_intents integer not null
);

create or replace function r83_test.attempt(
  input_user_id uuid,
  input_email text,
  input_intent_id uuid
)
returns jsonb
language plpgsql
volatile
set search_path = pg_catalog, public, r83_test
as $$
declare
  started_at timestamptz := pg_catalog.clock_timestamp();
  transaction_id text := pg_catalog.pg_current_xact_id()::text;
  error_state text;
  result_status text;
begin
  begin
    -- Test-only simultaneous-start gate, distinct from production locks.
    perform pg_catalog.pg_advisory_xact_lock_shared(8303202608271901::bigint);
    perform pg_catalog.set_config('lock_timeout', '3000ms', true);

    insert into auth.users (
      id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
    ) values (
      input_user_id,
      input_email,
      pg_catalog.now(),
      '{}'::jsonb,
      pg_catalog.jsonb_build_object(
        'quiksol_provisioning_intent_id',
        input_intent_id,
        'role',
        'super_admin_dev',
        'is_active',
        true,
        'department',
        'evil'
      )
    );

    return pg_catalog.jsonb_build_object(
      'status', 'success',
      'sqlstate', null,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'elapsedMs', extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  exception when query_canceled then
    return pg_catalog.jsonb_build_object(
      'status', 'timeout',
      'sqlstate', sqlstate,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'elapsedMs', extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  when others then
    error_state := sqlstate;
    result_status := case
      when error_state = 'QS834' then 'rejected'
      when error_state = '40P01' then 'deadlock'
      when error_state in ('55P03', '57014') then 'timeout'
      else 'error'
    end;
    return pg_catalog.jsonb_build_object(
      'status', result_status,
      'sqlstate', error_state,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'elapsedMs', extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  end;
end;
$$;

create or replace procedure r83_test.run_same_intent_race()
language plpgsql
set search_path = pg_catalog, public, r83_test
as $$
declare
  iteration_number integer;
  wait_attempt integer;
  waiting_backends integer;
  intent_id uuid;
  user_a uuid;
  user_b uuid;
  fixture_email text;
  query_a text;
  query_b text;
  result_a jsonb;
  result_b jsonb;
  auth_count integer;
  profile_count integer;
  completed_count integer;
  connection_base text;
begin
  connection_base := pg_catalog.format(
    'host=%s port=%s dbname=%s user=%s options=''-c quiksol.allow_r83_user_provisioning_test=on -c statement_timeout=10000''',
    coalesce(pg_catalog.host(pg_catalog.inet_server_addr()), '127.0.0.1'),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    current_user
  );

  perform dblink_connect(
    'r83_intent_a',
    connection_base || ' application_name=r83_same_intent_a'
  );
  perform dblink_connect(
    'r83_intent_b',
    connection_base || ' application_name=r83_same_intent_b'
  );

  for iteration_number in 1..20 loop
    fixture_email := pg_catalog.format(
      'r83_concurrency_%s@example.invalid',
      iteration_number
    );
    user_a := (
      '83000000-0000-4000-8001-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    user_b := (
      '83000000-0000-4000-8002-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;

    -- The coordinator's CALL is one transaction, so create the intent through
    -- a remote autocommit statement. Both contenders must see the committed
    -- pending row before they are released from the barrier.
    select created_id
    into intent_id
    from dblink(
      'r83_intent_a',
      pg_catalog.format(
        'select public.create_cli_user_provisioning_intent_v1(%L,%L,%L,%L,%L,true,null,null)',
        fixture_email,
        pg_catalog.format('R83 Concurrency %s', iteration_number),
        'admin',
        'Concurrency',
        'Test'
      )
    ) as response(created_id uuid);

    perform pg_catalog.pg_advisory_lock(8303202608271901::bigint);

    query_a := pg_catalog.format(
      'select r83_test.attempt(%L::uuid,%L,%L::uuid)',
      user_a::text,
      fixture_email,
      intent_id::text
    );
    query_b := pg_catalog.format(
      'select r83_test.attempt(%L::uuid,%L,%L::uuid)',
      user_b::text,
      fixture_email,
      intent_id::text
    );

    perform dblink_send_query('r83_intent_a', query_a);
    perform dblink_send_query('r83_intent_b', query_b);

    waiting_backends := 0;
    for wait_attempt in 1..200 loop
      select count(*)::integer
      into waiting_backends
      from pg_catalog.pg_stat_activity activity
      where activity.datname = pg_catalog.current_database()
        and activity.application_name in ('r83_same_intent_a', 'r83_same_intent_b')
        and activity.state = 'active'
        and activity.wait_event_type = 'Lock'
        and pg_catalog.lower(activity.wait_event) = 'advisory';
      exit when waiting_backends = 2;
      perform pg_catalog.pg_sleep(0.01);
    end loop;

    if waiting_backends <> 2 then
      perform pg_catalog.pg_advisory_unlock(8303202608271901::bigint);
      raise exception 'R83_TWO_CONNECTION_BARRIER_FAILED:%', iteration_number;
    end if;

    perform pg_catalog.pg_advisory_unlock(8303202608271901::bigint);

    select payload into result_a
    from dblink_get_result('r83_intent_a') as response(payload jsonb);
    select payload into result_b
    from dblink_get_result('r83_intent_b') as response(payload jsonb);

    -- Drain libpq's terminal result before the next asynchronous query.
    perform payload from dblink_get_result('r83_intent_a') as response(payload jsonb);
    perform payload from dblink_get_result('r83_intent_b') as response(payload jsonb);

    if (result_a->>'backendPid') = (result_b->>'backendPid')
       or (result_a->>'transactionId') = (result_b->>'transactionId') then
      raise exception 'R83_NOT_TWO_DISTINCT_TRANSACTIONS:%', iteration_number;
    end if;

    insert into r83_test.attempt_results (
      iteration, contender, status, sqlstate, backend_pid, transaction_id, elapsed_ms
    ) values
      (
        iteration_number,
        'A',
        result_a->>'status',
        result_a->>'sqlstate',
        (result_a->>'backendPid')::integer,
        result_a->>'transactionId',
        (result_a->>'elapsedMs')::numeric
      ),
      (
        iteration_number,
        'B',
        result_b->>'status',
        result_b->>'sqlstate',
        (result_b->>'backendPid')::integer,
        result_b->>'transactionId',
        (result_b->>'elapsedMs')::numeric
      );

    select count(*)::integer into auth_count
    from auth.users where id in (user_a, user_b);
    select count(*)::integer into profile_count
    from public.profiles where id in (user_a, user_b);
    select count(*)::integer into completed_count
    from public.user_provisioning_intents
    where id = intent_id
      and status = 'completed'
      and auth_user_id in (user_a, user_b)
      and completed_at is not null;

    insert into r83_test.iteration_results (
      iteration, intent_id, auth_rows, profile_rows, completed_intents
    ) values (
      iteration_number, intent_id, auth_count, profile_count, completed_count
    );
  end loop;

  perform dblink_disconnect('r83_intent_a');
  perform dblink_disconnect('r83_intent_b');
exception when others then
  perform pg_catalog.pg_advisory_unlock(8303202608271901::bigint);
  begin perform dblink_disconnect('r83_intent_a'); exception when others then null; end;
  begin perform dblink_disconnect('r83_intent_b'); exception when others then null; end;
  raise;
end;
$$;

call r83_test.run_same_intent_race();

select
  count(distinct iteration)::integer as iterations,
  count(*) filter (where contender = 'A' and status = 'success')::integer as a_success,
  count(*) filter (where contender = 'B' and status = 'success')::integer as b_success,
  count(*) filter (where status = 'rejected' and sqlstate = 'QS834')::integer as reused_rejections,
  count(*) filter (where status = 'deadlock')::integer as deadlocks,
  count(*) filter (where status = 'timeout')::integer as timeouts,
  count(*) filter (where status = 'error')::integer as unexpected_errors,
  pg_catalog.round(avg(elapsed_ms), 3) as average_elapsed_ms,
  pg_catalog.round(max(elapsed_ms), 3) as maximum_elapsed_ms
from r83_test.attempt_results;

do $$
begin
  if (select count(distinct iteration) from r83_test.attempt_results) <> 20
     or (select count(*) from r83_test.attempt_results) <> 40
     or (select count(*) from r83_test.attempt_results where status = 'success') <> 20
     or (select count(*) from r83_test.attempt_results where status = 'rejected' and sqlstate = 'QS834') <> 20
     or exists (select 1 from r83_test.attempt_results where status in ('deadlock', 'timeout', 'error'))
     or exists (
       select 1 from r83_test.iteration_results
       where auth_rows <> 1 or profile_rows <> 1 or completed_intents <> 1
     ) then
    raise exception 'R83_SAME_INTENT_CONCURRENCY_FAILED';
  end if;
end;
$$;

select 'USER_PROVISIONING_R83_CONCURRENCY_PASS' as result,
  20 as iterations,
  (select count(*) from r83_test.attempt_results where status = 'success') as winners,
  (select count(*) from r83_test.attempt_results where status = 'rejected' and sqlstate = 'QS834') as reused_rejections,
  (select count(*) from r83_test.attempt_results where status in ('deadlock', 'timeout')) as deadlocks_or_timeouts;
