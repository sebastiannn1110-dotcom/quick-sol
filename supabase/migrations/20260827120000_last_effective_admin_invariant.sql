begin;

-- R8.2 / Error 39. A single transaction-scoped mutex serializes every
-- supported mutation that can reduce effective administrative capacity.
-- Lock order is always: global invariant mutex -> actor reread -> target row
-- lock -> effective-admin census -> mutation -> audit.

create index if not exists profiles_effective_admin_candidates_idx
  on public.profiles (id)
  where is_active is true and role in ('admin', 'super_admin_dev');

create or replace function public.lock_effective_admin_invariant_v1()
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  -- VOLATILE statements refresh their snapshots in READ COMMITTED after a
  -- waiter acquires the mutex. REPEATABLE READ would retain a stale snapshot,
  -- so fail closed before any profile row can be locked.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using
      errcode = 'QS822',
      message = 'ADMIN_INVARIANT_REQUIRES_READ_COMMITTED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(8202202608271200::bigint);
end;
$$;

revoke all on function public.lock_effective_admin_invariant_v1() from public, anon, authenticated, service_role;

create or replace function public.effective_admin_count_v1()
returns bigint
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select count(*)
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  where profile.is_active is true
    and profile.role in ('admin', 'super_admin_dev')
    and auth_user.email_confirmed_at is not null
    and (
      auth_user.banned_until is null
      or auth_user.banned_until <= pg_catalog.now()
    );
$$;

revoke all on function public.effective_admin_count_v1() from public, anon, authenticated, service_role;

create or replace function public.assert_effective_admin_invariant_v1()
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.effective_admin_count_v1() < 1 then
    raise exception using
      errcode = 'QS821',
      message = 'LAST_EFFECTIVE_ADMIN_REQUIRED';
  end if;
end;
$$;

revoke all on function public.assert_effective_admin_invariant_v1() from public, anon, authenticated, service_role;

create or replace function public.update_profile_admin_v2(
  target_profile_id uuid,
  profile_patch jsonb,
  confirm_self_deactivate boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  target_profile public.profiles%rowtype;
  updated_profile public.profiles%rowtype;
  next_role text;
  next_active boolean;
  touches_admin_capacity boolean;
  may_reduce_admin_capacity boolean;
  target_auth_usable boolean;
  target_was_effective boolean;
  target_will_be_effective boolean;
  effective_admin_count bigint;
  projected_effective_admin_count bigint;
  privileged_transition boolean;
  changed_fields jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if profile_patch is null
     or jsonb_typeof(profile_patch) <> 'object'
     or profile_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'PROFILE_PATCH_INVALID';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(profile_patch) as keys(key_name)
    where key_name <> all (array[
      'full_name', 'email', 'role', 'department', 'region',
      'bio', 'job_title', 'is_active'
    ]::text[])
  ) then
    raise exception using errcode = '22023', message = 'PROFILE_PATCH_FIELD_FORBIDDEN';
  end if;

  if profile_patch ? 'full_name' and (
    jsonb_typeof(profile_patch->'full_name') <> 'string'
    or nullif(trim(profile_patch->>'full_name'), '') is null
  ) then
    raise exception using errcode = '22023', message = 'PROFILE_FULL_NAME_INVALID';
  end if;
  if profile_patch ? 'email' and (
    jsonb_typeof(profile_patch->'email') <> 'string'
    or (profile_patch->>'email') !~* '^[^[:space:]@]+@[^[:space:]@]+$'
  ) then
    raise exception using errcode = '22023', message = 'PROFILE_EMAIL_INVALID';
  end if;
  if profile_patch ? 'role' and (
    jsonb_typeof(profile_patch->'role') <> 'string'
    or (profile_patch->>'role') not in ('employee', 'manager', 'admin', 'super_admin_dev')
  ) then
    raise exception using errcode = '22023', message = 'PROFILE_ROLE_INVALID';
  end if;
  if profile_patch ? 'is_active'
     and jsonb_typeof(profile_patch->'is_active') <> 'boolean' then
    raise exception using errcode = '22023', message = 'PROFILE_ACTIVE_INVALID';
  end if;
  if profile_patch ? 'department'
     and jsonb_typeof(profile_patch->'department') not in ('string', 'null') then
    raise exception using errcode = '22023', message = 'PROFILE_DEPARTMENT_INVALID';
  end if;
  if profile_patch ? 'region'
     and jsonb_typeof(profile_patch->'region') not in ('string', 'null') then
    raise exception using errcode = '22023', message = 'PROFILE_REGION_INVALID';
  end if;
  if profile_patch ? 'bio'
     and jsonb_typeof(profile_patch->'bio') not in ('string', 'null') then
    raise exception using errcode = '22023', message = 'PROFILE_BIO_INVALID';
  end if;
  if profile_patch ? 'job_title'
     and jsonb_typeof(profile_patch->'job_title') not in ('string', 'null') then
    raise exception using errcode = '22023', message = 'PROFILE_JOB_TITLE_INVALID';
  end if;

  touches_admin_capacity := profile_patch ? 'role'
    or profile_patch ? 'is_active';

  -- Every RPC update that mentions a trigger-protected column must take the
  -- mutex before the target row. This includes promotions/reactivations: the
  -- BEFORE STATEMENT backstop will take the same lock when UPDATE executes.
  if touches_admin_capacity then
    perform public.lock_effective_admin_invariant_v1();
  end if;

  select profile.*
  into actor_profile
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  where profile.id = auth.uid()
    and profile.is_active is true
    and public.profile_role_has_capability(profile.role, 'ADMIN')
    and auth_user.email_confirmed_at is not null
    and (
      auth_user.banned_until is null
      or auth_user.banned_until <= pg_catalog.now()
    );

  if not found then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;

  select profile.*
  into target_profile
  from public.profiles profile
  where profile.id = target_profile_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'PROFILE_NOT_FOUND';
  end if;

  next_role := case
    when profile_patch ? 'role' then profile_patch->>'role'
    else target_profile.role
  end;
  next_active := case
    when profile_patch ? 'is_active' then (profile_patch->>'is_active')::boolean
    else target_profile.is_active
  end;
  may_reduce_admin_capacity := target_profile.is_active is true
    and target_profile.role in ('admin', 'super_admin_dev')
    and not (
      next_active is true
      and next_role in ('admin', 'super_admin_dev')
    );
  privileged_transition := target_profile.role = 'super_admin_dev'
    or next_role = 'super_admin_dev';

  if privileged_transition
     and not public.profile_role_has_capability(actor_profile.role, 'SUPERADMIN') then
    raise exception using errcode = '42501', message = 'SUPER_ADMIN_DEV_REQUIRED';
  end if;
  if target_profile.id = auth.uid()
     and target_profile.role = 'super_admin_dev'
     and (next_role <> target_profile.role or not next_active) then
    raise exception using errcode = '42501', message = 'SUPER_ADMIN_DEV_SELF_SECURITY_CHANGE_FORBIDDEN';
  end if;
  if target_profile.id = auth.uid()
     and target_profile.role = 'admin'
     and next_role <> 'admin' then
    raise exception using errcode = '42501', message = 'ADMIN_SELF_DEMOTION_FORBIDDEN';
  end if;
  if target_profile.id = auth.uid()
     and not next_active
     and not confirm_self_deactivate then
    raise exception using errcode = '42501', message = 'SELF_DEACTIVATION_CONFIRMATION_REQUIRED';
  end if;

  if may_reduce_admin_capacity then
    select exists (
      select 1
      from auth.users auth_user
      where auth_user.id = target_profile.id
        and auth_user.email_confirmed_at is not null
        and (
          auth_user.banned_until is null
          or auth_user.banned_until <= pg_catalog.now()
        )
    ) into target_auth_usable;

    target_was_effective := target_profile.is_active
      and target_profile.role in ('admin', 'super_admin_dev')
      and target_auth_usable;
    target_will_be_effective := next_active
      and next_role in ('admin', 'super_admin_dev')
      and target_auth_usable;

    if target_was_effective and not target_will_be_effective then
      effective_admin_count := public.effective_admin_count_v1();
      projected_effective_admin_count := effective_admin_count - 1;

      if projected_effective_admin_count < 1 then
        raise exception using
          errcode = 'QS821',
          message = 'LAST_EFFECTIVE_ADMIN_REQUIRED';
      end if;
    end if;
  end if;

  if profile_patch ? 'role' or profile_patch ? 'is_active' then
    update public.profiles profile
    set full_name = case
          when profile_patch ? 'full_name' then trim(profile_patch->>'full_name')
          else profile.full_name
        end,
        email = case
          when profile_patch ? 'email' then lower(trim(profile_patch->>'email'))
          else profile.email
        end,
        role = next_role,
        department = case
          when profile_patch ? 'department' then nullif(trim(profile_patch->>'department'), '')
          else profile.department
        end,
        region = case
          when profile_patch ? 'region' then nullif(trim(profile_patch->>'region'), '')
          else profile.region
        end,
        bio = case
          when profile_patch ? 'bio' then nullif(trim(profile_patch->>'bio'), '')
          else profile.bio
        end,
        job_title = case
          when profile_patch ? 'job_title' then nullif(trim(profile_patch->>'job_title'), '')
          else profile.job_title
        end,
        is_active = next_active
    where profile.id = target_profile_id
    returning profile.* into updated_profile;
  else
    update public.profiles profile
    set full_name = case
          when profile_patch ? 'full_name' then trim(profile_patch->>'full_name')
          else profile.full_name
        end,
        email = case
          when profile_patch ? 'email' then lower(trim(profile_patch->>'email'))
          else profile.email
        end,
        department = case
          when profile_patch ? 'department' then nullif(trim(profile_patch->>'department'), '')
          else profile.department
        end,
        region = case
          when profile_patch ? 'region' then nullif(trim(profile_patch->>'region'), '')
          else profile.region
        end,
        bio = case
          when profile_patch ? 'bio' then nullif(trim(profile_patch->>'bio'), '')
          else profile.bio
        end,
        job_title = case
          when profile_patch ? 'job_title' then nullif(trim(profile_patch->>'job_title'), '')
          else profile.job_title
        end
    where profile.id = target_profile_id
    returning profile.* into updated_profile;
  end if;

  select coalesce(jsonb_agg(keys.key_name order by keys.key_name), '[]'::jsonb)
  into changed_fields
  from jsonb_object_keys(profile_patch) as keys(key_name);

  insert into public.audit_logs (
    actor_id,
    actor_email,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    actor_profile.id,
    actor_profile.email,
    case
      when privileged_transition then 'superadmin_managed_privileged_profile'
      else 'admin_managed_profile'
    end,
    'profile',
    target_profile.id,
    jsonb_build_object(
      'changedFields', changed_fields,
      'previousRole', target_profile.role,
      'newRole', updated_profile.role,
      'privilegedTransition', privileged_transition
    )
  );

  return to_jsonb(updated_profile);
end;
$$;

revoke all on function public.update_profile_admin_v2(uuid, jsonb, boolean) from public, anon, authenticated, service_role;
grant execute on function public.update_profile_admin_v2(uuid, jsonb, boolean) to authenticated, service_role;

-- Preserve the historical signature and ACL. Old application instances become
-- safe as soon as this migration lands, before the v2 caller is deployed.
create or replace function public.update_profile_admin_v1(
  target_profile_id uuid,
  profile_patch jsonb,
  confirm_self_deactivate boolean default false
)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select public.update_profile_admin_v2(
    target_profile_id,
    profile_patch,
    confirm_self_deactivate
  );
$$;

revoke all on function public.update_profile_admin_v1(uuid, jsonb, boolean) from public, anon, authenticated, service_role;
grant execute on function public.update_profile_admin_v1(uuid, jsonb, boolean) to authenticated, service_role;

-- Statement-level locking is deliberate. A BEFORE ROW trigger would run after
-- PostgreSQL has locked the target row and would invert v2's lock order.
create or replace function public.lock_profile_admin_capacity_statement_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.lock_effective_admin_invariant_v1();
  return null;
end;
$$;

create or replace function public.validate_profile_admin_capacity_deferred_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  -- The BEFORE STATEMENT trigger already acquired this lock before PostgreSQL
  -- could lock any profile row. Re-acquiring it here is transaction-local and
  -- documents that the final census uses the same invariant mutex.
  perform public.lock_effective_admin_invariant_v1();
  perform public.assert_effective_admin_invariant_v1();
  return null;
end;
$$;

revoke all on function public.lock_profile_admin_capacity_statement_v1() from public, anon, authenticated, service_role;
revoke all on function public.validate_profile_admin_capacity_deferred_v1() from public, anon, authenticated, service_role;

drop trigger if exists profiles_effective_admin_lock_update_v1 on public.profiles;
create trigger profiles_effective_admin_lock_update_v1
before update of role, is_active on public.profiles
for each statement execute function public.lock_profile_admin_capacity_statement_v1();

drop trigger if exists profiles_effective_admin_lock_delete_v1 on public.profiles;
create trigger profiles_effective_admin_lock_delete_v1
before delete on public.profiles
for each statement execute function public.lock_profile_admin_capacity_statement_v1();

drop trigger if exists profiles_effective_admin_validate_update_v1 on public.profiles;
create constraint trigger profiles_effective_admin_validate_update_v1
after update of role, is_active on public.profiles
deferrable initially deferred
for each row
when (
  old.is_active is true
  and old.role in ('admin', 'super_admin_dev')
  and (
    new.is_active is not true
    or new.role not in ('admin', 'super_admin_dev')
  )
)
execute function public.validate_profile_admin_capacity_deferred_v1();

drop trigger if exists profiles_effective_admin_validate_delete_v1 on public.profiles;
create constraint trigger profiles_effective_admin_validate_delete_v1
after delete on public.profiles
deferrable initially deferred
for each row
when (
  old.is_active is true
  and old.role in ('admin', 'super_admin_dev')
)
execute function public.validate_profile_admin_capacity_deferred_v1();

commit;
