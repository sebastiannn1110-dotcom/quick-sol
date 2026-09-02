begin;

-- D3 demo commerce is additive. It deliberately does not alter Opportunity
-- Finder, Stock Needs, provisioning, or any R8 authorization invariant.

alter table public.clients
  add column if not exists external_customer_id text,
  add column if not exists assigned_salesperson_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'clients_assigned_salesperson_id_fkey'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients
      add constraint clients_assigned_salesperson_id_fkey
      foreign key (assigned_salesperson_id) references public.profiles(id) on delete set null;
  end if;
end;
$$;

create unique index if not exists clients_external_customer_id_uq
  on public.clients (external_customer_id)
  where external_customer_id is not null;
create index if not exists clients_assigned_salesperson_idx
  on public.clients (assigned_salesperson_id, status, name);

-- Contact and delivery data has a stricter boundary than the existing
-- company-directory clients table, whose historical read policy is broader.
create table if not exists public.commerce_client_details (
  client_id uuid primary key references public.clients(id) on delete cascade,
  legal_company_name text,
  contact_name text not null,
  contact_email text not null,
  contact_phone text,
  country text,
  city text,
  address_line_1 text,
  address_line_2 text,
  state_or_province text,
  postal_code text,
  delivery_recipient text,
  delivery_phone text,
  delivery_email text,
  tax_id text,
  purchase_order_reference text,
  preferred_language text not null default 'en' check (preferred_language in ('es', 'en', 'zh')),
  commercial_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists commerce_client_details_email_idx
  on public.commerce_client_details (lower(contact_email));

create table if not exists public.commerce_catalog_products (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid references public.business_records(id) on delete set null,
  mpn text not null,
  manufacturer text not null default '',
  description text not null default '',
  category text not null default 'Generic',
  image_url text,
  authorized_unit_price numeric(18, 4) not null check (authorized_unit_price >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  available_quantity bigint not null default 0 check (available_quantity >= 0),
  availability_status text not null default 'unavailable'
    check (availability_status in (
      'available', 'low_stock', 'partially_reserved',
      'temporarily_reserved', 'unavailable', 'updating'
    )),
  minimum_order_quantity bigint not null default 1 check (minimum_order_quantity > 0),
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),
  revision bigint not null default 1 check (revision > 0),
  is_active boolean not null default true,
  publish_to_catalog boolean not null default false,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists commerce_catalog_products_mpn_manufacturer_uq
  on public.commerce_catalog_products (upper(mpn), upper(manufacturer));
create index if not exists commerce_catalog_products_active_mpn_idx
  on public.commerce_catalog_products (is_active, mpn);

create table if not exists public.commerce_rfqs (
  id uuid primary key default gen_random_uuid(),
  external_rfq_id text not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  client_id uuid references public.clients(id) on delete set null,
  contact_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(contact_snapshot) = 'object'),
  assigned_salesperson_id uuid references public.profiles(id) on delete set null,
  status text not null check (status in ('unassigned', 'assigned', 'in_review', 'quoted', 'cancelled')),
  source text not null default 'quiksol-web' check (source in ('quiksol-web', 'internal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.commerce_rfq_items (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.commerce_rfqs(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  mpn text not null,
  manufacturer text not null default '',
  description text not null default '',
  quantity bigint not null check (quantity > 0),
  target_price numeric(18, 4) check (target_price is null or target_price > 0),
  created_at timestamptz not null default now(),
  unique (rfq_id, line_number)
);

create index if not exists commerce_rfqs_salesperson_created_idx
  on public.commerce_rfqs (assigned_salesperson_id, created_at desc);
create index if not exists commerce_rfqs_client_created_idx
  on public.commerce_rfqs (client_id, created_at desc);
create index if not exists commerce_rfq_items_rfq_idx
  on public.commerce_rfq_items (rfq_id, line_number);
create index if not exists commerce_rfq_items_mpn_idx
  on public.commerce_rfq_items (upper(mpn));

create sequence if not exists public.commerce_quote_number_seq;

create table if not exists public.commerce_quotes (
  id uuid primary key default gen_random_uuid(),
  quote_number text not null unique default (
    'QKS-' || to_char(clock_timestamp(), 'YYYYMM') || '-' ||
    lpad(nextval('public.commerce_quote_number_seq')::text, 6, '0')
  ),
  rfq_id uuid references public.commerce_rfqs(id) on delete set null,
  client_id uuid not null references public.clients(id),
  seller_id uuid not null references public.profiles(id),
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  currency text not null default 'USD' check (currency = 'USD'),
  subtotal numeric(18, 2) not null default 0 check (subtotal >= 0),
  tax_rate numeric(7, 4) not null default 7 check (tax_rate >= 0 and tax_rate <= 100),
  tax numeric(18, 2) not null default 0 check (tax >= 0),
  total numeric(18, 2) not null default 0 check (total >= 0),
  valid_until date not null,
  notes text not null default '',
  commercial_terms text not null default '',
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists public.commerce_quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.commerce_quotes(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  product_id uuid references public.commerce_catalog_products(id) on delete restrict,
  mpn text not null,
  manufacturer text not null default '',
  description text not null default '',
  quantity bigint not null check (quantity > 0),
  authorized_unit_price numeric(18, 4) not null check (authorized_unit_price >= 0),
  seller_unit_price numeric(18, 4) not null check (seller_unit_price >= 0),
  discount_percent numeric(7, 4) not null default 0
    check (discount_percent >= 0 and discount_percent <= 100),
  currency text not null default 'USD' check (currency = 'USD'),
  line_total numeric(18, 2) not null check (line_total >= 0),
  availability_revision bigint not null check (availability_revision > 0),
  sourcing_offer_id uuid,
  created_at timestamptz not null default now(),
  unique (quote_id, line_number)
);

create table if not exists public.commerce_quote_events (
  id bigint generated always as identity primary key,
  quote_id uuid not null references public.commerce_quotes(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  event_type text not null
    check (event_type in ('created', 'updated', 'sent', 'accepted', 'rejected', 'expired')),
  previous_status text check (
    previous_status is null or previous_status in ('draft', 'sent', 'accepted', 'rejected', 'expired')
  ),
  new_status text not null
    check (new_status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create table if not exists public.commerce_quote_shares (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.commerce_quotes(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references public.profiles(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index if not exists commerce_quotes_seller_created_idx
  on public.commerce_quotes (seller_id, created_at desc);
create index if not exists commerce_quotes_client_created_idx
  on public.commerce_quotes (client_id, created_at desc);
create index if not exists commerce_quotes_status_created_idx
  on public.commerce_quotes (status, created_at desc);
create index if not exists commerce_quote_items_quote_idx
  on public.commerce_quote_items (quote_id, line_number);
create index if not exists commerce_quote_events_quote_created_idx
  on public.commerce_quote_events (quote_id, created_at, id);
create index if not exists commerce_quote_shares_quote_created_idx
  on public.commerce_quote_shares (quote_id, created_at desc);
create index if not exists commerce_quote_shares_active_idx
  on public.commerce_quote_shares (token_hash, expires_at)
  where revoked_at is null;

drop trigger if exists commerce_catalog_products_set_updated_at on public.commerce_catalog_products;
create trigger commerce_catalog_products_set_updated_at
before update on public.commerce_catalog_products
for each row execute function public.set_updated_at();

drop trigger if exists commerce_client_details_set_updated_at on public.commerce_client_details;
create trigger commerce_client_details_set_updated_at
before update on public.commerce_client_details
for each row execute function public.set_updated_at();

drop trigger if exists commerce_rfqs_set_updated_at on public.commerce_rfqs;
create trigger commerce_rfqs_set_updated_at
before update on public.commerce_rfqs
for each row execute function public.set_updated_at();

drop trigger if exists commerce_quotes_set_updated_at on public.commerce_quotes;
create trigger commerce_quotes_set_updated_at
before update on public.commerce_quotes
for each row execute function public.set_updated_at();

create or replace function public.commerce_reject_quote_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception using errcode = '55000', message = 'COMMERCE_QUOTE_EVENT_IMMUTABLE';
end;
$$;

drop trigger if exists commerce_quote_events_immutable on public.commerce_quote_events;
create trigger commerce_quote_events_immutable
before update or delete on public.commerce_quote_events
for each row execute function public.commerce_reject_quote_event_mutation();

create or replace function public.commerce_can_access_seller(target_seller_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles actor
    join public.profiles seller on seller.id = target_seller_id and seller.is_active = true
    where actor.id = auth.uid()
      and actor.is_active = true
      and (
        actor.id = seller.id
        or public.profile_role_has_capability(actor.role, 'ADMIN')
        or (
          actor.role = 'manager'
          and (
            (actor.department is not null and actor.department = seller.department)
            or (actor.region is not null and actor.region = seller.region)
          )
        )
      )
  );
$$;

create or replace function public.commerce_can_access_client(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.clients client
    join public.profiles actor on actor.id = auth.uid() and actor.is_active = true
    where client.id = target_client_id
      and client.status = 'active'
      and client.archived_at is null
      and (
        public.profile_role_has_capability(actor.role, 'ADMIN')
        or (actor.role = 'manager' and client.assigned_salesperson_id is null)
        or (
          client.assigned_salesperson_id is not null
          and public.commerce_can_access_seller(client.assigned_salesperson_id)
        )
      )
  );
$$;

revoke all on function public.commerce_can_access_seller(uuid) from public;
revoke all on function public.commerce_can_access_client(uuid) from public;
grant execute on function public.commerce_can_access_seller(uuid) to authenticated, service_role;
grant execute on function public.commerce_can_access_client(uuid) to authenticated, service_role;

alter table public.commerce_catalog_products enable row level security;
alter table public.commerce_client_details enable row level security;
alter table public.commerce_rfqs enable row level security;
alter table public.commerce_rfq_items enable row level security;
alter table public.commerce_quotes enable row level security;
alter table public.commerce_quote_items enable row level security;
alter table public.commerce_quote_events enable row level security;
alter table public.commerce_quote_shares enable row level security;

drop policy if exists commerce_catalog_products_read_active on public.commerce_catalog_products;
create policy commerce_catalog_products_read_active on public.commerce_catalog_products
for select to authenticated
using (public.is_active_profile() and is_active = true);

drop policy if exists commerce_catalog_products_admin_write on public.commerce_catalog_products;
create policy commerce_catalog_products_admin_write on public.commerce_catalog_products
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists commerce_client_details_read_scoped on public.commerce_client_details;
create policy commerce_client_details_read_scoped on public.commerce_client_details
for select to authenticated
using (public.commerce_can_access_client(client_id));

drop policy if exists commerce_rfqs_read_scoped on public.commerce_rfqs;
create policy commerce_rfqs_read_scoped on public.commerce_rfqs
for select to authenticated
using (
  (assigned_salesperson_id is not null and public.commerce_can_access_seller(assigned_salesperson_id))
  or (assigned_salesperson_id is null and public.can_manage_clients())
);

drop policy if exists commerce_rfq_items_read_scoped on public.commerce_rfq_items;
create policy commerce_rfq_items_read_scoped on public.commerce_rfq_items
for select to authenticated
using (
  exists (
    select 1 from public.commerce_rfqs rfq
    where rfq.id = commerce_rfq_items.rfq_id
      and (
        (rfq.assigned_salesperson_id is not null and public.commerce_can_access_seller(rfq.assigned_salesperson_id))
        or (rfq.assigned_salesperson_id is null and public.can_manage_clients())
      )
  )
);

drop policy if exists commerce_quotes_read_scoped on public.commerce_quotes;
create policy commerce_quotes_read_scoped on public.commerce_quotes
for select to authenticated
using (public.commerce_can_access_seller(seller_id));

drop policy if exists commerce_quote_items_read_scoped on public.commerce_quote_items;
create policy commerce_quote_items_read_scoped on public.commerce_quote_items
for select to authenticated
using (
  exists (
    select 1 from public.commerce_quotes quote
    where quote.id = commerce_quote_items.quote_id
      and public.commerce_can_access_seller(quote.seller_id)
  )
);

drop policy if exists commerce_quote_events_read_scoped on public.commerce_quote_events;
create policy commerce_quote_events_read_scoped on public.commerce_quote_events
for select to authenticated
using (
  exists (
    select 1 from public.commerce_quotes quote
    where quote.id = commerce_quote_events.quote_id
      and public.commerce_can_access_seller(quote.seller_id)
  )
);

create or replace function public.ingest_commerce_rfq_v1(
  input_external_rfq_id text,
  input_request_fingerprint text,
  input_client_id uuid,
  input_contact_snapshot jsonb,
  input_items jsonb,
  input_source text default 'quiksol-web'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_rfq public.commerce_rfqs%rowtype;
  created_rfq public.commerce_rfqs%rowtype;
  resolved_client public.clients%rowtype;
  assigned_salesperson uuid;
  requested_item jsonb;
  item_index integer := 0;
begin
  if nullif(trim(input_external_rfq_id), '') is null
     or length(input_external_rfq_id) > 160
     or input_request_fingerprint !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(input_contact_snapshot) <> 'object'
     or jsonb_typeof(input_items) <> 'array'
     or jsonb_array_length(input_items) < 1
     or jsonb_array_length(input_items) > 100
     or input_source not in ('quiksol-web', 'internal') then
    raise exception using errcode = '22023', message = 'COMMERCE_RFQ_INVALID';
  end if;

  select * into existing_rfq
  from public.commerce_rfqs
  where external_rfq_id = trim(input_external_rfq_id)
  for update;

  if found then
    if existing_rfq.request_fingerprint <> input_request_fingerprint then
      raise exception using errcode = '23505', message = 'COMMERCE_RFQ_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'id', existing_rfq.id,
      'externalRfqId', existing_rfq.external_rfq_id,
      'clientId', existing_rfq.client_id,
      'assignedSalespersonId', existing_rfq.assigned_salesperson_id,
      'status', existing_rfq.status,
      'createdAt', existing_rfq.created_at,
      'idempotent', true
    );
  end if;

  if input_client_id is not null then
    select * into resolved_client
    from public.clients
    where id = input_client_id and status = 'active' and archived_at is null;
    if found then assigned_salesperson := resolved_client.assigned_salesperson_id; end if;
  end if;

  insert into public.commerce_rfqs (
    external_rfq_id, request_fingerprint, client_id, contact_snapshot,
    assigned_salesperson_id, status, source
  ) values (
    trim(input_external_rfq_id), input_request_fingerprint,
    case when resolved_client.id is null then null else resolved_client.id end,
    input_contact_snapshot,
    assigned_salesperson,
    case when assigned_salesperson is null then 'unassigned' else 'assigned' end,
    input_source
  ) returning * into created_rfq;

  for requested_item in select value from jsonb_array_elements(input_items)
  loop
    item_index := item_index + 1;
    if jsonb_typeof(requested_item) <> 'object'
       or nullif(trim(requested_item->>'mpn'), '') is null
       or length(requested_item->>'mpn') > 160
       or coalesce((requested_item->>'quantity')::bigint, 0) <= 0
       or coalesce((requested_item->>'quantity')::bigint, 0) > 1000000 then
      raise exception using errcode = '22023', message = 'COMMERCE_RFQ_ITEM_INVALID';
    end if;
    insert into public.commerce_rfq_items (
      rfq_id, line_number, mpn, manufacturer, description, quantity, target_price
    ) values (
      created_rfq.id,
      item_index,
      trim(requested_item->>'mpn'),
      left(coalesce(requested_item->>'manufacturer', ''), 160),
      left(coalesce(requested_item->>'description', ''), 500),
      (requested_item->>'quantity')::bigint,
      case
        when requested_item->>'targetPrice' is null then null
        when (requested_item->>'targetPrice')::numeric > 0 then (requested_item->>'targetPrice')::numeric
        else null
      end
    );
  end loop;

  return jsonb_build_object(
    'id', created_rfq.id,
    'externalRfqId', created_rfq.external_rfq_id,
    'clientId', created_rfq.client_id,
    'assignedSalespersonId', created_rfq.assigned_salesperson_id,
    'status', created_rfq.status,
    'createdAt', created_rfq.created_at,
    'idempotent', false
  );
end;
$$;

create or replace function public.create_commerce_customer_v1(input_details jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  created_client public.clients%rowtype;
  preferred_language text;
begin
  select * into actor_profile from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  preferred_language := coalesce(nullif(input_details->>'preferredLanguage', ''), 'en');
  if jsonb_typeof(input_details) <> 'object'
     or nullif(trim(input_details->>'companyOrName'), '') is null
     or nullif(trim(input_details->>'contact'), '') is null
     or coalesce(input_details->>'email', '') !~* '^[^[:space:]@]+@[^[:space:]@]+$'
     or preferred_language not in ('es', 'en', 'zh') then
    raise exception using errcode = '22023', message = 'COMMERCE_CUSTOMER_INVALID';
  end if;

  insert into public.clients (
    name, status, created_by, updated_by, assigned_salesperson_id
  ) values (
    left(trim(input_details->>'companyOrName'), 160),
    'active', actor_profile.id, actor_profile.id, actor_profile.id
  ) returning * into created_client;

  insert into public.commerce_client_details (
    client_id, legal_company_name, contact_name, contact_email, contact_phone,
    country, city, address_line_1, address_line_2, state_or_province, postal_code,
    delivery_recipient, delivery_phone, delivery_email, tax_id,
    purchase_order_reference, preferred_language, commercial_notes
  ) values (
    created_client.id,
    nullif(left(coalesce(input_details->>'legalCompanyName', ''), 200), ''),
    left(trim(input_details->>'contact'), 160),
    lower(left(trim(input_details->>'email'), 254)),
    nullif(left(coalesce(input_details->>'phone', ''), 60), ''),
    nullif(left(coalesce(input_details->>'country', ''), 100), ''),
    nullif(left(coalesce(input_details->>'city', ''), 120), ''),
    nullif(left(coalesce(input_details->>'address', ''), 320), ''),
    nullif(left(coalesce(input_details->>'addressLine2', ''), 160), ''),
    nullif(left(coalesce(input_details->>'stateOrProvince', ''), 120), ''),
    nullif(left(coalesce(input_details->>'postalCode', ''), 40), ''),
    nullif(left(coalesce(input_details->>'deliveryRecipient', ''), 160), ''),
    nullif(left(coalesce(input_details->>'deliveryPhone', ''), 60), ''),
    nullif(lower(left(coalesce(input_details->>'deliveryEmail', ''), 254)), ''),
    nullif(left(coalesce(input_details->>'taxId', ''), 80), ''),
    nullif(left(coalesce(input_details->>'purchaseOrderReference', ''), 120), ''),
    preferred_language,
    nullif(left(coalesce(input_details->>'commercialNotes', ''), 1500), '')
  );
  return created_client.id;
end;
$$;

create or replace function public.update_commerce_customer_v1(
  input_client_id uuid,
  input_details jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  locked_client public.clients%rowtype;
  preferred_language text;
begin
  select * into actor_profile from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  select * into locked_client from public.clients where id = input_client_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND'; end if;
  if not public.commerce_can_access_client(locked_client.id) then
    raise exception using errcode = '42501', message = 'COMMERCE_CLIENT_FORBIDDEN';
  end if;
  preferred_language := coalesce(nullif(input_details->>'preferredLanguage', ''), 'en');
  if jsonb_typeof(input_details) <> 'object'
     or nullif(trim(input_details->>'companyOrName'), '') is null
     or nullif(trim(input_details->>'contact'), '') is null
     or coalesce(input_details->>'email', '') !~* '^[^[:space:]@]+@[^[:space:]@]+$'
     or preferred_language not in ('es', 'en', 'zh') then
    raise exception using errcode = '22023', message = 'COMMERCE_CUSTOMER_INVALID';
  end if;

  update public.clients set
    name = left(trim(input_details->>'companyOrName'), 160),
    updated_by = actor_profile.id
  where id = locked_client.id;

  insert into public.commerce_client_details (
    client_id, legal_company_name, contact_name, contact_email, contact_phone,
    country, city, address_line_1, address_line_2, state_or_province, postal_code,
    delivery_recipient, delivery_phone, delivery_email, tax_id,
    purchase_order_reference, preferred_language, commercial_notes
  ) values (
    locked_client.id,
    nullif(left(coalesce(input_details->>'legalCompanyName', ''), 200), ''),
    left(trim(input_details->>'contact'), 160),
    lower(left(trim(input_details->>'email'), 254)),
    nullif(left(coalesce(input_details->>'phone', ''), 60), ''),
    nullif(left(coalesce(input_details->>'country', ''), 100), ''),
    nullif(left(coalesce(input_details->>'city', ''), 120), ''),
    nullif(left(coalesce(input_details->>'address', ''), 320), ''),
    nullif(left(coalesce(input_details->>'addressLine2', ''), 160), ''),
    nullif(left(coalesce(input_details->>'stateOrProvince', ''), 120), ''),
    nullif(left(coalesce(input_details->>'postalCode', ''), 40), ''),
    nullif(left(coalesce(input_details->>'deliveryRecipient', ''), 160), ''),
    nullif(left(coalesce(input_details->>'deliveryPhone', ''), 60), ''),
    nullif(lower(left(coalesce(input_details->>'deliveryEmail', ''), 254)), ''),
    nullif(left(coalesce(input_details->>'taxId', ''), 80), ''),
    nullif(left(coalesce(input_details->>'purchaseOrderReference', ''), 120), ''),
    preferred_language,
    nullif(left(coalesce(input_details->>'commercialNotes', ''), 1500), '')
  )
  on conflict (client_id) do update set
    legal_company_name = excluded.legal_company_name,
    contact_name = excluded.contact_name,
    contact_email = excluded.contact_email,
    contact_phone = excluded.contact_phone,
    country = excluded.country,
    city = excluded.city,
    address_line_1 = excluded.address_line_1,
    address_line_2 = excluded.address_line_2,
    state_or_province = excluded.state_or_province,
    postal_code = excluded.postal_code,
    delivery_recipient = excluded.delivery_recipient,
    delivery_phone = excluded.delivery_phone,
    delivery_email = excluded.delivery_email,
    tax_id = excluded.tax_id,
    purchase_order_reference = excluded.purchase_order_reference,
    preferred_language = excluded.preferred_language,
    commercial_notes = excluded.commercial_notes;
  return locked_client.id;
end;
$$;

create or replace function public.create_commerce_quote_v1(
  input_client_id uuid,
  input_rfq_id uuid,
  input_items jsonb,
  input_valid_until date,
  input_notes text,
  input_commercial_terms text,
  input_tax_rate numeric default 7
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  created_quote public.commerce_quotes%rowtype;
  product public.commerce_catalog_products%rowtype;
  requested_item jsonb;
  item_index integer := 0;
  requested_quantity bigint;
  requested_discount numeric;
  maximum_discount numeric;
  seller_price numeric;
  item_total numeric;
  calculated_subtotal numeric := 0;
  calculated_tax numeric := 0;
  calculated_total numeric := 0;
begin
  select * into actor_profile from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.commerce_can_access_client(input_client_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_CLIENT_FORBIDDEN';
  end if;
  if input_rfq_id is not null and not exists (
    select 1 from public.commerce_rfqs rfq
    where rfq.id = input_rfq_id
      and (rfq.client_id is null or rfq.client_id = input_client_id)
      and (
        (rfq.assigned_salesperson_id is not null and public.commerce_can_access_seller(rfq.assigned_salesperson_id))
        or (rfq.assigned_salesperson_id is null and public.can_manage_clients())
      )
  ) then
    raise exception using errcode = '42501', message = 'COMMERCE_RFQ_FORBIDDEN';
  end if;
  if jsonb_typeof(input_items) <> 'array'
     or jsonb_array_length(input_items) < 1
     or jsonb_array_length(input_items) > 100
     or input_valid_until < current_date
     or input_tax_rate < 0 or input_tax_rate > 100 then
    raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_INVALID';
  end if;

  maximum_discount := case
    when public.profile_role_has_capability(actor_profile.role, 'ADMIN') then 100
    when actor_profile.role = 'manager' then 25
    else 10
  end;

  insert into public.commerce_quotes (
    rfq_id, client_id, seller_id, valid_until, notes, commercial_terms, tax_rate
  ) values (
    input_rfq_id, input_client_id, actor_profile.id, input_valid_until,
    left(coalesce(input_notes, ''), 2000),
    left(coalesce(input_commercial_terms, ''), 3000),
    round(input_tax_rate, 4)
  ) returning * into created_quote;

  for requested_item in select value from jsonb_array_elements(input_items)
  loop
    item_index := item_index + 1;
    requested_quantity := coalesce((requested_item->>'quantity')::bigint, 0);
    requested_discount := coalesce((requested_item->>'discountPercent')::numeric, 0);
    if requested_quantity < 1 or requested_quantity > 1000000
       or requested_discount < 0 or requested_discount > maximum_discount then
      raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_ITEM_INVALID';
    end if;
    select * into product
    from public.commerce_catalog_products
    where id = (requested_item->>'productId')::uuid and is_active = true;
    if not found then
      raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND';
    end if;
    if requested_quantity < product.minimum_order_quantity then
      raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_MOQ_INVALID';
    end if;
    seller_price := round(product.authorized_unit_price * (1 - requested_discount / 100), 4);
    item_total := round(seller_price * requested_quantity, 2);
    calculated_subtotal := calculated_subtotal + item_total;

    insert into public.commerce_quote_items (
      quote_id, line_number, product_id, mpn, manufacturer, description,
      quantity, authorized_unit_price, seller_unit_price, discount_percent,
      currency, line_total, availability_revision
    ) values (
      created_quote.id, item_index, product.id, product.mpn, product.manufacturer,
      product.description, requested_quantity, product.authorized_unit_price,
      seller_price, requested_discount, product.currency, item_total, product.revision
    );
  end loop;

  calculated_subtotal := round(calculated_subtotal, 2);
  calculated_tax := round(calculated_subtotal * input_tax_rate / 100, 2);
  calculated_total := round(calculated_subtotal + calculated_tax, 2);
  update public.commerce_quotes
  set subtotal = calculated_subtotal, tax = calculated_tax, total = calculated_total
  where id = created_quote.id;

  insert into public.commerce_quote_events (
    quote_id, actor_id, event_type, previous_status, new_status, metadata
  ) values (
    created_quote.id, actor_profile.id, 'created', null, 'draft',
    jsonb_build_object('version', 1)
  );

  if input_rfq_id is not null then
    update public.commerce_rfqs
    set status = 'quoted', assigned_salesperson_id = coalesce(assigned_salesperson_id, actor_profile.id)
    where id = input_rfq_id;
  end if;
  return created_quote.id;
end;
$$;

create or replace function public.update_commerce_quote_v1(
  input_quote_id uuid,
  input_expected_version integer,
  input_client_id uuid,
  input_rfq_id uuid,
  input_items jsonb,
  input_valid_until date,
  input_notes text,
  input_commercial_terms text,
  input_tax_rate numeric default 7
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  locked_quote public.commerce_quotes%rowtype;
  product public.commerce_catalog_products%rowtype;
  requested_item jsonb;
  item_index integer := 0;
  requested_quantity bigint;
  requested_discount numeric;
  maximum_discount numeric;
  seller_price numeric;
  item_total numeric;
  calculated_subtotal numeric := 0;
  calculated_tax numeric;
  calculated_total numeric;
begin
  select * into actor_profile from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  select * into locked_quote from public.commerce_quotes
  where id = input_quote_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND'; end if;
  if not public.commerce_can_access_seller(locked_quote.seller_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_QUOTE_FORBIDDEN';
  end if;
  if locked_quote.version <> input_expected_version then
    raise exception using errcode = '40001', message = 'COMMERCE_VERSION_CONFLICT';
  end if;
  if locked_quote.status <> 'draft' then
    raise exception using errcode = '55000', message = 'COMMERCE_TRANSITION_INVALID';
  end if;
  if not public.commerce_can_access_client(input_client_id)
     or jsonb_typeof(input_items) <> 'array'
     or jsonb_array_length(input_items) < 1
     or jsonb_array_length(input_items) > 100
     or input_valid_until < current_date
     or input_tax_rate < 0 or input_tax_rate > 100 then
    raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_INVALID';
  end if;

  maximum_discount := case
    when public.profile_role_has_capability(actor_profile.role, 'ADMIN') then 100
    when actor_profile.role = 'manager' then 25
    else 10
  end;
  delete from public.commerce_quote_items where quote_id = locked_quote.id;

  for requested_item in select value from jsonb_array_elements(input_items)
  loop
    item_index := item_index + 1;
    requested_quantity := coalesce((requested_item->>'quantity')::bigint, 0);
    requested_discount := coalesce((requested_item->>'discountPercent')::numeric, 0);
    if requested_quantity < 1 or requested_quantity > 1000000
       or requested_discount < 0 or requested_discount > maximum_discount then
      raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_ITEM_INVALID';
    end if;
    select * into product from public.commerce_catalog_products
    where id = (requested_item->>'productId')::uuid and is_active = true;
    if not found then raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND'; end if;
    if requested_quantity < product.minimum_order_quantity then
      raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_MOQ_INVALID';
    end if;
    seller_price := round(product.authorized_unit_price * (1 - requested_discount / 100), 4);
    item_total := round(seller_price * requested_quantity, 2);
    calculated_subtotal := calculated_subtotal + item_total;
    insert into public.commerce_quote_items (
      quote_id, line_number, product_id, mpn, manufacturer, description,
      quantity, authorized_unit_price, seller_unit_price, discount_percent,
      currency, line_total, availability_revision
    ) values (
      locked_quote.id, item_index, product.id, product.mpn, product.manufacturer,
      product.description, requested_quantity, product.authorized_unit_price,
      seller_price, requested_discount, product.currency, item_total, product.revision
    );
  end loop;

  calculated_subtotal := round(calculated_subtotal, 2);
  calculated_tax := round(calculated_subtotal * input_tax_rate / 100, 2);
  calculated_total := round(calculated_subtotal + calculated_tax, 2);
  update public.commerce_quotes set
    client_id = input_client_id,
    rfq_id = input_rfq_id,
    subtotal = calculated_subtotal,
    tax_rate = round(input_tax_rate, 4),
    tax = calculated_tax,
    total = calculated_total,
    valid_until = input_valid_until,
    notes = left(coalesce(input_notes, ''), 2000),
    commercial_terms = left(coalesce(input_commercial_terms, ''), 3000),
    version = version + 1
  where id = locked_quote.id;

  insert into public.commerce_quote_events (
    quote_id, actor_id, event_type, previous_status, new_status, metadata
  ) values (
    locked_quote.id, actor_profile.id, 'updated', 'draft', 'draft',
    jsonb_build_object('previousVersion', locked_quote.version, 'version', locked_quote.version + 1)
  );
  return locked_quote.id;
end;
$$;

create or replace function public.transition_commerce_quote_v1(
  input_quote_id uuid,
  input_expected_version integer,
  input_new_status text,
  input_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  locked_quote public.commerce_quotes%rowtype;
  allowed boolean := false;
begin
  select * into actor_profile from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  select * into locked_quote from public.commerce_quotes
  where id = input_quote_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND'; end if;
  if not public.commerce_can_access_seller(locked_quote.seller_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_QUOTE_FORBIDDEN';
  end if;
  if locked_quote.version <> input_expected_version then
    raise exception using errcode = '40001', message = 'COMMERCE_VERSION_CONFLICT';
  end if;
  allowed := (
    (locked_quote.status = 'draft' and input_new_status in ('sent', 'expired'))
    or (locked_quote.status = 'sent' and input_new_status in ('accepted', 'rejected', 'expired'))
  );
  if not allowed then
    raise exception using errcode = '55000', message = 'COMMERCE_TRANSITION_INVALID';
  end if;

  update public.commerce_quotes set
    status = input_new_status,
    version = version + 1,
    sent_at = case when input_new_status = 'sent' then now() else sent_at end
  where id = locked_quote.id;
  insert into public.commerce_quote_events (
    quote_id, actor_id, event_type, previous_status, new_status, metadata
  ) values (
    locked_quote.id,
    actor_profile.id,
    input_new_status,
    locked_quote.status,
    input_new_status,
    jsonb_strip_nulls(jsonb_build_object(
      'previousVersion', locked_quote.version,
      'version', locked_quote.version + 1,
      'reason', nullif(left(coalesce(input_reason, ''), 500), '')
    ))
  );
  return locked_quote.id;
end;
$$;

create or replace function public.create_commerce_quote_share_v1(
  input_quote_id uuid,
  input_token_hash text,
  input_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  target_quote public.commerce_quotes%rowtype;
  created_share public.commerce_quote_shares%rowtype;
begin
  select * into actor_profile from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  select * into target_quote from public.commerce_quotes
  where id = input_quote_id;
  if not found then raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND'; end if;
  if not public.commerce_can_access_seller(target_quote.seller_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_QUOTE_FORBIDDEN';
  end if;
  if target_quote.status not in ('sent', 'accepted', 'rejected', 'expired') then
    raise exception using errcode = '55000', message = 'COMMERCE_TRANSITION_INVALID';
  end if;
  if input_token_hash !~ '^[a-f0-9]{64}$'
     or input_expires_at <= now()
     or input_expires_at > now() + interval '7 days' then
    raise exception using errcode = '22023', message = 'COMMERCE_SHARE_INVALID';
  end if;
  insert into public.commerce_quote_shares (quote_id, token_hash, created_by, expires_at)
  values (target_quote.id, input_token_hash, actor_profile.id, input_expires_at)
  returning * into created_share;
  return created_share.id;
end;
$$;

revoke all on function public.ingest_commerce_rfq_v1(text, text, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.ingest_commerce_rfq_v1(text, text, uuid, jsonb, jsonb, text) to service_role;

revoke all on function public.create_commerce_customer_v1(jsonb) from public, anon;
revoke all on function public.update_commerce_customer_v1(uuid, jsonb) from public, anon;
grant execute on function public.create_commerce_customer_v1(jsonb) to authenticated;
grant execute on function public.update_commerce_customer_v1(uuid, jsonb) to authenticated;

revoke all on function public.create_commerce_quote_v1(uuid, uuid, jsonb, date, text, text, numeric) from public, anon;
revoke all on function public.update_commerce_quote_v1(uuid, integer, uuid, uuid, jsonb, date, text, text, numeric) from public, anon;
revoke all on function public.transition_commerce_quote_v1(uuid, integer, text, text) from public, anon;
grant execute on function public.create_commerce_quote_v1(uuid, uuid, jsonb, date, text, text, numeric) to authenticated;
grant execute on function public.update_commerce_quote_v1(uuid, integer, uuid, uuid, jsonb, date, text, text, numeric) to authenticated;
grant execute on function public.transition_commerce_quote_v1(uuid, integer, text, text) to authenticated;

revoke all on function public.create_commerce_quote_share_v1(uuid, text, timestamptz) from public, anon;
grant execute on function public.create_commerce_quote_share_v1(uuid, text, timestamptz) to authenticated;

revoke all on table public.commerce_catalog_products from public, anon;
revoke all on table public.commerce_client_details from public, anon;
revoke all on table public.commerce_rfqs from public, anon;
revoke all on table public.commerce_rfq_items from public, anon;
revoke all on table public.commerce_quotes from public, anon;
revoke all on table public.commerce_quote_items from public, anon;
revoke all on table public.commerce_quote_events from public, anon;
revoke all on table public.commerce_quote_shares from public, anon;

grant select on table public.commerce_catalog_products to authenticated;
grant select, insert, update, delete on table public.commerce_catalog_products to service_role;
grant select on table public.commerce_client_details to authenticated;
grant all on table public.commerce_client_details to service_role;
grant select on table public.commerce_rfqs, public.commerce_rfq_items to authenticated;
grant select on table public.commerce_quotes, public.commerce_quote_items, public.commerce_quote_events to authenticated;
grant all on table public.commerce_rfqs, public.commerce_rfq_items to service_role;
grant all on table public.commerce_quotes, public.commerce_quote_items, public.commerce_quote_events to service_role;
grant all on table public.commerce_quote_shares to service_role;
grant usage, select on sequence public.commerce_quote_number_seq to authenticated, service_role;
grant usage, select on sequence public.commerce_quote_events_id_seq to authenticated, service_role;
comment on table public.commerce_catalog_products is
  'Seller-safe commerce projection. Supplier cost, GP, margin, and supplier identity must never be added here.';
comment on table public.commerce_quote_events is
  'Immutable quote lifecycle ledger used by analytics; accepted remains a quote state, not a sale.';
comment on function public.ingest_commerce_rfq_v1(text, text, uuid, jsonb, jsonb, text) is
  'Atomic, service-only, idempotent web RFQ ingestion by external RFQ id and payload fingerprint.';

commit;
