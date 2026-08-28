-- R8.4.1 disposable performance evidence for Supabase-managed auth.users.
--
-- This test deliberately leaves auth.users with only the indexes supplied by
-- the disposable bootstrap. Synthetic census rows bypass the provisioning
-- trigger only while the fixture is loaded; all measured provisioning calls
-- run with normal trigger behavior. The enclosing transaction is rolled back.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r83_user_provisioning_test'
     or current_setting('quiksol.allow_r83_user_provisioning_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_R83_USER_PROVISIONING_TEST_DATABASE';
  end if;

  if pg_catalog.to_regprocedure(
       'public.begin_cli_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.preview_user_provisioning_reconciliation_v1(uuid)'
     ) is null then
    raise exception 'R841_R84_FUNCTIONS_MISSING';
  end if;

  if public.user_provisioning_intent_required_v1() is distinct from true then
    raise exception 'R841_R83B_CUTOVER_NOT_ENABLED';
  end if;

  if pg_catalog.to_regclass('auth.auth_users_provisioning_email_hash_idx') is not null
     or pg_catalog.to_regclass('auth.auth_users_provisioning_user_intent_locator_idx') is not null
     or pg_catalog.to_regclass('auth.auth_users_provisioning_app_intent_locator_idx') is not null then
    raise exception 'R841_CUSTOM_AUTH_USERS_INDEX_STILL_PRESENT';
  end if;
end;
$$;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local request.jwt.claim.role = 'service_role';

create temporary table r841_performance_fixture (
  fixture_name text primary key,
  idempotency_key uuid,
  intent_id uuid,
  auth_user_id uuid,
  email text not null,
  full_name text,
  requested_role text
) on commit drop;

create temporary table r841_performance_samples (
  census_size integer not null,
  scenario text not null,
  iteration integer not null,
  elapsed_ms numeric not null,
  observed_state text not null,
  primary key (census_size, scenario, iteration)
) on commit drop;

insert into r841_performance_fixture (
  fixture_name,
  idempotency_key,
  auth_user_id,
  email,
  full_name,
  requested_role
) values
  (
    'completed_replay',
    '84100000-0000-4000-8100-000000000001',
    '84100000-0000-4000-8200-000000000001',
    'r841-completed-replay@example.invalid',
    'R841 Completed Replay',
    'admin'
  ),
  (
    'targeted_reconciliation',
    '84100000-0000-4000-8100-000000000002',
    '84100000-0000-4000-8200-000000000002',
    'r841-targeted-reconciliation@example.invalid',
    'R841 Targeted Reconciliation',
    'admin'
  ),
  (
    'same_email_163',
    null,
    '84100000-0000-4000-8200-000000000003',
    'r841-same-email-163@example.invalid',
    null,
    null
  ),
  (
    'same_email_5000',
    null,
    '84100000-0000-4000-8200-000000000004',
    'r841-same-email-5000@example.invalid',
    null,
    null
  );

-- Create one normal completed lifecycle and one historical pending lifecycle.
do $$
declare
  fixture r841_performance_fixture%rowtype;
  response jsonb;
begin
  for fixture in
    select *
    from r841_performance_fixture
    where fixture_name in ('completed_replay', 'targeted_reconciliation')
    order by fixture_name
  loop
    response := public.begin_cli_user_provisioning_v2(
      fixture.idempotency_key,
      fixture.email,
      fixture.full_name,
      fixture.requested_role,
      'Performance',
      'Disposable',
      true,
      null,
      'Performance Fixture'
    );

    if response->>'state' <> 'NEW' then
      raise exception 'R841_FIXTURE_BEGIN_NOT_NEW: %', fixture.fixture_name;
    end if;

    update r841_performance_fixture
    set intent_id = (response->>'intent_id')::uuid
    where fixture_name = fixture.fixture_name;
  end loop;
end;
$$;

-- The targeted-reconciliation row represents historical state that predates
-- the atomic trigger. session_replication_role is fixture-only and restored
-- before any measured operation.
set local session_replication_role = replica;

insert into auth.users (
  id,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data
)
select
  fixture.auth_user_id,
  fixture.email,
  pg_catalog.now(),
  '{}'::jsonb,
  pg_catalog.jsonb_build_object(
    'quiksol_provisioning_intent_id',
    fixture.intent_id::text
  )
from r841_performance_fixture fixture
where fixture.fixture_name = 'targeted_reconciliation';

set local session_replication_role = origin;

insert into public.profiles (
  id,
  full_name,
  email,
  role,
  department,
  region,
  bio,
  job_title,
  is_active
)
select
  fixture.auth_user_id,
  fixture.full_name,
  fixture.email,
  fixture.requested_role,
  'Performance',
  'Disposable',
  null,
  'Performance Fixture',
  true
from r841_performance_fixture fixture
where fixture.fixture_name = 'targeted_reconciliation';

-- Normal Auth insert: R8.4 trigger must atomically complete intent + Profile.
insert into auth.users (
  id,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data
)
select
  fixture.auth_user_id,
  fixture.email,
  pg_catalog.now(),
  '{}'::jsonb,
  pg_catalog.jsonb_build_object(
    'quiksol_provisioning_intent_id',
    fixture.intent_id::text
  )
from r841_performance_fixture fixture
where fixture.fixture_name = 'completed_replay';

do $$
declare
  current_auth_count integer;
begin
  select pg_catalog.count(*)::integer into current_auth_count from auth.users;
  if current_auth_count > 162 then
    raise exception 'R841_BASELINE_TOO_LARGE_FOR_163_FIXTURE: %', current_auth_count;
  end if;
end;
$$;

-- Fill to 162, then append the matching Auth row last so the 163-row
-- same-email measurement exercises a complete sequential lookup.
set local session_replication_role = replica;

with required_rows as (
  select (162 - pg_catalog.count(*))::integer as row_count
  from auth.users
)
insert into auth.users (
  id,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data
)
select
  pg_catalog.md5('r841-auth-census-163-' || generated.row_number::text)::uuid,
  'r841-auth-census-163-' || generated.row_number::text || '@example.invalid',
  pg_catalog.now(),
  '{}'::jsonb,
  '{}'::jsonb
from required_rows
cross join lateral pg_catalog.generate_series(1, required_rows.row_count) generated(row_number);

insert into auth.users (
  id,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data
)
select
  fixture.auth_user_id,
  fixture.email,
  pg_catalog.now(),
  '{}'::jsonb,
  '{}'::jsonb
from r841_performance_fixture fixture
where fixture.fixture_name = 'same_email_163';

set local session_replication_role = origin;

analyze auth.users;
analyze public.profiles;
analyze public.user_provisioning_intents;

do $$
begin
  if (select pg_catalog.count(*) from auth.users) <> 163 then
    raise exception 'R841_AUTH_CENSUS_163_NOT_EXACT';
  end if;
  if (
    select classification
    from public.preview_user_provisioning_reconciliation_v1(
      (select intent_id
       from r841_performance_fixture
       where fixture_name = 'targeted_reconciliation')
    )
  ) <> 'PENDING_AUTH_PROFILE_MATCH' then
    raise exception 'R841_TARGETED_RECONCILIATION_FIXTURE_INVALID';
  end if;
end;
$$;

-- Measure the four requested runtime paths against a production-sized census.
do $$
declare
  iteration_number integer;
  started_at timestamptz;
  response jsonb;
  fixture r841_performance_fixture%rowtype;
  classification_result text;
begin
  for iteration_number in 1..20 loop
    started_at := pg_catalog.clock_timestamp();
    response := public.begin_cli_user_provisioning_v2(
      pg_catalog.md5('r841-begin-163-key-' || iteration_number::text)::uuid,
      'r841-begin-163-' || iteration_number::text || '@example.invalid',
      'R841 Begin 163 ' || iteration_number::text,
      'admin',
      'Performance',
      'Disposable',
      true,
      null,
      'Performance Fixture'
    );
    insert into r841_performance_samples values (
      163,
      'begin_v2_new',
      iteration_number,
      extract(epoch from (pg_catalog.clock_timestamp() - started_at)) * 1000,
      response->>'state'
    );
    if response->>'state' <> 'NEW' then
      raise exception 'R841_BEGIN_163_UNEXPECTED_STATE';
    end if;
  end loop;

  select * into fixture
  from r841_performance_fixture
  where fixture_name = 'completed_replay';
  for iteration_number in 1..20 loop
    started_at := pg_catalog.clock_timestamp();
    response := public.begin_cli_user_provisioning_v2(
      fixture.idempotency_key,
      fixture.email,
      fixture.full_name,
      fixture.requested_role,
      'Performance',
      'Disposable',
      true,
      null,
      'Performance Fixture'
    );
    insert into r841_performance_samples values (
      163,
      'completed_replay',
      iteration_number,
      extract(epoch from (pg_catalog.clock_timestamp() - started_at)) * 1000,
      response->>'state'
    );
    if response->>'state' <> 'EXISTING_COMPLETED'
       or (response->>'auth_user_id')::uuid is distinct from fixture.auth_user_id then
      raise exception 'R841_REPLAY_163_UNEXPECTED_STATE';
    end if;
  end loop;

  select * into fixture
  from r841_performance_fixture
  where fixture_name = 'same_email_163';
  for iteration_number in 1..20 loop
    started_at := pg_catalog.clock_timestamp();
    begin
      perform public.begin_cli_user_provisioning_v2(
        pg_catalog.md5('r841-defense-163-key-' || iteration_number::text)::uuid,
        fixture.email,
        'R841 Same Email 163',
        'admin',
        null,
        null,
        true,
        null,
        null
      );
      raise exception 'R841_SAME_EMAIL_163_ACCEPTED';
    exception
      when sqlstate 'QS842' then
        insert into r841_performance_samples values (
          163,
          'same_email_defense',
          iteration_number,
          extract(epoch from (pg_catalog.clock_timestamp() - started_at)) * 1000,
          'QS842'
        );
    end;
  end loop;

  select * into fixture
  from r841_performance_fixture
  where fixture_name = 'targeted_reconciliation';
  for iteration_number in 1..20 loop
    started_at := pg_catalog.clock_timestamp();
    select preview.classification
    into classification_result
    from public.preview_user_provisioning_reconciliation_v1(fixture.intent_id) preview;
    insert into r841_performance_samples values (
      163,
      'targeted_reconciliation',
      iteration_number,
      extract(epoch from (pg_catalog.clock_timestamp() - started_at)) * 1000,
      classification_result
    );
    if classification_result <> 'PENDING_AUTH_PROFILE_MATCH' then
      raise exception 'R841_RECONCILIATION_163_UNEXPECTED_STATE';
    end if;
  end loop;
end;
$$;

select 'R841_PLAN_163_BEGIN_V2_KEY_LOOKUP' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select intent.id, intent.status
from public.user_provisioning_intents intent
where intent.idempotency_key = (
  select fixture.idempotency_key
  from r841_performance_fixture fixture
  where fixture.fixture_name = 'completed_replay'
)
for update;

select 'R841_PLAN_163_COMPLETED_REPLAY' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select exists (
  select 1
  from public.user_provisioning_intents intent
  join auth.users auth_user on auth_user.id = intent.auth_user_id
  join public.profiles profile on profile.id = auth_user.id
  where intent.idempotency_key = (
    select fixture.idempotency_key
    from r841_performance_fixture fixture
    where fixture.fixture_name = 'completed_replay'
  )
    and extensions.digest(
      pg_catalog.lower(pg_catalog.btrim(auth_user.email)),
      'sha256'
    ) = intent.requested_email_hash
    and pg_catalog.lower(pg_catalog.btrim(profile.email)) =
        pg_catalog.lower(pg_catalog.btrim(auth_user.email))
);

select 'R841_PLAN_163_SAME_EMAIL_DEFENSE' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select auth_user.id
from auth.users auth_user
where auth_user.email is not null
  and extensions.digest(
    pg_catalog.lower(pg_catalog.btrim(auth_user.email)),
    'sha256'
  ) = extensions.digest('r841-same-email-163@example.invalid', 'sha256');

select 'R841_PLAN_163_TARGETED_LOCATOR' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select auth_user.id
from auth.users auth_user
where nullif(
    pg_catalog.btrim(auth_user.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  ) = (
    select fixture.intent_id::text
    from r841_performance_fixture fixture
    where fixture.fixture_name = 'targeted_reconciliation'
  )
   or nullif(
    pg_catalog.btrim(auth_user.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  ) = (
    select fixture.intent_id::text
    from r841_performance_fixture fixture
    where fixture.fixture_name = 'targeted_reconciliation'
  );

select 'R841_PLAN_163_TARGETED_RECONCILIATION_RPC' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select preview.*
from public.preview_user_provisioning_reconciliation_v1(
  (select fixture.intent_id
   from r841_performance_fixture fixture
   where fixture.fixture_name = 'targeted_reconciliation')
) preview;

-- Grow the same transaction to a reasonable 5,000-row Auth census. The
-- matching same-email row is again physically appended last.
set local session_replication_role = replica;

with required_rows as (
  select (4999 - pg_catalog.count(*))::integer as row_count
  from auth.users
)
insert into auth.users (
  id,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data
)
select
  pg_catalog.md5('r841-auth-census-5000-' || generated.row_number::text)::uuid,
  'r841-auth-census-5000-' || generated.row_number::text || '@example.invalid',
  pg_catalog.now(),
  '{}'::jsonb,
  '{}'::jsonb
from required_rows
cross join lateral pg_catalog.generate_series(1, required_rows.row_count) generated(row_number);

insert into auth.users (
  id,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data
)
select
  fixture.auth_user_id,
  fixture.email,
  pg_catalog.now(),
  '{}'::jsonb,
  '{}'::jsonb
from r841_performance_fixture fixture
where fixture.fixture_name = 'same_email_5000';

-- Also give the public idempotency table enough rows for the default planner
-- to demonstrate its owned key/email indexes. These are synthetic pending
-- lifecycle records, never Auth identities, and remain inside the rollback.
insert into public.user_provisioning_intents (
  id,
  source,
  actor_profile_id,
  requested_email_hash,
  requested_role,
  requested_full_name,
  requested_department,
  requested_region,
  requested_is_active,
  requested_bio,
  requested_job_title,
  idempotency_key,
  request_fingerprint,
  fingerprint_version,
  attempt_count,
  last_attempt_at
)
select
  pg_catalog.md5('r841-intent-census-id-' || generated.row_number::text)::uuid,
  'provision_admin_cli',
  null,
  extensions.digest(
    'r841-intent-census-' || generated.row_number::text || '@example.invalid',
    'sha256'
  ),
  'admin',
  'R841 Intent Census ' || generated.row_number::text,
  null,
  null,
  true,
  null,
  null,
  pg_catalog.md5('r841-intent-census-key-' || generated.row_number::text)::uuid,
  extensions.digest(
    'quiksol:r841:performance-fingerprint:' || generated.row_number::text,
    'sha256'
  ),
  1,
  1,
  pg_catalog.clock_timestamp()
from pg_catalog.generate_series(1, 5000) generated(row_number);

set local session_replication_role = origin;

analyze auth.users;
analyze public.profiles;
analyze public.user_provisioning_intents;

do $$
begin
  if (select pg_catalog.count(*) from auth.users) <> 5000 then
    raise exception 'R841_AUTH_CENSUS_5000_NOT_EXACT';
  end if;
end;
$$;

do $$
declare
  iteration_number integer;
  started_at timestamptz;
  response jsonb;
  fixture r841_performance_fixture%rowtype;
  classification_result text;
begin
  for iteration_number in 1..20 loop
    started_at := pg_catalog.clock_timestamp();
    response := public.begin_cli_user_provisioning_v2(
      pg_catalog.md5('r841-begin-5000-key-' || iteration_number::text)::uuid,
      'r841-begin-5000-' || iteration_number::text || '@example.invalid',
      'R841 Begin 5000 ' || iteration_number::text,
      'admin',
      'Performance',
      'Disposable',
      true,
      null,
      'Performance Fixture'
    );
    insert into r841_performance_samples values (
      5000,
      'begin_v2_new',
      iteration_number,
      extract(epoch from (pg_catalog.clock_timestamp() - started_at)) * 1000,
      response->>'state'
    );
    if response->>'state' <> 'NEW' then
      raise exception 'R841_BEGIN_5000_UNEXPECTED_STATE';
    end if;
  end loop;

  select * into fixture
  from r841_performance_fixture
  where fixture_name = 'completed_replay';
  for iteration_number in 1..20 loop
    started_at := pg_catalog.clock_timestamp();
    response := public.begin_cli_user_provisioning_v2(
      fixture.idempotency_key,
      fixture.email,
      fixture.full_name,
      fixture.requested_role,
      'Performance',
      'Disposable',
      true,
      null,
      'Performance Fixture'
    );
    insert into r841_performance_samples values (
      5000,
      'completed_replay',
      iteration_number,
      extract(epoch from (pg_catalog.clock_timestamp() - started_at)) * 1000,
      response->>'state'
    );
    if response->>'state' <> 'EXISTING_COMPLETED'
       or (response->>'auth_user_id')::uuid is distinct from fixture.auth_user_id then
      raise exception 'R841_REPLAY_5000_UNEXPECTED_STATE';
    end if;
  end loop;

  select * into fixture
  from r841_performance_fixture
  where fixture_name = 'same_email_5000';
  for iteration_number in 1..20 loop
    started_at := pg_catalog.clock_timestamp();
    begin
      perform public.begin_cli_user_provisioning_v2(
        pg_catalog.md5('r841-defense-5000-key-' || iteration_number::text)::uuid,
        fixture.email,
        'R841 Same Email 5000',
        'admin',
        null,
        null,
        true,
        null,
        null
      );
      raise exception 'R841_SAME_EMAIL_5000_ACCEPTED';
    exception
      when sqlstate 'QS842' then
        insert into r841_performance_samples values (
          5000,
          'same_email_defense',
          iteration_number,
          extract(epoch from (pg_catalog.clock_timestamp() - started_at)) * 1000,
          'QS842'
        );
    end;
  end loop;

  select * into fixture
  from r841_performance_fixture
  where fixture_name = 'targeted_reconciliation';
  for iteration_number in 1..20 loop
    started_at := pg_catalog.clock_timestamp();
    select preview.classification
    into classification_result
    from public.preview_user_provisioning_reconciliation_v1(fixture.intent_id) preview;
    insert into r841_performance_samples values (
      5000,
      'targeted_reconciliation',
      iteration_number,
      extract(epoch from (pg_catalog.clock_timestamp() - started_at)) * 1000,
      classification_result
    );
    if classification_result <> 'PENDING_AUTH_PROFILE_MATCH' then
      raise exception 'R841_RECONCILIATION_5000_UNEXPECTED_STATE';
    end if;
  end loop;
end;
$$;

select 'R841_PLAN_5000_BEGIN_V2_KEY_LOOKUP' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select intent.id, intent.status
from public.user_provisioning_intents intent
where intent.idempotency_key = (
  select fixture.idempotency_key
  from r841_performance_fixture fixture
  where fixture.fixture_name = 'completed_replay'
)
for update;

select 'R841_PLAN_5000_COMPLETED_REPLAY' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select exists (
  select 1
  from public.user_provisioning_intents intent
  join auth.users auth_user on auth_user.id = intent.auth_user_id
  join public.profiles profile on profile.id = auth_user.id
  where intent.idempotency_key = (
    select fixture.idempotency_key
    from r841_performance_fixture fixture
    where fixture.fixture_name = 'completed_replay'
  )
    and extensions.digest(
      pg_catalog.lower(pg_catalog.btrim(auth_user.email)),
      'sha256'
    ) = intent.requested_email_hash
    and pg_catalog.lower(pg_catalog.btrim(profile.email)) =
        pg_catalog.lower(pg_catalog.btrim(auth_user.email))
);

select 'R841_PLAN_5000_SAME_EMAIL_DEFENSE' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select auth_user.id
from auth.users auth_user
where auth_user.email is not null
  and extensions.digest(
    pg_catalog.lower(pg_catalog.btrim(auth_user.email)),
    'sha256'
  ) = extensions.digest('r841-same-email-5000@example.invalid', 'sha256');

select 'R841_PLAN_5000_TARGETED_LOCATOR' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select auth_user.id
from auth.users auth_user
where nullif(
    pg_catalog.btrim(auth_user.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  ) = (
    select fixture.intent_id::text
    from r841_performance_fixture fixture
    where fixture.fixture_name = 'targeted_reconciliation'
  )
   or nullif(
    pg_catalog.btrim(auth_user.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  ) = (
    select fixture.intent_id::text
    from r841_performance_fixture fixture
    where fixture.fixture_name = 'targeted_reconciliation'
  );

select 'R841_PLAN_5000_TARGETED_RECONCILIATION_RPC' as plan_label;
explain (analyze, buffers, timing, summary, costs off)
select preview.*
from public.preview_user_provisioning_reconciliation_v1(
  (select fixture.intent_id
   from r841_performance_fixture fixture
   where fixture.fixture_name = 'targeted_reconciliation')
) preview;

do $$
declare
  small_average numeric;
  large_average numeric;
  large_maximum numeric;
begin
  if exists (
    select 1
    from r841_performance_samples sample
    where (sample.scenario = 'begin_v2_new' and sample.observed_state <> 'NEW')
       or (sample.scenario = 'completed_replay' and sample.observed_state <> 'EXISTING_COMPLETED')
       or (sample.scenario = 'same_email_defense' and sample.observed_state <> 'QS842')
       or (sample.scenario = 'targeted_reconciliation'
           and sample.observed_state <> 'PENDING_AUTH_PROFILE_MATCH')
  ) then
    raise exception 'R841_PERFORMANCE_SCENARIO_STATE_MISMATCH';
  end if;

  if (select pg_catalog.count(*) from r841_performance_samples) <> 160 then
    raise exception 'R841_PERFORMANCE_SAMPLE_COUNT_MISMATCH';
  end if;

  select pg_catalog.avg(elapsed_ms)
  into small_average
  from r841_performance_samples
  where census_size = 163;

  select pg_catalog.avg(elapsed_ms), pg_catalog.max(elapsed_ms)
  into large_average, large_maximum
  from r841_performance_samples
  where census_size = 5000;

  -- A one-second average or five-second individual operation at only 5,000
  -- Auth rows is an intentionally generous signal of absurd degradation, not
  -- a microbenchmark SLA.
  if small_average >= 500
     or large_average >= 1000
     or large_maximum >= 5000 then
    raise exception using
      message = 'R841_PERFORMANCE_SANITY_LIMIT_EXCEEDED',
      detail = pg_catalog.format(
        'small_avg_ms=%s large_avg_ms=%s large_max_ms=%s',
        small_average,
        large_average,
        large_maximum
      );
  end if;

  if pg_catalog.to_regclass('public.user_provisioning_intents_idempotency_uidx') is null
     or pg_catalog.to_regclass('public.user_provisioning_intents_r84_email_uidx') is null
     or pg_catalog.to_regclass('public.user_provisioning_intents_email_hash_idx') is null
     or pg_catalog.to_regclass('public.profiles_provisioning_email_hash_idx') is null then
    raise exception 'R841_PUBLIC_HOT_PATH_INDEX_MISSING';
  end if;
end;
$$;

select
  sample.census_size,
  sample.scenario,
  pg_catalog.count(*)::integer as samples,
  pg_catalog.round(pg_catalog.avg(sample.elapsed_ms), 3) as avg_ms,
  pg_catalog.round(pg_catalog.min(sample.elapsed_ms), 3) as min_ms,
  pg_catalog.round(pg_catalog.max(sample.elapsed_ms), 3) as max_ms,
  pg_catalog.array_agg(distinct sample.observed_state order by sample.observed_state) as states
from r841_performance_samples sample
group by sample.census_size, sample.scenario
order by sample.census_size, sample.scenario;

select
  index_name.indexname as auth_users_index_present
from pg_catalog.pg_indexes index_name
where index_name.schemaname = 'auth'
  and index_name.tablename = 'users'
order by index_name.indexname;

select
  (select pg_catalog.count(*) from auth.users) as final_fixture_auth_users,
  (select pg_catalog.count(*)
   from public.user_provisioning_intents
   where idempotency_key is not null) as idempotent_intents_during_fixture,
  public.user_provisioning_intent_required_v1() as r83b_gate_enabled;

rollback;

do $$
begin
  if exists (
    select 1
    from auth.users auth_user
    where auth_user.email like 'r841-%@example.invalid'
  ) or exists (
    select 1
    from public.user_provisioning_intents intent
    where intent.idempotency_key in (
      '84100000-0000-4000-8100-000000000001',
      '84100000-0000-4000-8100-000000000002'
    )
  ) then
    raise exception 'R841_PERFORMANCE_TRANSACTION_NOT_ROLLED_BACK';
  end if;
end;
$$;

select 'USER_PROVISIONING_R841_PERFORMANCE_PASS' as result;
