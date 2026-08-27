-- Sequential real-PostgreSQL atomicity, authorization, ACL and diagnostics
-- proof. Run after the complete migration chain and the R8.3 cutover runtime.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r83_user_provisioning_test'
     or current_setting('quiksol.allow_r83_user_provisioning_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_R83_USER_PROVISIONING_TEST_DATABASE';
  end if;
  if public.user_provisioning_intent_required_v1() is distinct from true then
    raise exception 'R83B_REQUIRED_FOR_ATOMICITY_PROOF';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = '83000000-0000-4000-8000-000000000001'
      and role = 'super_admin_dev'
      and is_active is true
  ) then
    raise exception 'R83_TEST_ACTOR_MISSING';
  end if;
end;
$$;

do $$
declare
  success_intent uuid;
  failure_intent uuid;
  mismatch_intent uuid;
  app_only_intent uuid;
  reused_rejected boolean := false;
  missing_rejected boolean := false;
  app_only_rejected boolean := false;
  invalid_rejected boolean := false;
  nonexistent_rejected boolean := false;
  mismatch_rejected boolean := false;
  profile_failure_rejected boolean := false;
  unauthorized_role_rejected boolean := false;
  invalid_role_rejected boolean := false;
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    '83000000-0000-4000-8000-000000000001',
    false
  );
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

  -- Success and metadata tampering: only the durable intent is authoritative.
  success_intent := public.create_user_provisioning_intent_v1(
    'r83_success@example.invalid',
    'R83 Success',
    'employee',
    'Final Department',
    'Final Region',
    false,
    'Final Bio',
    'Final Job'
  );
  insert into auth.users (
    id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
  ) values (
    '83000000-0000-4000-8000-000000000020',
    'R83_SUCCESS@EXAMPLE.INVALID',
    pg_catalog.now(),
    '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'quiksol_provisioning_intent_id', success_intent,
      'full_name', 'tampered',
      'role', 'super_admin_dev',
      'is_active', true,
      'department', 'evil',
      'region', 'evil',
      'permissions', pg_catalog.jsonb_build_array('SUPERADMIN'),
      'source', 'evil',
      'actor', 'evil'
    )
  );

  if not exists (
    select 1
    from public.profiles profile
    join public.user_provisioning_intents intent on intent.auth_user_id = profile.id
    where profile.id = '83000000-0000-4000-8000-000000000020'
      and profile.full_name = 'R83 Success'
      and profile.email = 'r83_success@example.invalid'
      and profile.role = 'employee'
      and profile.department = 'Final Department'
      and profile.region = 'Final Region'
      and profile.bio = 'Final Bio'
      and profile.job_title = 'Final Job'
      and profile.is_active is false
      and intent.id = success_intent
      and intent.status = 'completed'
      and intent.completed_at is not null
  ) then
    raise exception 'R83_SUCCESS_FINAL_STATE_INVALID';
  end if;

  -- Reuse must lose without leaving the second Auth or Profile row.
  begin
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
    values (
      '83000000-0000-4000-8000-000000000021',
      'r83_success@example.invalid',
      pg_catalog.now(),
      pg_catalog.jsonb_build_object('quiksol_provisioning_intent_id', success_intent)
    );
  exception when sqlstate 'QS834' then
    reused_rejected := true;
  end;

  -- Missing, malformed and nonexistent intent identifiers all fail closed.
  begin
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
    values (
      '83000000-0000-4000-8000-000000000022',
      'r83_missing@example.invalid',
      pg_catalog.now(),
      '{}'::jsonb
    );
  exception when sqlstate 'QS831' then
    missing_rejected := true;
  end;

  -- A locator that exists only in app metadata is too late for the INSERT
  -- contract and must not be used by the hotfixed trigger.
  app_only_intent := public.create_user_provisioning_intent_v1(
    'r83_app_only@example.invalid', 'App Only', 'employee', null, null, true, null, null
  );
  begin
    insert into auth.users (
      id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
    ) values (
      '83000000-0000-4000-8000-000000000027',
      'r83_app_only@example.invalid',
      pg_catalog.now(),
      pg_catalog.jsonb_build_object('quiksol_provisioning_intent_id', app_only_intent),
      '{}'::jsonb
    );
  exception when sqlstate 'QS831' then
    app_only_rejected := true;
  end;

  if not app_only_rejected
     or not exists (
       select 1 from public.user_provisioning_intents
       where id = app_only_intent and status = 'pending' and auth_user_id is null
     ) then
    raise exception 'R831_APP_METADATA_DEPENDENCY_REMAINS';
  end if;

  begin
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
    values (
      '83000000-0000-4000-8000-000000000023',
      'r83_invalid@example.invalid',
      pg_catalog.now(),
      '{"quiksol_provisioning_intent_id":"not-a-uuid"}'::jsonb
    );
  exception when sqlstate 'QS832' then
    invalid_rejected := true;
  end;

  begin
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
    values (
      '83000000-0000-4000-8000-000000000024',
      'r83_nonexistent@example.invalid',
      pg_catalog.now(),
      '{"quiksol_provisioning_intent_id":"83000000-0000-4000-8000-000000009999"}'::jsonb
    );
  exception when sqlstate 'QS833' then
    nonexistent_rejected := true;
  end;

  mismatch_intent := public.create_user_provisioning_intent_v1(
    'r83_expected@example.invalid', 'Mismatch', 'employee', null, null, true, null, null
  );
  begin
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
    values (
      '83000000-0000-4000-8000-000000000025',
      'r83_actual@example.invalid',
      pg_catalog.now(),
      pg_catalog.jsonb_build_object('quiksol_provisioning_intent_id', mismatch_intent)
    );
  exception when sqlstate 'QS835' then
    mismatch_rejected := true;
  end;

  if not mismatch_rejected
     or not exists (
       select 1 from public.user_provisioning_intents
       where id = mismatch_intent and status = 'pending' and auth_user_id is null
     ) then
    raise exception 'R83_EMAIL_MISMATCH_NOT_ATOMIC';
  end if;

  -- Force the Profile write to fail after the Auth row exists in the current
  -- statement. The trigger transaction must roll back Auth and completion.
  alter table public.profiles
    add constraint r83_test_forced_profile_failure
    check (full_name <> 'R83_FORCE_PROFILE_FAILURE') not valid;

  failure_intent := public.create_user_provisioning_intent_v1(
    'r83_profile_failure@example.invalid',
    'R83_FORCE_PROFILE_FAILURE',
    'employee',
    null,
    null,
    true,
    null,
    null
  );
  begin
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
    values (
      '83000000-0000-4000-8000-000000000026',
      'r83_profile_failure@example.invalid',
      pg_catalog.now(),
      pg_catalog.jsonb_build_object('quiksol_provisioning_intent_id', failure_intent)
    );
  exception when check_violation then
    profile_failure_rejected := true;
  end;

  alter table public.profiles drop constraint r83_test_forced_profile_failure;

  if not profile_failure_rejected
     or exists (select 1 from auth.users where id = '83000000-0000-4000-8000-000000000026')
     or exists (select 1 from public.profiles where id = '83000000-0000-4000-8000-000000000026')
     or not exists (
       select 1 from public.user_provisioning_intents
       where id = failure_intent and status = 'pending' and auth_user_id is null
     ) then
    raise exception 'R83_PROFILE_FAILURE_NOT_ATOMIC';
  end if;

  -- A normal admin may not mint a Super Admin Dev intent.
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    '83000000-0000-4000-8000-000000000012',
    false
  );
  begin
    perform public.create_user_provisioning_intent_v1(
      'r83_unauthorized_role@example.invalid',
      'Unauthorized Role',
      'super_admin_dev',
      null,
      null,
      true,
      null,
      null
    );
  exception when insufficient_privilege then
    unauthorized_role_rejected := true;
  end;

  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    '83000000-0000-4000-8000-000000000001',
    false
  );
  begin
    perform public.create_user_provisioning_intent_v1(
      'r83_invalid_role@example.invalid',
      'Invalid Role',
      'root',
      null,
      null,
      true,
      null,
      null
    );
  exception when invalid_parameter_value then
    invalid_role_rejected := true;
  end;

  if not reused_rejected
     or not missing_rejected
     or not app_only_rejected
     or not invalid_rejected
     or not nonexistent_rejected
     or not mismatch_rejected
     or not profile_failure_rejected
     or not unauthorized_role_rejected
     or not invalid_role_rejected then
    raise exception 'R83_REQUIRED_REJECTION_CASE_MISSING';
  end if;

  if exists (
    select 1 from auth.users
    where id in (
      '83000000-0000-4000-8000-000000000021',
      '83000000-0000-4000-8000-000000000022',
      '83000000-0000-4000-8000-000000000023',
      '83000000-0000-4000-8000-000000000024',
      '83000000-0000-4000-8000-000000000025',
      '83000000-0000-4000-8000-000000000026',
      '83000000-0000-4000-8000-000000000027'
    )
  ) then
    raise exception 'R83_REJECTED_AUTH_ROW_PERSISTED';
  end if;
end;
$$;

-- Validate actor state at intent creation: inactive, banned and unconfirmed
-- administrators cannot mint durable authorization.
do $$
declare
  actor_id uuid;
  actor_email text;
  actor_state text;
  seed_intent uuid;
  rejected boolean;
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    '83000000-0000-4000-8000-000000000001',
    false
  );

  for actor_id, actor_email, actor_state in values
    ('83000000-0000-4000-8000-000000000030'::uuid, 'r83_inactive_actor@example.invalid', 'inactive'),
    ('83000000-0000-4000-8000-000000000031'::uuid, 'r83_banned_actor@example.invalid', 'banned'),
    ('83000000-0000-4000-8000-000000000032'::uuid, 'r83_unconfirmed_actor@example.invalid', 'unconfirmed')
  loop
    seed_intent := public.create_user_provisioning_intent_v1(
      actor_email, 'Invalid Actor State', 'admin', null, null, true, null, null
    );
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
    values (
      actor_id,
      actor_email,
      pg_catalog.now(),
      pg_catalog.jsonb_build_object('quiksol_provisioning_intent_id', seed_intent)
    );

    if actor_state = 'inactive' then
      update public.profiles set is_active = false where id = actor_id;
    elsif actor_state = 'banned' then
      update auth.users set banned_until = pg_catalog.now() + interval '1 day' where id = actor_id;
    else
      update auth.users set email_confirmed_at = null where id = actor_id;
    end if;

    perform pg_catalog.set_config('request.jwt.claim.sub', actor_id::text, false);
    rejected := false;
    begin
      perform public.create_user_provisioning_intent_v1(
        'r83_actor_recheck_target@example.invalid',
        'Actor Recheck Target',
        'employee',
        null,
        null,
        true,
        null,
        null
      );
    exception when insufficient_privilege then
      rejected := true;
    end;
    if not rejected then
      raise exception 'R83_INVALID_ACTOR_STATE_ACCEPTED:%', actor_state;
    end if;

    perform pg_catalog.set_config(
      'request.jwt.claim.sub',
      '83000000-0000-4000-8000-000000000001',
      false
    );
  end loop;
end;
$$;

-- Small local performance sample: authorization/intent creation separately
-- from the Auth INSERT that executes lookup + Profile insert + completion.
create temporary table r83_provisioning_performance (
  iteration integer primary key,
  intent_create_ms numeric not null,
  auth_trigger_ms numeric not null
) on commit preserve rows;

do $$
declare
  iteration_number integer;
  target_user_id uuid;
  target_email text;
  target_intent_id uuid;
  started_at timestamptz;
  intent_elapsed_ms numeric;
  trigger_elapsed_ms numeric;
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    '83000000-0000-4000-8000-000000000001',
    false
  );
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

  for iteration_number in 1..20 loop
    target_user_id := (
      '83000000-0000-4000-8003-'
      || pg_catalog.lpad(iteration_number::text, 12, '0')
    )::uuid;
    target_email := pg_catalog.format(
      'r83_performance_%s@example.invalid',
      iteration_number
    );

    started_at := pg_catalog.clock_timestamp();
    target_intent_id := public.create_user_provisioning_intent_v1(
      target_email,
      pg_catalog.format('R83 Performance %s', iteration_number),
      'employee',
      'Performance',
      'Test',
      true,
      null,
      null
    );
    intent_elapsed_ms := extract(
      epoch from pg_catalog.clock_timestamp() - started_at
    ) * 1000;

    started_at := pg_catalog.clock_timestamp();
    insert into auth.users (
      id, email, email_confirmed_at, raw_user_meta_data
    ) values (
      target_user_id,
      target_email,
      pg_catalog.now(),
      pg_catalog.jsonb_build_object(
        'quiksol_provisioning_intent_id',
        target_intent_id
      )
    );
    trigger_elapsed_ms := extract(
      epoch from pg_catalog.clock_timestamp() - started_at
    ) * 1000;

    insert into r83_provisioning_performance (
      iteration, intent_create_ms, auth_trigger_ms
    ) values (
      iteration_number, intent_elapsed_ms, trigger_elapsed_ms
    );
  end loop;
end;
$$;

select
  count(*) as iterations,
  pg_catalog.round(avg(intent_create_ms), 3) as intent_create_avg_ms,
  pg_catalog.round(max(intent_create_ms), 3) as intent_create_max_ms,
  pg_catalog.round(avg(auth_trigger_ms), 3) as auth_trigger_avg_ms,
  pg_catalog.round(max(auth_trigger_ms), 3) as auth_trigger_max_ms
from r83_provisioning_performance;

do $$
declare
  unclassified_count bigint;
begin
  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'public.user_provisioning_intents'::regclass) then
    raise exception 'R83_INTENT_RLS_DISABLED';
  end if;
  if exists (
    select 1
    from (values ('anon'), ('authenticated'), ('service_role')) as role_name(name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as privilege_name(name)
    where pg_catalog.has_table_privilege(
      role_name.name,
      'public.user_provisioning_intents',
      privilege_name.name
    )
  ) then
    raise exception 'R83_INTENT_DIRECT_TABLE_PRIVILEGE_EXPOSED';
  end if;
  if (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'user_provisioning_intents') <> 0 then
    raise exception 'R83_INTENT_POLICY_EXPOSED';
  end if;
  if pg_catalog.has_function_privilege('anon', 'public.create_user_provisioning_intent_v1(text,text,text,text,text,boolean,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.create_cli_user_provisioning_intent_v1(text,text,text,text,text,boolean,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.create_cli_user_provisioning_intent_v1(text,text,text,text,text,boolean,text,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.create_user_provisioning_intent_v1(text,text,text,text,text,boolean,text,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.create_cli_user_provisioning_intent_v1(text,text,text,text,text,boolean,text,text)', 'EXECUTE') then
    raise exception 'R83_INTENT_FUNCTION_ACL_INVALID';
  end if;
  if not exists (
    select 1 from public.database_safety_table_catalog_v2()
    where schema_name = 'public'
      and table_name = 'user_provisioning_intents'
      and category = 'AUTH_IDENTITY'
      and planned_action = 'PRESERVE'
      and delete_order is null
  ) then
    raise exception 'R83_DATABASE_SAFETY_CLASSIFICATION_INVALID';
  end if;

  select count(*)
  into unclassified_count
  from pg_catalog.pg_tables table_info
  left join public.database_safety_table_catalog_v2() catalog
    on catalog.schema_name = table_info.schemaname
   and catalog.table_name = table_info.tablename
  where table_info.schemaname = 'public'
    and catalog.table_name is null;

  if unclassified_count <> 0 then
    raise exception 'R83_DATABASE_SAFETY_UNCLASSIFIED_PUBLIC_TABLES:%', unclassified_count;
  end if;
end;
$$;

select
  count(*) filter (where auth_user.id is not null and profile.id is null) as auth_without_profile,
  count(*) filter (where auth_user.id is null and profile.id is not null) as profile_without_auth,
  count(*) filter (
    where auth_user.id is not null
      and profile.id is not null
      and pg_catalog.lower(pg_catalog.btrim(auth_user.email))
        is distinct from pg_catalog.lower(pg_catalog.btrim(profile.email))
  ) as email_mismatches
from auth.users auth_user
full join public.profiles profile on profile.id = auth_user.id
where coalesce(auth_user.email, profile.email, '') like 'r83_%@example.invalid';

do $$
declare
  auth_without_profile bigint;
  profile_without_auth bigint;
  email_mismatches bigint;
begin
  select
    count(*) filter (where auth_user.id is not null and profile.id is null),
    count(*) filter (where auth_user.id is null and profile.id is not null),
    count(*) filter (
      where auth_user.id is not null
        and profile.id is not null
        and pg_catalog.lower(pg_catalog.btrim(auth_user.email))
          is distinct from pg_catalog.lower(pg_catalog.btrim(profile.email))
    )
  into auth_without_profile, profile_without_auth, email_mismatches
  from auth.users auth_user
  full join public.profiles profile on profile.id = auth_user.id
  where coalesce(auth_user.email, profile.email, '') like 'r83_%@example.invalid';

  if auth_without_profile <> 0 or profile_without_auth <> 0 or email_mismatches <> 0 then
    raise exception 'R83_NEW_FIXTURE_DIAGNOSTIC_NONZERO:%:%:%', auth_without_profile, profile_without_auth, email_mismatches;
  end if;
end;
$$;

explain (analyze, buffers)
select status, requested_role, auth_user_id
from public.user_provisioning_intents
where id = (
  select id from public.user_provisioning_intents order by created_at limit 1
);

select 'USER_PROVISIONING_R83_ATOMICITY_PASS' as result,
  (select count(*) from public.user_provisioning_intents where status = 'completed') as completed,
  (select count(*) from public.user_provisioning_intents where status = 'pending') as pending_failure_evidence;
