begin;

-- D5/D6 are additive. Technical Auth/R8 roles remain unchanged; business
-- responsibility is carried in a separate, tightly constrained attribute.
alter table public.profiles
  add column if not exists business_rank text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'profiles_business_rank_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_business_rank_check
      check (business_rank is null or business_rank in (
        'owner', 'executive', 'director', 'manager', 'salesperson',
        'sourcing_manager', 'sourcing_specialist', 'individual_contributor'
      ));
  end if;
end;
$$;

comment on column public.profiles.business_rank is
  'Commercial responsibility kept separate from the stable Auth/R8 technical role enum.';

create or replace function public.sourcing_is_privileged_actor()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select auth.role() = 'service_role' or exists (
    select 1
    from public.profiles actor
    where actor.id = auth.uid()
      and actor.is_active = true
      and (
        actor.role = 'super_admin_dev'
        or actor.business_rank = 'sourcing_manager'
        or (
          actor.business_rank = 'owner'
          and public.profile_role_has_capability(actor.role, 'ADMIN')
        )
      )
  );
$$;

revoke all on function public.sourcing_is_privileged_actor() from public, anon;
grant execute on function public.sourcing_is_privileged_actor() to authenticated, service_role;

create table if not exists public.sourcing_requests (
  id uuid primary key default gen_random_uuid(),
  commerce_rfq_id uuid references public.commerce_rfqs(id) on delete set null,
  commerce_rfq_item_id uuid references public.commerce_rfq_items(id) on delete set null,
  commerce_quote_item_id uuid references public.commerce_quote_items(id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'commerce_rfq')),
  mpn text not null check (length(trim(mpn)) between 1 and 160),
  normalized_mpn text not null check (length(trim(normalized_mpn)) between 1 and 160),
  manufacturer text,
  requested_quantity bigint not null check (requested_quantity > 0),
  unit_of_measure text,
  customer_context text,
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  status text not null default 'open'
    check (status in ('open', 'collecting_offers', 'review', 'approved', 'closed', 'cancelled')),
  notes text not null default '',
  requested_by uuid not null references public.profiles(id),
  assigned_to uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (commerce_rfq_item_id)
);

create table if not exists public.sourcing_offers (
  id uuid primary key default gen_random_uuid(),
  sourcing_request_id uuid not null references public.sourcing_requests(id) on delete cascade,
  mpn text not null check (length(trim(mpn)) between 1 and 160),
  normalized_mpn text not null check (length(trim(normalized_mpn)) between 1 and 160),
  manufacturer text,
  supplier_name text not null check (length(trim(supplier_name)) between 1 and 200),
  supplier_reference text,
  available_quantity bigint not null check (available_quantity > 0),
  unit_of_measure text,
  raw_unit_cost numeric(18, 6) not null check (raw_unit_cost > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),
  minimum_order_quantity bigint not null default 1 check (minimum_order_quantity > 0),
  standard_pack_quantity bigint check (standard_pack_quantity is null or standard_pack_quantity > 0),
  date_code text,
  condition text,
  warehouse text check (warehouse is null or char_length(warehouse) <= 160),
  incoterm text check (incoterm is null or char_length(incoterm) <= 40),
  country_of_origin text,
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  notes text not null default '',
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  created_by uuid not null references public.profiles(id),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- There is intentionally no uniqueness constraint on request + MPN: comparison
-- of several supplier offers for the same requested part is a core invariant.
create index if not exists sourcing_offers_request_mpn_idx
  on public.sourcing_offers (sourcing_request_id, normalized_mpn, created_at desc);
create index if not exists sourcing_offers_status_expiry_idx
  on public.sourcing_offers (status, expires_at);

create table if not exists public.sourcing_offer_attachments (
  id uuid primary key default gen_random_uuid(),
  sourcing_request_id uuid not null references public.sourcing_requests(id) on delete cascade,
  sourcing_offer_id uuid references public.sourcing_offers(id) on delete cascade,
  storage_bucket text not null default 'sourcing-private' check (storage_bucket = 'sourcing-private'),
  storage_path text not null,
  original_file_name text not null,
  mime_type text,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create table if not exists public.commercial_price_approvals (
  id uuid primary key default gen_random_uuid(),
  sourcing_request_id uuid not null references public.sourcing_requests(id) on delete restrict,
  sourcing_offer_id uuid not null references public.sourcing_offers(id) on delete restrict,
  mpn text not null,
  normalized_mpn text not null,
  manufacturer text,
  authorized_unit_price numeric(18, 4) not null check (authorized_unit_price > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  coarse_availability text not null
    check (coarse_availability in ('available', 'limited', 'unavailable', 'contact_us')),
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),
  minimum_order_quantity bigint not null check (minimum_order_quantity > 0),
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  publish_to_catalog boolean not null default false,
  published_at timestamptz,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null,
  version bigint not null check (version > 0),
  approved_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until > valid_from)
);

create unique index if not exists commercial_price_approvals_one_active_mpn_idx
  on public.commercial_price_approvals (normalized_mpn)
  where status = 'active';
create index if not exists commercial_price_approvals_public_idx
  on public.commercial_price_approvals (publish_to_catalog, status, valid_until, normalized_mpn);

alter table public.commerce_catalog_products
  add column if not exists commercial_price_approval_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'commerce_catalog_products_commercial_price_approval_id_fkey'
      and conrelid = 'public.commerce_catalog_products'::regclass
  ) then
    alter table public.commerce_catalog_products
      add constraint commerce_catalog_products_commercial_price_approval_id_fkey
      foreign key (commercial_price_approval_id)
      references public.commercial_price_approvals(id) on delete set null;
  end if;
end;
$$;

drop trigger if exists sourcing_requests_set_updated_at on public.sourcing_requests;
create trigger sourcing_requests_set_updated_at
before update on public.sourcing_requests
for each row execute function public.set_updated_at();

drop trigger if exists sourcing_offers_set_updated_at on public.sourcing_offers;
create trigger sourcing_offers_set_updated_at
before update on public.sourcing_offers
for each row execute function public.set_updated_at();

drop trigger if exists commercial_price_approvals_set_updated_at on public.commercial_price_approvals;
create trigger commercial_price_approvals_set_updated_at
before update on public.commercial_price_approvals
for each row execute function public.set_updated_at();

-- Additive provenance links only. No matcher, normalization, UOM, allocation,
-- ranking, or pipeline behavior is changed by these nullable foreign keys.
alter table public.opportunity_finder_supply_lots
  add column if not exists sourcing_offer_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'opportunity_finder_supply_lots_sourcing_offer_id_fkey'
      and conrelid = 'public.opportunity_finder_supply_lots'::regclass
  ) then
    alter table public.opportunity_finder_supply_lots
      add constraint opportunity_finder_supply_lots_sourcing_offer_id_fkey
      foreign key (sourcing_offer_id) references public.sourcing_offers(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'commerce_quote_items_sourcing_offer_id_fkey'
      and conrelid = 'public.commerce_quote_items'::regclass
  ) then
    alter table public.commerce_quote_items
      add constraint commerce_quote_items_sourcing_offer_id_fkey
      foreign key (sourcing_offer_id) references public.sourcing_offers(id) on delete set null;
  end if;
end;
$$;

create index if not exists opportunity_finder_supply_lots_sourcing_offer_idx
  on public.opportunity_finder_supply_lots (sourcing_offer_id)
  where sourcing_offer_id is not null;

create or replace function public.approve_sourcing_offer_v1(
  input_offer_id uuid,
  input_authorized_unit_price numeric,
  input_authorized_currency text,
  input_coarse_availability text,
  input_reason text default ''
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_offer public.sourcing_offers%rowtype;
  approval_id uuid;
  next_version bigint;
begin
  if not public.sourcing_is_privileged_actor() then
    raise exception using errcode = '42501', message = 'SOURCING_FORBIDDEN';
  end if;
  if input_authorized_unit_price is null or input_authorized_unit_price <= 0
     or input_authorized_currency <> 'USD'
     or input_coarse_availability not in ('available', 'limited', 'unavailable', 'contact_us') then
    raise exception using errcode = '22023', message = 'SOURCING_INVALID_APPROVAL';
  end if;

  select * into locked_offer
  from public.sourcing_offers
  where id = input_offer_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SOURCING_NOT_FOUND';
  end if;
  if locked_offer.status <> 'pending' or locked_offer.expires_at <= now() then
    raise exception using errcode = '55000', message = 'SOURCING_INVALID_STATE';
  end if;

  update public.commercial_price_approvals
  set status = 'revoked', publish_to_catalog = false, published_at = null
  where normalized_mpn = locked_offer.normalized_mpn and status = 'active';

  select greatest(
    coalesce((select max(version) from public.commercial_price_approvals
      where normalized_mpn = locked_offer.normalized_mpn), 0),
    coalesce((select max(revision) from public.commerce_catalog_products
      where upper(mpn) = upper(locked_offer.mpn)
        and upper(manufacturer) = upper(coalesce(locked_offer.manufacturer, ''))), 0)
  ) + 1 into next_version;

  insert into public.commercial_price_approvals (
    sourcing_request_id, sourcing_offer_id, mpn, normalized_mpn, manufacturer,
    authorized_unit_price, currency, coarse_availability, lead_time_days,
    minimum_order_quantity, publish_to_catalog, valid_until, version, approved_by
  ) values (
    locked_offer.sourcing_request_id, locked_offer.id, locked_offer.mpn,
    locked_offer.normalized_mpn, locked_offer.manufacturer,
    input_authorized_unit_price, input_authorized_currency, input_coarse_availability,
    locked_offer.lead_time_days, locked_offer.minimum_order_quantity,
    false, locked_offer.expires_at, next_version, auth.uid()
  ) returning id into approval_id;

  -- Feed the existing Commerce seller catalog and quote product-id contract.
  -- Only seller-safe commercial fields are copied; supplier, raw cost,
  -- provenance, documents and internal notes never cross this boundary.
  insert into public.commerce_catalog_products (
    mpn, manufacturer, description, category, authorized_unit_price, currency,
    available_quantity, availability_status, minimum_order_quantity,
    lead_time_days, revision, is_active, publish_to_catalog,
    commercial_price_approval_id, created_by, updated_by
  ) values (
    locked_offer.mpn, coalesce(locked_offer.manufacturer, ''), '', 'Generic',
    input_authorized_unit_price, input_authorized_currency,
    locked_offer.available_quantity,
    case input_coarse_availability
      when 'available' then 'available'
      when 'limited' then 'low_stock'
      else 'unavailable'
    end,
    locked_offer.minimum_order_quantity, locked_offer.lead_time_days,
    next_version, true, false, approval_id, auth.uid(), auth.uid()
  )
  on conflict ((upper(mpn)), (upper(manufacturer))) do update set
    authorized_unit_price = excluded.authorized_unit_price,
    currency = excluded.currency,
    available_quantity = excluded.available_quantity,
    availability_status = excluded.availability_status,
    minimum_order_quantity = excluded.minimum_order_quantity,
    lead_time_days = excluded.lead_time_days,
    revision = excluded.revision,
    is_active = true,
    publish_to_catalog = false,
    commercial_price_approval_id = excluded.commercial_price_approval_id,
    updated_by = excluded.updated_by;

  update public.sourcing_offers
  set status = 'approved', decided_by = auth.uid(), decided_at = now(),
      decision_reason = left(coalesce(input_reason, ''), 1000)
  where id = locked_offer.id;
  update public.sourcing_requests
  set status = 'approved'
  where id = locked_offer.sourcing_request_id;

  return approval_id;
end;
$$;

create or replace function public.reject_sourcing_offer_v1(
  input_offer_id uuid,
  input_reason text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_offer public.sourcing_offers%rowtype;
begin
  if not public.sourcing_is_privileged_actor() then
    raise exception using errcode = '42501', message = 'SOURCING_FORBIDDEN';
  end if;
  if nullif(trim(input_reason), '') is null then
    raise exception using errcode = '22023', message = 'SOURCING_REJECTION_REASON_REQUIRED';
  end if;
  select * into locked_offer from public.sourcing_offers where id = input_offer_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'SOURCING_NOT_FOUND'; end if;
  if locked_offer.status <> 'pending' then
    raise exception using errcode = '55000', message = 'SOURCING_INVALID_STATE';
  end if;
  update public.sourcing_offers
  set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
      decision_reason = left(input_reason, 1000)
  where id = input_offer_id;
  return input_offer_id;
end;
$$;

create or replace function public.set_commercial_price_publication_v1(
  input_approval_id uuid,
  input_publish_to_catalog boolean
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.sourcing_is_privileged_actor() then
    raise exception using errcode = '42501', message = 'SOURCING_FORBIDDEN';
  end if;
  update public.commercial_price_approvals
  set publish_to_catalog = input_publish_to_catalog,
      published_at = case
        when input_publish_to_catalog then coalesce(published_at, now())
        else null
      end
  where id = input_approval_id
    and status = 'active'
    and valid_until > now();
  if not found then raise exception using errcode = 'P0002', message = 'SOURCING_NOT_FOUND'; end if;
  update public.commerce_catalog_products
  set publish_to_catalog = input_publish_to_catalog,
      updated_by = auth.uid()
  where commercial_price_approval_id = input_approval_id;
  return input_approval_id;
end;
$$;

create or replace function public.link_sourcing_offer_to_of_supply_lot_v1(
  input_offer_id uuid,
  input_supply_lot_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_offer public.sourcing_offers%rowtype;
  target_lot public.opportunity_finder_supply_lots%rowtype;
begin
  if not public.sourcing_is_privileged_actor() then
    raise exception using errcode = '42501', message = 'SOURCING_FORBIDDEN';
  end if;
  select * into approved_offer from public.sourcing_offers
  where id = input_offer_id and status = 'approved' and expires_at > now();
  if not found then raise exception using errcode = 'P0002', message = 'SOURCING_NOT_FOUND'; end if;
  select * into target_lot from public.opportunity_finder_supply_lots
  where id = input_supply_lot_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'SOURCING_NOT_FOUND'; end if;
  if target_lot.supply_role <> 'supplier_offer'
     or target_lot.exact_norm <> approved_offer.normalized_mpn then
    raise exception using errcode = '22023', message = 'SOURCING_OF_CONTRACT_MISMATCH';
  end if;
  update public.opportunity_finder_supply_lots
  set sourcing_offer_id = approved_offer.id
  where id = target_lot.id;
  return target_lot.id;
end;
$$;

-- Seller-safe access is a function rather than direct table SELECT so no actor
-- can request extra columns such as approval actors or internal request links.
create or replace function public.get_seller_safe_sourcing_approvals_v1(input_mpn text default null)
returns table (
  id uuid,
  sourcing_request_id uuid,
  sourcing_offer_id uuid,
  mpn text,
  manufacturer text,
  authorized_unit_price numeric,
  currency text,
  coarse_availability text,
  lead_time_days integer,
  minimum_order_quantity bigint,
  valid_until timestamptz,
  version bigint,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select approval.id, approval.sourcing_request_id, approval.sourcing_offer_id,
    approval.mpn, approval.manufacturer, approval.authorized_unit_price,
    approval.currency, approval.coarse_availability, approval.lead_time_days,
    approval.minimum_order_quantity, approval.valid_until, approval.version,
    approval.updated_at
  from public.commercial_price_approvals approval
  where public.is_active_profile()
    and approval.status = 'active'
    and approval.valid_until > now()
    and (input_mpn is null or approval.normalized_mpn = input_mpn)
  order by approval.normalized_mpn;
$$;

revoke all on function public.approve_sourcing_offer_v1(uuid, numeric, text, text, text) from public, anon;
revoke all on function public.reject_sourcing_offer_v1(uuid, text) from public, anon;
revoke all on function public.set_commercial_price_publication_v1(uuid, boolean) from public, anon;
revoke all on function public.link_sourcing_offer_to_of_supply_lot_v1(uuid, uuid) from public, anon;
revoke all on function public.get_seller_safe_sourcing_approvals_v1(text) from public, anon;
grant execute on function public.approve_sourcing_offer_v1(uuid, numeric, text, text, text) to authenticated;
grant execute on function public.reject_sourcing_offer_v1(uuid, text) to authenticated;
grant execute on function public.set_commercial_price_publication_v1(uuid, boolean) to authenticated;
grant execute on function public.link_sourcing_offer_to_of_supply_lot_v1(uuid, uuid) to authenticated;
grant execute on function public.get_seller_safe_sourcing_approvals_v1(text) to authenticated;

alter table public.sourcing_requests enable row level security;
alter table public.sourcing_offers enable row level security;
alter table public.sourcing_offer_attachments enable row level security;
alter table public.commercial_price_approvals enable row level security;
alter table public.sourcing_requests force row level security;
alter table public.sourcing_offers force row level security;
alter table public.sourcing_offer_attachments force row level security;
alter table public.commercial_price_approvals force row level security;

drop policy if exists sourcing_requests_privileged_all on public.sourcing_requests;
create policy sourcing_requests_privileged_all on public.sourcing_requests
for all to authenticated
using (public.sourcing_is_privileged_actor())
with check (public.sourcing_is_privileged_actor() and requested_by = auth.uid());

drop policy if exists sourcing_offers_privileged_all on public.sourcing_offers;
create policy sourcing_offers_privileged_all on public.sourcing_offers
for all to authenticated
using (public.sourcing_is_privileged_actor())
with check (public.sourcing_is_privileged_actor() and created_by = auth.uid());

drop policy if exists sourcing_offer_attachments_privileged_all on public.sourcing_offer_attachments;
create policy sourcing_offer_attachments_privileged_all on public.sourcing_offer_attachments
for all to authenticated
using (public.sourcing_is_privileged_actor())
with check (public.sourcing_is_privileged_actor() and uploaded_by = auth.uid());

-- No direct authenticated policy exists for commercial_price_approvals.
-- Mutations are only possible through the audited approval/publication RPCs.

revoke all on table public.sourcing_requests from public, anon;
revoke all on table public.sourcing_offers from public, anon;
revoke all on table public.sourcing_offer_attachments from public, anon;
revoke all on table public.commercial_price_approvals from public, anon, authenticated;
grant select, insert, update on table public.sourcing_requests to authenticated;
grant select, insert, update on table public.sourcing_offers to authenticated;
grant select, insert, delete on table public.sourcing_offer_attachments to authenticated;
grant all on table public.sourcing_requests to service_role;
grant all on table public.sourcing_offers to service_role;
grant all on table public.sourcing_offer_attachments to service_role;
grant all on table public.commercial_price_approvals to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sourcing-private', 'sourcing-private', false, 10485760,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv', 'image/png', 'image/jpeg', 'image/webp'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists sourcing_private_select on storage.objects;
create policy sourcing_private_select on storage.objects
for select to authenticated
using (bucket_id = 'sourcing-private' and public.sourcing_is_privileged_actor());

drop policy if exists sourcing_private_insert on storage.objects;
create policy sourcing_private_insert on storage.objects
for insert to authenticated
with check (bucket_id = 'sourcing-private' and public.sourcing_is_privileged_actor());

drop policy if exists sourcing_private_delete on storage.objects;
create policy sourcing_private_delete on storage.objects
for delete to authenticated
using (bucket_id = 'sourcing-private' and public.sourcing_is_privileged_actor());

commit;
