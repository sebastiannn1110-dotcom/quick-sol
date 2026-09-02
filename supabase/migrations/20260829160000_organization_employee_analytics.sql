begin;

-- D8-D9 is additive. Technical Auth roles and every R8 invariant remain
-- unchanged: owner is a business rank, never an Auth role.

create table if not exists public.organization_members (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  manager_id uuid references public.organization_members(profile_id) on delete set null,
  business_title text not null default '' check (char_length(business_title) <= 160),
  business_rank text not null default 'individual_contributor'
    check (business_rank in (
      'owner', 'executive', 'director', 'manager', 'salesperson',
      'sourcing_manager', 'sourcing_specialist', 'individual_contributor'
    )),
  department text check (department is null or char_length(department) <= 160),
  country text check (country is null or char_length(country) <= 100),
  location text check (location is null or char_length(location) <= 200),
  responsibilities text not null default '' check (char_length(responsibilities) <= 4000),
  version integer not null default 1 check (version > 0),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (manager_id is null or manager_id <> profile_id)
);

create index if not exists organization_members_manager_idx
  on public.organization_members (manager_id, profile_id);
create index if not exists organization_members_rank_idx
  on public.organization_members (business_rank, profile_id);

create table if not exists public.employee_compensation (
  employee_id uuid primary key references public.organization_members(profile_id) on delete cascade,
  amount numeric(16, 2) not null check (amount >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  periodicity text not null check (periodicity in ('hourly', 'monthly', 'annual')),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create or replace function public.organization_is_descendant_v1(
  input_root_id uuid,
  input_candidate_id uuid,
  input_include_root boolean default true
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive descendants(profile_id) as (
    select member.profile_id
    from public.organization_members member
    where member.profile_id = input_root_id
    union
    select child.profile_id
    from public.organization_members child
    join descendants parent on child.manager_id = parent.profile_id
  )
  select exists (
    select 1
    from descendants
    where profile_id = input_candidate_id
      and (input_include_root or profile_id <> input_root_id)
  );
$$;

create or replace function public.organization_actor_has_global_edit_v1()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_super_admin_dev()
    or exists (
      select 1
      from public.profiles profile
      join public.organization_members member on member.profile_id = profile.id
      where profile.id = auth.uid()
        and profile.is_active = true
        and member.business_rank = 'owner'
        and public.profile_role_has_capability(profile.role, 'ADMIN')
    );
$$;

create or replace function public.organization_can_read_compensation_v1()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_super_admin_dev()
    or exists (
      select 1
      from public.profiles profile
      join public.organization_members member on member.profile_id = profile.id
      where profile.id = auth.uid()
        and profile.is_active = true
        and member.business_rank = 'owner'
        and public.profile_role_has_capability(profile.role, 'ADMIN')
    );
$$;

create or replace function public.organization_validate_hierarchy_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.manager_id = new.profile_id then
    raise exception using errcode = '23514', message = 'ORGANIZATION_SELF_MANAGER';
  end if;

  if tg_op = 'UPDATE' and new.version <> old.version + 1 then
    raise exception using errcode = '40001', message = 'ORGANIZATION_VERSION_INCREMENT_REQUIRED';
  end if;

  if new.manager_id is not null
     and public.organization_is_descendant_v1(new.profile_id, new.manager_id, true) then
    raise exception using errcode = '23514', message = 'ORGANIZATION_CYCLE';
  end if;

  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists organization_members_validate_hierarchy on public.organization_members;
create trigger organization_members_validate_hierarchy
before insert or update on public.organization_members
for each row execute function public.organization_validate_hierarchy_v1();

create or replace function public.ensure_organization_member_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.organization_members (
    profile_id,
    business_title,
    business_rank,
    department,
    updated_by
  ) values (
    new.id,
    coalesce(new.job_title, ''),
    coalesce(new.business_rank, case when new.role = 'manager' then 'manager' else 'individual_contributor' end),
    new.department,
    new.id
  )
  on conflict (profile_id) do nothing;
  return new;
end;
$$;

drop trigger if exists profiles_ensure_organization_member on public.profiles;
create trigger profiles_ensure_organization_member
after insert on public.profiles
for each row execute function public.ensure_organization_member_v1();

insert into public.organization_members (
  profile_id,
  business_title,
  business_rank,
  department,
  updated_by
)
select
  profile.id,
  coalesce(profile.job_title, ''),
  coalesce(profile.business_rank, case when profile.role = 'manager' then 'manager' else 'individual_contributor' end),
  profile.department,
  profile.id
from public.profiles profile
on conflict (profile_id) do nothing;

-- organization_members is canonical. profiles.business_rank is a synchronized
-- claim used by earlier D5 proxy/RLS paths; it never changes the Auth role.
create or replace function public.sync_organization_business_rank_claim_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.profiles
  set business_rank = new.business_rank
  where id = new.profile_id
    and business_rank is distinct from new.business_rank;
  return new;
end;
$$;

drop trigger if exists organization_members_sync_business_rank_claim on public.organization_members;
create trigger organization_members_sync_business_rank_claim
after insert or update of business_rank on public.organization_members
for each row execute function public.sync_organization_business_rank_claim_v1();

create or replace function public.update_organization_member_v1(
  input_profile_id uuid,
  input_manager_id uuid,
  input_business_title text,
  input_business_rank text,
  input_department text,
  input_country text,
  input_location text,
  input_responsibilities text,
  input_expected_version integer
)
returns public.organization_members
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role text;
  actor_global boolean := false;
  actor_manager boolean := false;
  updated_member public.organization_members%rowtype;
begin
  select profile.role
  into actor_role
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.is_active = true;

  if actor_role is null then
    raise exception using errcode = '42501', message = 'ORGANIZATION_AUTH_REQUIRED';
  end if;

  actor_global := public.organization_actor_has_global_edit_v1();
  actor_manager := actor_role = 'manager';

  if not actor_global and not (
    actor_manager
    and input_profile_id <> auth.uid()
    and public.organization_is_descendant_v1(auth.uid(), input_profile_id, false)
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_EDIT_FORBIDDEN';
  end if;

  if not actor_global and (
    input_business_rank = 'owner'
    or input_manager_id is null
    or not public.organization_is_descendant_v1(auth.uid(), input_manager_id, true)
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_MOVE_OUTSIDE_SUBTREE';
  end if;

  update public.organization_members member
  set manager_id = input_manager_id,
      business_title = left(coalesce(trim(input_business_title), ''), 160),
      business_rank = input_business_rank,
      department = nullif(left(coalesce(trim(input_department), ''), 160), ''),
      country = nullif(left(coalesce(trim(input_country), ''), 100), ''),
      location = nullif(left(coalesce(trim(input_location), ''), 200), ''),
      responsibilities = left(coalesce(trim(input_responsibilities), ''), 4000),
      version = member.version + 1,
      updated_by = auth.uid()
  where member.profile_id = input_profile_id
    and member.version = input_expected_version
  returning member.* into updated_member;

  if updated_member.profile_id is null then
    if exists (
      select 1 from public.organization_members member
      where member.profile_id = input_profile_id
    ) then
      raise exception using errcode = '40001', message = 'ORGANIZATION_VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0002', message = 'ORGANIZATION_MEMBER_NOT_FOUND';
  end if;

  return updated_member;
end;
$$;

alter table public.organization_members enable row level security;
alter table public.employee_compensation enable row level security;

drop policy if exists organization_members_read_active on public.organization_members;
create policy organization_members_read_active on public.organization_members
for select to authenticated
using (
  public.is_active_profile()
  and (
    profile_id = auth.uid()
    or public.profile_role_has_capability(public.current_profile_role(), 'ADMIN')
    or (
      public.current_profile_role() = 'manager'
      and public.organization_is_descendant_v1(auth.uid(), profile_id, true)
    )
  )
);

-- The legacy profile/commerce read policies scope managers by department or
-- region. Organization analytics and the team tree are instead authoritative
-- on the explicit manager_id hierarchy, so add only the missing subtree read
-- path. Existing employee-self and admin/superdev policies remain unchanged.
drop policy if exists profiles_read_organization_manager_subtree on public.profiles;
create policy profiles_read_organization_manager_subtree on public.profiles
for select to authenticated
using (
  is_active = true
  and public.current_profile_role() = 'manager'
  and public.organization_is_descendant_v1(auth.uid(), id, true)
);

drop policy if exists commerce_quotes_read_organization_manager_subtree on public.commerce_quotes;
create policy commerce_quotes_read_organization_manager_subtree on public.commerce_quotes
for select to authenticated
using (
  public.current_profile_role() = 'manager'
  and public.organization_is_descendant_v1(auth.uid(), seller_id, true)
  and exists (
    select 1
    from public.profiles seller
    where seller.id = commerce_quotes.seller_id
      and seller.is_active = true
  )
);

drop policy if exists commerce_quote_items_read_organization_manager_subtree on public.commerce_quote_items;
create policy commerce_quote_items_read_organization_manager_subtree on public.commerce_quote_items
for select to authenticated
using (
  public.current_profile_role() = 'manager'
  and exists (
    select 1
    from public.commerce_quotes quote
    where quote.id = commerce_quote_items.quote_id
      and public.organization_is_descendant_v1(auth.uid(), quote.seller_id, true)
  )
);

drop policy if exists commerce_quote_events_read_organization_manager_subtree on public.commerce_quote_events;
create policy commerce_quote_events_read_organization_manager_subtree on public.commerce_quote_events
for select to authenticated
using (
  public.current_profile_role() = 'manager'
  and exists (
    select 1
    from public.commerce_quotes quote
    where quote.id = commerce_quote_events.quote_id
      and public.organization_is_descendant_v1(auth.uid(), quote.seller_id, true)
  )
);

drop policy if exists employee_compensation_read_privileged on public.employee_compensation;
create policy employee_compensation_read_privileged on public.employee_compensation
for select to authenticated
using (public.organization_can_read_compensation_v1());

revoke all on public.organization_members from anon, authenticated;
grant select on public.organization_members to authenticated;
grant all on public.organization_members to service_role;

revoke all on public.employee_compensation from anon, authenticated;
grant select on public.employee_compensation to authenticated;
grant all on public.employee_compensation to service_role;

revoke all on function public.organization_is_descendant_v1(uuid, uuid, boolean) from public;
revoke all on function public.organization_actor_has_global_edit_v1() from public;
revoke all on function public.organization_can_read_compensation_v1() from public;
revoke all on function public.update_organization_member_v1(uuid, uuid, text, text, text, text, text, text, integer) from public;
revoke all on function public.sync_organization_business_rank_claim_v1() from public, anon, authenticated;

grant execute on function public.organization_is_descendant_v1(uuid, uuid, boolean) to authenticated, service_role;
grant execute on function public.organization_actor_has_global_edit_v1() to authenticated, service_role;
grant execute on function public.organization_can_read_compensation_v1() to authenticated, service_role;
grant execute on function public.update_organization_member_v1(uuid, uuid, text, text, text, text, text, text, integer) to authenticated, service_role;

-- Read-path indexes only; metrics remain derived from quotes, items, and events.
create index if not exists commerce_quotes_seller_client_created_idx
  on public.commerce_quotes (seller_id, client_id, created_at, id);
create index if not exists commerce_quote_events_type_quote_idx
  on public.commerce_quote_events (event_type, quote_id, created_at);

commit;
