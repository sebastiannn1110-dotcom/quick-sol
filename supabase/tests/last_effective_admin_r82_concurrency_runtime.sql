-- Real two-connection concurrency proof for R8.2. Every critical scenario is
-- executed 20 times in a disposable PostgreSQL database. A separate advisory
-- gate releases both backends together before they contend on the production
-- invariant mutex.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r82_admin_invariant_test'
     or current_setting('quiksol.allow_r82_admin_invariant_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_R82_ADMIN_INVARIANT_TEST_DATABASE';
  end if;
end;
$$;

create extension if not exists dblink;

drop schema if exists r82_test cascade;
create schema r82_test;

create table r82_test.scenarios (
  ordinal integer primary key,
  scenario text not null unique,
  actor_a uuid,
  target_a uuid not null,
  action_a text not null,
  actor_b uuid,
  target_b uuid not null,
  action_b text not null,
  expected_successes smallint not null
);

create table r82_test.attempt_results (
  scenario text not null,
  iteration integer not null,
  contender text not null check (contender in ('A', 'B')),
  status text not null,
  sqlstate text,
  backend_pid integer not null,
  transaction_id text not null,
  execution_role text not null,
  elapsed_ms numeric not null,
  primary key (scenario, iteration, contender)
);

create table r82_test.iteration_results (
  scenario text not null,
  iteration integer not null,
  final_effective_admins bigint not null,
  primary key (scenario, iteration)
);

insert into r82_test.scenarios (
  ordinal,
  scenario,
  actor_a,
  target_a,
  action_a,
  actor_b,
  target_b,
  action_b,
  expected_successes
) values
  (
    1,
    'two_admin_demote_demote',
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000202',
    'rpc_demote',
    '82000000-0000-4000-8000-000000000202',
    '82000000-0000-4000-8000-000000000201',
    'rpc_demote',
    1
  ),
  (
    2,
    'two_admin_disable_disable',
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000202',
    'rpc_disable',
    '82000000-0000-4000-8000-000000000202',
    '82000000-0000-4000-8000-000000000201',
    'rpc_disable',
    1
  ),
  (
    3,
    'two_admin_demote_disable',
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000202',
    'rpc_demote',
    '82000000-0000-4000-8000-000000000202',
    '82000000-0000-4000-8000-000000000201',
    'rpc_disable',
    1
  ),
  (
    4,
    'soft_delete_demote',
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000202',
    'rpc_disable',
    '82000000-0000-4000-8000-000000000202',
    '82000000-0000-4000-8000-000000000201',
    'rpc_demote',
    1
  ),
  (
    5,
    'direct_service_role_bypass',
    null,
    '82000000-0000-4000-8000-000000000201',
    'direct_demote',
    null,
    '82000000-0000-4000-8000-000000000202',
    'direct_disable',
    1
  ),
  (
    6,
    'mixed_rpc_direct',
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000202',
    'rpc_demote',
    null,
    '82000000-0000-4000-8000-000000000201',
    'direct_disable',
    1
  ),
  (
    7,
    'cross_target_deadlock',
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000202',
    'rpc_disable',
    '82000000-0000-4000-8000-000000000202',
    '82000000-0000-4000-8000-000000000201',
    'rpc_demote',
    1
  ),
  (
    8,
    'promotion_reactivation_lock_order',
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000203',
    'rpc_promote_reactivate',
    '82000000-0000-4000-8000-000000000202',
    '82000000-0000-4000-8000-000000000203',
    'rpc_demote',
    2
  ),
  (
    9,
    'three_admin_two_demotions',
    '82000000-0000-4000-8000-000000000203',
    '82000000-0000-4000-8000-000000000201',
    'rpc_demote',
    '82000000-0000-4000-8000-000000000203',
    '82000000-0000-4000-8000-000000000202',
    'rpc_demote',
    2
  ),
  (
    10,
    'direct_admin_superadmin_invariant',
    null,
    '82000000-0000-4000-8000-000000000201',
    'direct_demote',
    null,
    '82000000-0000-4000-8000-000000000202',
    'direct_disable',
    1
  ),
  (
    11,
    'admin_superadmin_rule_boundary',
    '82000000-0000-4000-8000-000000000202',
    '82000000-0000-4000-8000-000000000201',
    'rpc_demote',
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000202',
    'rpc_demote',
    1
  );

insert into auth.users (
  id,
  email,
  email_confirmed_at,
  banned_until,
  raw_user_meta_data
) values
  (
    '82000000-0000-4000-8000-000000000201',
    'r82-concurrency-a@example.invalid',
    pg_catalog.now(),
    null,
    '{"full_name":"R82 Concurrency A"}'::jsonb
  ),
  (
    '82000000-0000-4000-8000-000000000202',
    'r82-concurrency-b@example.invalid',
    pg_catalog.now(),
    null,
    '{"full_name":"R82 Concurrency B"}'::jsonb
  ),
  (
    '82000000-0000-4000-8000-000000000203',
    'r82-concurrency-c@example.invalid',
    pg_catalog.now(),
    null,
    '{"full_name":"R82 Concurrency C"}'::jsonb
  )
on conflict (id) do update
set email = excluded.email,
    email_confirmed_at = excluded.email_confirmed_at,
    banned_until = excluded.banned_until,
    raw_user_meta_data = excluded.raw_user_meta_data;

-- Ensure reruns in the same disposable DB can recover a profile removed by a
-- failed manual experiment. A remains effective throughout this upsert.
insert into public.profiles (id, full_name, email, role, is_active)
values
  (
    '82000000-0000-4000-8000-000000000201',
    'R82 Concurrency A',
    'r82-concurrency-a@example.invalid',
    'admin',
    true
  ),
  (
    '82000000-0000-4000-8000-000000000202',
    'R82 Concurrency B',
    'r82-concurrency-b@example.invalid',
    'employee',
    true
  ),
  (
    '82000000-0000-4000-8000-000000000203',
    'R82 Concurrency C',
    'r82-concurrency-c@example.invalid',
    'employee',
    true
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email,
    role = excluded.role,
    is_active = excluded.is_active;

create or replace procedure r82_test.reset_fixture(input_scenario text)
language plpgsql
set search_path = pg_catalog, public, r82_test
as $$
begin
  if not exists (
    select 1 from r82_test.scenarios where scenario = input_scenario
  ) then
    raise exception 'R82_UNKNOWN_SCENARIO:%', input_scenario;
  end if;

  update auth.users
  set email_confirmed_at = pg_catalog.now(),
      banned_until = null
  where id in (
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000202',
    '82000000-0000-4000-8000-000000000203'
  );

  -- One statement keeps the invariant true even while changing scenarios.
  update public.profiles
  set role = case
        when id = '82000000-0000-4000-8000-000000000203'::uuid
             and input_scenario = 'three_admin_two_demotions' then 'admin'
        when id = '82000000-0000-4000-8000-000000000202'::uuid
             and input_scenario in (
               'direct_admin_superadmin_invariant',
               'admin_superadmin_rule_boundary'
             ) then 'super_admin_dev'
        when id in (
          '82000000-0000-4000-8000-000000000201'::uuid,
          '82000000-0000-4000-8000-000000000202'::uuid
        ) then 'admin'
        else 'employee'
      end,
      is_active = not (
        id = '82000000-0000-4000-8000-000000000203'::uuid
        and input_scenario = 'promotion_reactivation_lock_order'
      )
  where id in (
    '82000000-0000-4000-8000-000000000201',
    '82000000-0000-4000-8000-000000000202',
    '82000000-0000-4000-8000-000000000203'
  );

  if public.effective_admin_count_v1() < 1 then
    raise exception 'R82_RESET_LEFT_ZERO_ADMINS:%', input_scenario;
  end if;
end;
$$;

create or replace function r82_test.attempt(
  input_scenario text,
  input_iteration integer,
  input_actor uuid,
  input_target uuid,
  input_action text
)
returns jsonb
language plpgsql
volatile
set search_path = pg_catalog, public, r82_test
as $$
declare
  started_at timestamptz;
  transaction_id text := pg_catalog.pg_current_xact_id()::text;
  changed_rows bigint;
  error_state text;
  result_status text;
  execution_role text := current_user;
begin
  started_at := pg_catalog.clock_timestamp();

  begin
    -- Test-only gate. It is deliberately distinct from the production mutex
    -- 8202202608271200 used by the R8.2 migration. Keeping the gate inside the
    -- exception block also makes an external statement timeout observable.
    perform pg_catalog.pg_advisory_xact_lock_shared(8202202608271201::bigint);
    perform pg_catalog.set_config('lock_timeout', '3000ms', true);
    perform pg_catalog.set_config(
      'request.jwt.claim.sub',
      coalesce(input_actor::text, ''),
      true
    );
    perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

    case input_action
      when 'rpc_demote' then
        perform public.update_profile_admin_v2(
          input_target,
          '{"role":"employee"}'::jsonb,
          false
        );
      when 'rpc_disable' then
        perform public.update_profile_admin_v2(
          input_target,
          '{"is_active":false}'::jsonb,
          false
        );
      when 'rpc_promote_reactivate' then
        perform public.update_profile_admin_v2(
          input_target,
          '{"role":"admin","is_active":true}'::jsonb,
          false
        );
      when 'direct_demote' then
        set local role service_role;
        execution_role := current_user;
        update public.profiles set role = 'employee' where id = input_target;
        get diagnostics changed_rows = row_count;
        reset role;
        if changed_rows <> 1 then raise exception 'R82_DIRECT_TARGET_MISSING'; end if;
      when 'direct_disable' then
        set local role service_role;
        execution_role := current_user;
        update public.profiles set is_active = false where id = input_target;
        get diagnostics changed_rows = row_count;
        reset role;
        if changed_rows <> 1 then raise exception 'R82_DIRECT_TARGET_MISSING'; end if;
      else
        raise exception 'R82_UNKNOWN_ACTION:%', input_action;
    end case;

    -- Constraint triggers are INITIALLY DEFERRED. Force their final-state
    -- census inside this savepoint so QS821 becomes a structured result rather
    -- than an uncaught error emitted after the function returns.
    set constraints
      profiles_effective_admin_validate_update_v1,
      profiles_effective_admin_validate_delete_v1 immediate;

    return pg_catalog.jsonb_build_object(
      'scenario', input_scenario,
      'iteration', input_iteration,
      'status', 'success',
      'sqlstate', null,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'executionRole', execution_role,
      'isolation', pg_catalog.current_setting('transaction_isolation'),
      'elapsedMs',
        extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  exception when query_canceled then
    error_state := sqlstate;
    reset role;
    return pg_catalog.jsonb_build_object(
      'scenario', input_scenario,
      'iteration', input_iteration,
      'status', 'timeout',
      'sqlstate', error_state,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'executionRole', execution_role,
      'isolation', pg_catalog.current_setting('transaction_isolation'),
      'elapsedMs',
        extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  when others then
    error_state := sqlstate;
    reset role;
    result_status := case
      when error_state in ('QS821', '42501') then 'rejected'
      when error_state = '40P01' then 'deadlock'
      when error_state in ('55P03', '57014') then 'timeout'
      else 'error'
    end;
    return pg_catalog.jsonb_build_object(
      'scenario', input_scenario,
      'iteration', input_iteration,
      'status', result_status,
      'sqlstate', error_state,
      'backendPid', pg_catalog.pg_backend_pid(),
      'transactionId', transaction_id,
      'executionRole', execution_role,
      'isolation', pg_catalog.current_setting('transaction_isolation'),
      'elapsedMs',
        extract(epoch from pg_catalog.clock_timestamp() - started_at) * 1000
    );
  end;
end;
$$;

create or replace function r82_test.try_invariant_lock_at_current_isolation()
returns text
language plpgsql
volatile
set search_path = pg_catalog, public, r82_test
as $$
begin
  begin
    perform public.lock_effective_admin_invariant_v1();
    return 'NOT_REJECTED';
  exception when sqlstate 'QS822' then
    return 'QS822';
  end;
end;
$$;

create or replace procedure r82_test.verify_isolation_guard()
language plpgsql
set search_path = pg_catalog, public, r82_test
as $$
declare
  connection_base text;
  guard_result text;
begin
  connection_base := pg_catalog.format(
    'host=%s port=%s dbname=%s user=%s application_name=r82_isolation_guard options=''-c quiksol.allow_r82_admin_invariant_test=on''',
    coalesce(pg_catalog.host(pg_catalog.inet_server_addr()), '127.0.0.1'),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    current_user
  );

  perform dblink_connect('r82_isolation_guard', connection_base);
  perform dblink_exec(
    'r82_isolation_guard',
    'begin isolation level repeatable read'
  );
  select result
  into guard_result
  from dblink(
    'r82_isolation_guard',
    'select r82_test.try_invariant_lock_at_current_isolation()'
  ) as response(result text);
  perform dblink_exec('r82_isolation_guard', 'rollback');
  perform dblink_disconnect('r82_isolation_guard');

  if guard_result <> 'QS822' then
    raise exception 'R82_REPEATABLE_READ_NOT_REJECTED:%', guard_result;
  end if;
exception when others then
  begin
    perform dblink_exec('r82_isolation_guard', 'rollback');
  exception when others then
    null;
  end;
  begin
    perform dblink_disconnect('r82_isolation_guard');
  exception when others then
    null;
  end;
  raise;
end;
$$;

create or replace procedure r82_test.run_all_scenarios()
language plpgsql
set search_path = pg_catalog, public, r82_test
as $$
declare
  scenario_record r82_test.scenarios%rowtype;
  iteration_number integer;
  wait_attempt integer;
  waiting_backends integer;
  query_a text;
  query_b text;
  result_a jsonb;
  result_b jsonb;
  final_admins bigint;
  connection_base text;
begin
  connection_base := pg_catalog.format(
    'host=%s port=%s dbname=%s user=%s options=''-c quiksol.allow_r82_admin_invariant_test=on -c statement_timeout=10000''',
    coalesce(pg_catalog.host(pg_catalog.inet_server_addr()), '127.0.0.1'),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    current_user
  );

  perform dblink_connect(
    'r82_admin_a',
    connection_base || ' application_name=r82_admin_invariant_a'
  );
  perform dblink_connect(
    'r82_admin_b',
    connection_base || ' application_name=r82_admin_invariant_b'
  );

  for scenario_record in
    select * from r82_test.scenarios order by ordinal
  loop
    for iteration_number in 1..20 loop
      perform dblink_exec(
        'r82_admin_a',
        pg_catalog.format(
          'call r82_test.reset_fixture(%L)',
          scenario_record.scenario
        )
      );

      perform pg_catalog.pg_advisory_lock(8202202608271201::bigint);

      query_a := pg_catalog.format(
        'select r82_test.attempt(%L,%s,%L::uuid,%L::uuid,%L)',
        scenario_record.scenario,
        iteration_number,
        scenario_record.actor_a::text,
        scenario_record.target_a::text,
        scenario_record.action_a
      );
      query_b := pg_catalog.format(
        'select r82_test.attempt(%L,%s,%L::uuid,%L::uuid,%L)',
        scenario_record.scenario,
        iteration_number,
        scenario_record.actor_b::text,
        scenario_record.target_b::text,
        scenario_record.action_b
      );

      perform dblink_send_query('r82_admin_a', query_a);
      perform dblink_send_query('r82_admin_b', query_b);

      waiting_backends := 0;
      for wait_attempt in 1..200 loop
        select count(*)::integer
        into waiting_backends
        from pg_catalog.pg_stat_activity activity
        where activity.datname = pg_catalog.current_database()
          and activity.application_name in (
            'r82_admin_invariant_a',
            'r82_admin_invariant_b'
          )
          and activity.state = 'active'
          and activity.wait_event_type = 'Lock'
          and lower(activity.wait_event) = 'advisory';
        exit when waiting_backends = 2;
        perform pg_catalog.pg_sleep(0.01);
      end loop;

      if waiting_backends <> 2 then
        perform pg_catalog.pg_advisory_unlock(8202202608271201::bigint);
        raise exception 'R82_TWO_CONNECTION_BARRIER_FAILED:%:%',
          scenario_record.scenario,
          iteration_number;
      end if;

      perform pg_catalog.pg_advisory_unlock(8202202608271201::bigint);

      select payload
      into result_a
      from dblink_get_result('r82_admin_a') as response(payload jsonb);

      select payload
      into result_b
      from dblink_get_result('r82_admin_b') as response(payload jsonb);

      -- libpq async queries must be drained through the terminal NULL result
      -- before a connection can accept the next reset/query iteration.
      perform payload
      from dblink_get_result('r82_admin_a') as response(payload jsonb);
      perform payload
      from dblink_get_result('r82_admin_b') as response(payload jsonb);

      if (result_a->>'backendPid') = (result_b->>'backendPid')
         or (result_a->>'transactionId') = (result_b->>'transactionId')
         or (result_a->>'isolation') <> 'read committed'
         or (result_b->>'isolation') <> 'read committed' then
        raise exception 'R82_NOT_TWO_DISTINCT_TRANSACTIONS:%:%',
          scenario_record.scenario,
          iteration_number;
      end if;

      insert into r82_test.attempt_results (
        scenario,
        iteration,
        contender,
        status,
        sqlstate,
        backend_pid,
        transaction_id,
        execution_role,
        elapsed_ms
      ) values
        (
          scenario_record.scenario,
          iteration_number,
          'A',
          result_a->>'status',
          result_a->>'sqlstate',
          (result_a->>'backendPid')::integer,
          result_a->>'transactionId',
          result_a->>'executionRole',
          (result_a->>'elapsedMs')::numeric
        ),
        (
          scenario_record.scenario,
          iteration_number,
          'B',
          result_b->>'status',
          result_b->>'sqlstate',
          (result_b->>'backendPid')::integer,
          result_b->>'transactionId',
          result_b->>'executionRole',
          (result_b->>'elapsedMs')::numeric
        );

      final_admins := public.effective_admin_count_v1();
      insert into r82_test.iteration_results (
        scenario,
        iteration,
        final_effective_admins
      ) values (
        scenario_record.scenario,
        iteration_number,
        final_admins
      );
    end loop;
  end loop;

  perform dblink_disconnect('r82_admin_a');
  perform dblink_disconnect('r82_admin_b');
end;
$$;

call r82_test.verify_isolation_guard();
call r82_test.run_all_scenarios();

-- Required concurrency report.
select
  scenario.scenario,
  count(distinct iteration.iteration)::integer as iterations,
  count(*) filter (
    where attempt.contender = 'A' and attempt.status = 'success'
  )::integer as a_success,
  count(*) filter (
    where attempt.contender = 'B' and attempt.status = 'success'
  )::integer as b_success,
  count(*) filter (where attempt.status = 'rejected')::integer as rejections,
  min(iteration.final_effective_admins) as final_min_admins,
  count(*) filter (where attempt.status = 'deadlock')::integer as deadlocks,
  count(*) filter (where attempt.status = 'timeout')::integer as timeouts,
  count(*) filter (where attempt.status = 'error')::integer as unexpected_errors
from r82_test.scenarios scenario
join r82_test.iteration_results iteration using (scenario)
join r82_test.attempt_results attempt
  on attempt.scenario = iteration.scenario
 and attempt.iteration = iteration.iteration
group by scenario.ordinal, scenario.scenario
order by scenario.ordinal;

do $$
declare
  scenario_record r82_test.scenarios%rowtype;
  iteration_count integer;
  attempt_count integer;
  success_count integer;
  rejection_count integer;
  deadlock_count integer;
  timeout_count integer;
  error_count integer;
  minimum_admins bigint;
begin
  for scenario_record in
    select * from r82_test.scenarios order by ordinal
  loop
    select
      count(distinct iteration.iteration)::integer,
      count(attempt.*)::integer,
      count(*) filter (where attempt.status = 'success')::integer,
      count(*) filter (where attempt.status = 'rejected')::integer,
      count(*) filter (where attempt.status = 'deadlock')::integer,
      count(*) filter (where attempt.status = 'timeout')::integer,
      count(*) filter (where attempt.status = 'error')::integer,
      min(iteration.final_effective_admins)
    into
      iteration_count,
      attempt_count,
      success_count,
      rejection_count,
      deadlock_count,
      timeout_count,
      error_count,
      minimum_admins
    from r82_test.iteration_results iteration
    join r82_test.attempt_results attempt
      on attempt.scenario = iteration.scenario
     and attempt.iteration = iteration.iteration
    where iteration.scenario = scenario_record.scenario;

    if iteration_count <> 20
       or attempt_count <> 40
       or success_count <> scenario_record.expected_successes * 20
       or rejection_count <> (2 - scenario_record.expected_successes) * 20
       or minimum_admins < 1
       or deadlock_count <> 0
       or timeout_count <> 0
       or error_count <> 0 then
      raise exception
        'R82_CONCURRENCY_SCENARIO_FAILED:% iterations=% attempts=% successes=% rejections=% min_admins=% deadlocks=% timeouts=% errors=%',
        scenario_record.scenario,
        iteration_count,
        attempt_count,
        success_count,
        rejection_count,
        minimum_admins,
        deadlock_count,
        timeout_count,
        error_count;
    end if;
  end loop;

  if (select count(*) from r82_test.attempt_results
      where scenario = 'admin_superadmin_rule_boundary'
        and contender = 'A'
        and status = 'success') <> 20
     or (select count(*) from r82_test.attempt_results
         where scenario = 'admin_superadmin_rule_boundary'
           and contender = 'B'
           and status = 'rejected') <> 20 then
    raise exception 'R82_SUPERADMIN_RULE_BOUNDARY_FAILED';
  end if;

  if exists (
    select 1
    from r82_test.attempt_results
    where scenario in (
        'direct_service_role_bypass',
        'direct_admin_superadmin_invariant'
      )
      and status = 'rejected'
      and sqlstate <> 'QS821'
  ) then
    raise exception 'R82_DIRECT_BYPASS_ERROR_NOT_STABLE';
  end if;

  if exists (
    select 1
    from r82_test.attempt_results
    where (
        scenario in (
          'direct_service_role_bypass',
          'direct_admin_superadmin_invariant'
        )
        or (scenario = 'mixed_rpc_direct' and contender = 'B')
      )
      and execution_role <> 'service_role'
  ) then
    raise exception 'R82_DIRECT_PATH_DID_NOT_RUN_AS_SERVICE_ROLE';
  end if;

  if (select count(*) from r82_test.attempt_results
      where scenario = 'three_admin_two_demotions'
        and contender = 'A'
        and status = 'success') <> 20
     or (select count(*) from r82_test.attempt_results
         where scenario = 'three_admin_two_demotions'
           and contender = 'B'
           and status = 'success') <> 20 then
    raise exception 'R82_THREE_ADMIN_OVER_SERIALIZATION_REGRESSION';
  end if;

  if (select count(*) from r82_test.attempt_results
      where scenario = 'promotion_reactivation_lock_order'
        and status = 'success') <> 40 then
    raise exception 'R82_PROMOTION_REDUCTION_LOCK_ORDER_REGRESSION';
  end if;

  if exists (
       select 1 from r82_test.iteration_results
       where scenario <> 'promotion_reactivation_lock_order'
         and final_effective_admins <> 1
     )
     or exists (
       select 1 from r82_test.iteration_results
       where scenario = 'promotion_reactivation_lock_order'
         and final_effective_admins not in (2, 3)
     ) then
    raise exception 'R82_CONCURRENCY_FINAL_STATE_UNEXPECTED';
  end if;
end;
$$;

select 'LAST_EFFECTIVE_ADMIN_R82_CONCURRENCY_PASS' as result,
  20 as iterations_per_scenario,
  count(distinct scenario) as scenarios,
  count(*) as total_iterations,
  min(final_effective_admins) as minimum_effective_admins,
  count(*) filter (where final_effective_admins < 1) as zero_admin_outcomes
from r82_test.iteration_results;
