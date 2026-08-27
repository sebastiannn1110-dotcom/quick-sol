-- Sequential runtime, direct-write backstop, compatibility and ACL checks for
-- R8.2. Run only after the complete migration chain in the disposable R8.2 DB.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r82_admin_invariant_test'
     or current_setting('quiksol.allow_r82_admin_invariant_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_R82_ADMIN_INVARIANT_TEST_DATABASE';
  end if;
end;
$$;

begin;

-- Fixture construction only: bypass Auth/profile onboarding triggers so the
-- hard-delete case is not preempted by unrelated personal-tenant foreign keys.
-- All mutations under test run after replication role returns to origin.
set local session_replication_role = replica;

insert into auth.users (
  id,
  email,
  email_confirmed_at,
  banned_until,
  raw_user_meta_data
) values
  (
    '82000000-0000-4000-8000-000000000101',
    'r82-primary-admin@example.invalid',
    pg_catalog.now(),
    null,
    '{"full_name":"R82 Primary Admin"}'::jsonb
  ),
  (
    '82000000-0000-4000-8000-000000000102',
    'r82-secondary-admin@example.invalid',
    pg_catalog.now(),
    null,
    '{"full_name":"R82 Secondary Admin"}'::jsonb
  ),
  (
    '82000000-0000-4000-8000-000000000103',
    'r82-banned-admin@example.invalid',
    pg_catalog.now(),
    pg_catalog.now() + interval '1 day',
    '{"full_name":"R82 Banned Admin"}'::jsonb
  ),
  (
    '82000000-0000-4000-8000-000000000104',
    'r82-unconfirmed-admin@example.invalid',
    null,
    null,
    '{"full_name":"R82 Unconfirmed Admin"}'::jsonb
  ),
  (
    '82000000-0000-4000-8000-000000000105',
    'r82-inactive-admin@example.invalid',
    pg_catalog.now(),
    null,
    '{"full_name":"R82 Inactive Admin"}'::jsonb
  ),
  (
    '82000000-0000-4000-8000-000000000106',
    'r82-employee@example.invalid',
    pg_catalog.now(),
    null,
    '{"full_name":"R82 Employee"}'::jsonb
  ),
  (
    '82000000-0000-4000-8000-000000000107',
    'r82-extra-employee@example.invalid',
    pg_catalog.now(),
    null,
    '{"full_name":"R82 Extra Employee"}'::jsonb
  );

insert into public.profiles (
  id,
  full_name,
  email,
  role,
  is_active
)
select
  auth_user.id,
  auth_user.raw_user_meta_data->>'full_name',
  auth_user.email,
  'employee',
  true
from auth.users auth_user
where auth_user.id between
  '82000000-0000-4000-8000-000000000101'::uuid
  and '82000000-0000-4000-8000-000000000107'::uuid;

set local session_replication_role = origin;

-- Trusted fixture setup. Only the primary account is effective: the banned,
-- unconfirmed and inactive profiles intentionally look administrative.
update public.profiles
set role = case id
      when '82000000-0000-4000-8000-000000000101'::uuid then 'admin'
      when '82000000-0000-4000-8000-000000000103'::uuid then 'admin'
      when '82000000-0000-4000-8000-000000000104'::uuid then 'admin'
      when '82000000-0000-4000-8000-000000000105'::uuid then 'admin'
      else 'employee'
    end,
    is_active = id <> '82000000-0000-4000-8000-000000000105'::uuid
where id between
  '82000000-0000-4000-8000-000000000101'::uuid
  and '82000000-0000-4000-8000-000000000107'::uuid;

do $$
begin
  if public.effective_admin_count_v1() <> 1 then
    raise exception 'R82_EFFECTIVE_ADMIN_DEFINITION_FAILED:%',
      public.effective_admin_count_v1();
  end if;
end;
$$;

-- An expired ban is usable, while a current ban is not.
update auth.users
set banned_until = pg_catalog.now() - interval '1 second'
where id = '82000000-0000-4000-8000-000000000103';

do $$
begin
  if public.effective_admin_count_v1() <> 2 then
    raise exception 'R82_EXPIRED_BAN_NOT_COUNTED';
  end if;
end;
$$;

update auth.users
set banned_until = pg_catalog.now() + interval '1 day'
where id = '82000000-0000-4000-8000-000000000103';

-- Direct elevated writes cannot remove the only effective administrator.
do $$
declare
  rejected boolean := false;
begin
  begin
    update public.profiles
    set role = 'employee'
    where id = '82000000-0000-4000-8000-000000000101';
    set constraints
      profiles_effective_admin_validate_update_v1,
      profiles_effective_admin_validate_delete_v1 immediate;
  exception when sqlstate 'QS821' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_DIRECT_EMPLOYEE_DEMOTION_BYPASSED'; end if;
end;
$$;

do $$
declare
  rejected boolean := false;
begin
  begin
    update public.profiles
    set role = 'manager'
    where id = '82000000-0000-4000-8000-000000000101';
    set constraints
      profiles_effective_admin_validate_update_v1,
      profiles_effective_admin_validate_delete_v1 immediate;
  exception when sqlstate 'QS821' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_DIRECT_MANAGER_DEMOTION_BYPASSED'; end if;
end;
$$;

do $$
declare
  rejected boolean := false;
begin
  begin
    update public.profiles
    set is_active = false
    where id = '82000000-0000-4000-8000-000000000101';
    set constraints
      profiles_effective_admin_validate_update_v1,
      profiles_effective_admin_validate_delete_v1 immediate;
  exception when sqlstate 'QS821' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_DIRECT_DEACTIVATION_BYPASSED'; end if;
end;
$$;

do $$
declare
  rejected boolean := false;
begin
  begin
    delete from public.profiles
    where id = '82000000-0000-4000-8000-000000000101';
    set constraints
      profiles_effective_admin_validate_update_v1,
      profiles_effective_admin_validate_delete_v1 immediate;
  exception when sqlstate 'QS821' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_DIRECT_PROFILE_DELETE_BYPASSED'; end if;
end;
$$;

-- The Auth hard-delete cascade reaches the same profile DELETE backstop. The
-- forced constraint check keeps the expected QS821 inside this savepoint so
-- both parent and child rows can be verified after rollback.
do $$
declare
  rejected boolean := false;
begin
  begin
    delete from auth.users
    where id = '82000000-0000-4000-8000-000000000101';
    set constraints
      profiles_effective_admin_validate_update_v1,
      profiles_effective_admin_validate_delete_v1 immediate;
  exception when sqlstate 'QS821' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_AUTH_HARD_DELETE_BYPASSED'; end if;
  if not exists (
       select 1 from auth.users
       where id = '82000000-0000-4000-8000-000000000101'
     )
     or not exists (
       select 1 from public.profiles
       where id = '82000000-0000-4000-8000-000000000101'
     ) then
    raise exception 'R82_AUTH_HARD_DELETE_DID_NOT_ROLL_BACK';
  end if;
end;
$$;

-- A privileged multi-row statement cannot demote all apparent admin profiles
-- in one shot. Conversely, an atomic demote/promote swap is valid when its
-- final effective count remains one.
do $$
declare
  rejected boolean := false;
begin
  begin
    update public.profiles
    set role = 'employee', is_active = true
    where id in (
      '82000000-0000-4000-8000-000000000101',
      '82000000-0000-4000-8000-000000000103',
      '82000000-0000-4000-8000-000000000104',
      '82000000-0000-4000-8000-000000000105'
    );
    set constraints
      profiles_effective_admin_validate_update_v1,
      profiles_effective_admin_validate_delete_v1 immediate;
  exception when sqlstate 'QS821' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_MULTIROW_ZERO_ADMIN_BYPASSED'; end if;
end;
$$;

update public.profiles
set role = case id
      when '82000000-0000-4000-8000-000000000101'::uuid then 'employee'
      when '82000000-0000-4000-8000-000000000102'::uuid then 'admin'
      else role
    end,
    is_active = true
where id in (
  '82000000-0000-4000-8000-000000000101',
  '82000000-0000-4000-8000-000000000102'
);
set constraints
  profiles_effective_admin_validate_update_v1,
  profiles_effective_admin_validate_delete_v1 immediate;

do $$
begin
  if public.effective_admin_count_v1() <> 1
     or (select role from public.profiles
         where id = '82000000-0000-4000-8000-000000000101') <> 'employee'
     or (select role from public.profiles
         where id = '82000000-0000-4000-8000-000000000102') <> 'admin' then
    raise exception 'R82_ATOMIC_ADMIN_SWAP_FAILED';
  end if;
end;
$$;

update public.profiles
set role = case id
      when '82000000-0000-4000-8000-000000000101'::uuid then 'admin'
      when '82000000-0000-4000-8000-000000000102'::uuid then 'employee'
      else role
    end,
    is_active = true
where id in (
  '82000000-0000-4000-8000-000000000101',
  '82000000-0000-4000-8000-000000000102'
);
set constraints
  profiles_effective_admin_validate_update_v1,
  profiles_effective_admin_validate_delete_v1 immediate;
set constraints
  profiles_effective_admin_validate_update_v1,
  profiles_effective_admin_validate_delete_v1 deferred;

do $$
begin
  if public.effective_admin_count_v1() <> 1
     or not exists (
       select 1 from public.profiles
       where id = '82000000-0000-4000-8000-000000000101'
         and role = 'admin'
         and is_active is true
     ) then
    raise exception 'R82_DIRECT_REJECTION_CHANGED_PROFILE';
  end if;
end;
$$;

create temporary table r82_rejected_audit_baseline as
select count(*)::bigint as event_count
from public.audit_logs
where entity_id = '82000000-0000-4000-8000-000000000101';

-- The v2 and legacy-v1 paths both reject self-deactivation of the only
-- effective administrator with the stable invariant error.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '82000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  rejected boolean := false;
begin
  begin
    perform public.update_profile_admin_v2(
      '82000000-0000-4000-8000-000000000101',
      '{"is_active":false}'::jsonb,
      true
    );
  exception when sqlstate 'QS821' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_V2_LAST_ADMIN_DEACTIVATION_ALLOWED'; end if;
end;
$$;

do $$
declare
  rejected boolean := false;
begin
  begin
    perform public.update_profile_admin_v1(
      '82000000-0000-4000-8000-000000000101',
      '{"is_active":false}'::jsonb,
      true
    );
  exception when sqlstate 'QS821' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_V1_LAST_ADMIN_DEACTIVATION_ALLOWED'; end if;
end;
$$;

reset role;

do $$
begin
  if (select count(*) from public.audit_logs
      where entity_id = '82000000-0000-4000-8000-000000000101')
     <> (select event_count from r82_rejected_audit_baseline) then
    raise exception 'R82_REJECTED_OPERATION_EMITTED_SUCCESS_AUDIT';
  end if;
end;
$$;

-- With two usable admins a reduction succeeds, emits one audit event and
-- leaves exactly one effective administrator.
update public.profiles
set role = 'admin', is_active = true
where id = '82000000-0000-4000-8000-000000000102';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '82000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.update_profile_admin_v2(
  '82000000-0000-4000-8000-000000000102',
  '{"role":"employee"}'::jsonb,
  false
);
set constraints
  profiles_effective_admin_validate_update_v1,
  profiles_effective_admin_validate_delete_v1 immediate;
set constraints
  profiles_effective_admin_validate_update_v1,
  profiles_effective_admin_validate_delete_v1 deferred;

reset role;

do $$
begin
  if public.effective_admin_count_v1() <> 1
     or (select role from public.profiles
         where id = '82000000-0000-4000-8000-000000000102') <> 'employee'
     or (select count(*) from public.audit_logs
         where actor_id = '82000000-0000-4000-8000-000000000101'
           and entity_id = '82000000-0000-4000-8000-000000000102'
           and action = 'admin_managed_profile') <> 1 then
    raise exception 'R82_V2_SUCCESS_OR_AUDIT_FAILED';
  end if;
end;
$$;

-- Old clients retain the historical signature but execute the same safe path.
update public.profiles
set role = 'admin', is_active = true
where id = '82000000-0000-4000-8000-000000000102';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '82000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.update_profile_admin_v1(
  '82000000-0000-4000-8000-000000000102',
  '{"role":"manager"}'::jsonb,
  false
);
set constraints
  profiles_effective_admin_validate_update_v1,
  profiles_effective_admin_validate_delete_v1 immediate;
set constraints
  profiles_effective_admin_validate_update_v1,
  profiles_effective_admin_validate_delete_v1 deferred;

reset role;

do $$
begin
  if public.effective_admin_count_v1() <> 1
     or (select role from public.profiles
         where id = '82000000-0000-4000-8000-000000000102') <> 'manager'
     or (select count(*) from public.audit_logs
         where actor_id = '82000000-0000-4000-8000-000000000101'
           and entity_id = '82000000-0000-4000-8000-000000000102'
           and action = 'admin_managed_profile') <> 2 then
    raise exception 'R82_V1_COMPATIBILITY_FAILED';
  end if;
end;
$$;

-- Non-admin transitions and ordinary administrative fields remain writable.
update public.profiles
set role = 'manager'
where id = '82000000-0000-4000-8000-000000000106';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '82000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.update_profile_admin_v2(
  '82000000-0000-4000-8000-000000000106',
  '{"role":"employee","department":"Operations","region":"LATAM"}'::jsonb,
  false
);

select public.update_profile_admin_v2(
  '82000000-0000-4000-8000-000000000107',
  '{"department":"Sales","region":"North"}'::jsonb,
  false
);

reset role;

do $$
begin
  if not exists (
    select 1 from public.profiles
    where id = '82000000-0000-4000-8000-000000000106'
      and role = 'employee'
      and department = 'Operations'
      and region = 'LATAM'
  ) or not exists (
    select 1 from public.profiles
    where id = '82000000-0000-4000-8000-000000000107'
      and role = 'employee'
      and department = 'Sales'
      and region = 'North'
  ) then
    raise exception 'R82_NON_ADMIN_WRITE_REGRESSION';
  end if;
end;
$$;

-- Existing Super Admin Dev restrictions remain authoritative.
update public.profiles
set role = 'super_admin_dev', is_active = true
where id = '82000000-0000-4000-8000-000000000102';

create temporary table r82_superadmin_audit_baseline as
select count(*)::bigint as event_count
from public.audit_logs
where entity_id = '82000000-0000-4000-8000-000000000102';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '82000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  rejected boolean := false;
begin
  begin
    perform public.update_profile_admin_v2(
      '82000000-0000-4000-8000-000000000102',
      '{"department":"Forbidden"}'::jsonb,
      false
    );
  exception when sqlstate '42501' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_ADMIN_MODIFIED_SUPERADMIN'; end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '82000000-0000-4000-8000-000000000102',
  true
);

do $$
declare
  rejected boolean := false;
begin
  begin
    perform public.update_profile_admin_v2(
      '82000000-0000-4000-8000-000000000102',
      '{"is_active":false}'::jsonb,
      true
    );
  exception when sqlstate '42501' then
    rejected := true;
  end;
  if not rejected then raise exception 'R82_SUPERADMIN_SELF_SECURITY_CHANGE_ALLOWED'; end if;
end;
$$;

reset role;

do $$
begin
  if (select count(*) from public.audit_logs
      where entity_id = '82000000-0000-4000-8000-000000000102')
     <> (select event_count from r82_superadmin_audit_baseline) then
    raise exception 'R82_REJECTED_SUPERADMIN_OPERATION_AUDITED';
  end if;
end;
$$;

-- Function properties, grants and trigger installation.
do $$
declare
  function_name text;
  function_oid oid;
  function_config text;
begin
  foreach function_name in array array[
    'public.lock_effective_admin_invariant_v1()',
    'public.effective_admin_count_v1()',
    'public.assert_effective_admin_invariant_v1()',
    'public.update_profile_admin_v2(uuid,jsonb,boolean)',
    'public.update_profile_admin_v1(uuid,jsonb,boolean)',
    'public.lock_profile_admin_capacity_statement_v1()',
    'public.validate_profile_admin_capacity_deferred_v1()'
  ] loop
    function_oid := to_regprocedure(function_name);
    if function_oid is null then
      raise exception 'R82_FUNCTION_MISSING:%', function_name;
    end if;
    select array_to_string(proconfig, ',')
    into function_config
    from pg_proc
    where oid = function_oid;
    if not (select prosecdef and provolatile = 'v' from pg_proc where oid = function_oid)
       or function_config is null
       or function_config not like '%search_path=pg_catalog%' then
      raise exception 'R82_FUNCTION_HARDENING_FAILED:%', function_name;
    end if;
  end loop;

  if has_function_privilege(
       'anon',
       'public.update_profile_admin_v2(uuid,jsonb,boolean)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       'public.update_profile_admin_v2(uuid,jsonb,boolean)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.update_profile_admin_v2(uuid,jsonb,boolean)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.update_profile_admin_v1(uuid,jsonb,boolean)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       'public.update_profile_admin_v1(uuid,jsonb,boolean)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.update_profile_admin_v1(uuid,jsonb,boolean)',
       'EXECUTE'
     ) then
    raise exception 'R82_RPC_ACL_FAILED';
  end if;

  if (select proowner from pg_proc
      where oid = to_regprocedure(
        'public.update_profile_admin_v1(uuid,jsonb,boolean)'
      ))
     <> (select proowner from pg_proc
         where oid = to_regprocedure(
           'public.update_profile_admin_v2(uuid,jsonb,boolean)'
         )) then
    raise exception 'R82_V1_V2_OWNER_MISMATCH';
  end if;

  foreach function_name in array array[
    'public.lock_effective_admin_invariant_v1()',
    'public.effective_admin_count_v1()',
    'public.assert_effective_admin_invariant_v1()',
    'public.lock_profile_admin_capacity_statement_v1()',
    'public.validate_profile_admin_capacity_deferred_v1()'
  ] loop
    if has_function_privilege('anon', function_name, 'EXECUTE')
       or has_function_privilege('authenticated', function_name, 'EXECUTE')
       or has_function_privilege('service_role', function_name, 'EXECUTE') then
      raise exception 'R82_INTERNAL_FUNCTION_ACL_FAILED:%', function_name;
    end if;
  end loop;
end;
$$;

do $$
declare
  trigger_name text;
  trigger_definition text;
  trigger_is_deferrable boolean;
  trigger_is_initially_deferred boolean;
begin
  foreach trigger_name in array array[
    'profiles_effective_admin_lock_update_v1',
    'profiles_effective_admin_lock_delete_v1'
  ] loop
    select pg_get_triggerdef(trigger.oid)
    into trigger_definition
    from pg_trigger trigger
    where trigger.tgrelid = 'public.profiles'::regclass
      and trigger.tgname = trigger_name
      and not trigger.tgisinternal;
    if trigger_definition is null
       or lower(trigger_definition) not like '%for each statement%'
       or lower(trigger_definition) not like '%before%' then
      raise exception 'R82_STATEMENT_LOCK_TRIGGER_MISSING:%', trigger_name;
    end if;
  end loop;

  foreach trigger_name in array array[
    'profiles_effective_admin_validate_update_v1',
    'profiles_effective_admin_validate_delete_v1'
  ] loop
    select pg_get_triggerdef(trigger.oid),
      trigger.tgdeferrable,
      trigger.tginitdeferred
    into trigger_definition,
      trigger_is_deferrable,
      trigger_is_initially_deferred
    from pg_trigger trigger
    where trigger.tgrelid = 'public.profiles'::regclass
      and trigger.tgname = trigger_name
      and not trigger.tgisinternal;
    if trigger_definition is null
       or lower(trigger_definition) not like '%for each row%'
       or lower(trigger_definition) not like '%constraint trigger%'
       or not trigger_is_deferrable
       or not trigger_is_initially_deferred then
      raise exception 'R82_DEFERRED_CONSTRAINT_TRIGGER_MISSING:%', trigger_name;
    end if;
  end loop;

  if to_regclass('public.profiles_effective_admin_candidates_idx') is null then
    raise exception 'R82_EFFECTIVE_ADMIN_INDEX_MISSING';
  end if;
end;
$$;

select 'LAST_EFFECTIVE_ADMIN_R82_RUNTIME_PASS' as result,
  public.effective_admin_count_v1() as effective_admins;

rollback;
