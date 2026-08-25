begin;

-- One authoritative role-capability matrix for SQL/RLS/Storage. Application
-- code mirrors these exact capabilities in lib/auth/roles.ts.
create or replace function public.profile_role_has_capability(
  target_role text,
  required_capability text
)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select case upper(coalesce(required_capability, ''))
    when 'AUTHENTICATED' then target_role in ('employee', 'manager', 'admin', 'super_admin_dev')
    when 'ADMIN' then target_role in ('admin', 'super_admin_dev')
    when 'SUPERADMIN' then target_role = 'super_admin_dev'
    when 'MANAGE_CLIENTS' then target_role in ('manager', 'admin', 'super_admin_dev')
    when 'OF_TENANT_ADMIN' then target_role in ('admin', 'super_admin_dev')
    else false
  end;
$$;

revoke all on function public.profile_role_has_capability(text, text) from public;
grant execute on function public.profile_role_has_capability(text, text) to authenticated;
grant execute on function public.profile_role_has_capability(text, text) to service_role;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.is_active = true
      and public.profile_role_has_capability(profile.role, 'ADMIN')
  );
$$;

create or replace function public.is_super_admin_dev()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.is_active = true
      and public.profile_role_has_capability(profile.role, 'SUPERADMIN')
  );
$$;

create or replace function public.can_manage_clients()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.is_active = true
      and public.profile_role_has_capability(profile.role, 'MANAGE_CLIENTS')
  );
$$;

create or replace function public.is_opportunity_finder_tenant_admin(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.opportunity_finder_tenant_memberships membership
    join public.profiles profile on profile.id = membership.user_id
    where membership.tenant_id = target_tenant_id
      and membership.user_id = auth.uid()
      and membership.membership_role in ('owner', 'admin')
      and profile.is_active = true
      and public.profile_role_has_capability(profile.role, 'OF_TENANT_ADMIN')
  );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.is_super_admin_dev() from public;
revoke all on function public.can_manage_clients() from public;
revoke all on function public.is_opportunity_finder_tenant_admin(uuid) from public;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_super_admin_dev() to authenticated, service_role;
grant execute on function public.can_manage_clients() to authenticated, service_role;
grant execute on function public.is_opportunity_finder_tenant_admin(uuid) to authenticated, service_role;

-- Client-controlled Auth metadata is descriptive only. New direct signups
-- always receive the least-privileged profile and no organizational scope.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (id, full_name, email, role, department, region)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1), 'Quiksol User'),
    coalesce(new.email, ''),
    'employee',
    null,
    null
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

-- Authenticated clients may not insert profiles or update authorization
-- columns directly. Existing self-service RPCs remain the only path for bio,
-- job title and avatar edits by non-admin users.
revoke insert on table public.profiles from public, anon, authenticated;
revoke update on table public.profiles from public, anon, authenticated;
grant update (full_name, avatar_path, bio, job_title) on table public.profiles to authenticated;

drop policy if exists profiles_insert_admin on public.profiles;
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
for update to authenticated
using (
  public.is_admin()
  and (public.is_super_admin_dev() or role <> 'super_admin_dev')
)
with check (
  public.is_admin()
  and (public.is_super_admin_dev() or role <> 'super_admin_dev')
);

-- Explicit audited path for administrative profile changes. Direct
-- PostgREST writes cannot reach role/department/region/is_active/email.
create or replace function public.update_profile_admin_v1(
  target_profile_id uuid,
  profile_patch jsonb,
  confirm_self_deactivate boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  target_profile public.profiles%rowtype;
  updated_profile public.profiles%rowtype;
  next_role text;
  next_active boolean;
  active_admin_count bigint;
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

  select profile.*
  into actor_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.is_active = true;

  if not found or not public.profile_role_has_capability(actor_profile.role, 'ADMIN') then
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

  next_role := case
    when profile_patch ? 'role' then profile_patch->>'role'
    else target_profile.role
  end;
  next_active := case
    when profile_patch ? 'is_active' then (profile_patch->>'is_active')::boolean
    else target_profile.is_active
  end;
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

  -- Preserve the existing last-admin safeguard and its current concurrency
  -- semantics; the race-hardening work belongs to a later round.
  if target_profile.is_active
     and target_profile.role in ('admin', 'super_admin_dev')
     and (not next_active or next_role not in ('admin', 'super_admin_dev')) then
    select count(*)
    into active_admin_count
    from public.profiles profile
    where profile.is_active = true
      and profile.role in ('admin', 'super_admin_dev');
    if active_admin_count <= 1 then
      raise exception using errcode = '23514', message = 'LAST_ACTIVE_ADMIN_REQUIRED';
    end if;
  end if;

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

revoke all on function public.update_profile_admin_v1(uuid, jsonb, boolean) from public;
grant execute on function public.update_profile_admin_v1(uuid, jsonb, boolean) to authenticated;
grant execute on function public.update_profile_admin_v1(uuid, jsonb, boolean) to service_role;

commit;
