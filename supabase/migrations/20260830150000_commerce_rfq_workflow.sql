begin;

-- RFQ/Quote workflow hardening is additive. The explicit organization tree is
-- authoritative for manager scope; department/region similarity is not an
-- authorization boundary.
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
    join public.profiles seller
      on seller.id = target_seller_id
     and seller.is_active = true
    where actor.id = auth.uid()
      and actor.is_active = true
      and (
        actor.id = seller.id
        or public.profile_role_has_capability(actor.role, 'ADMIN')
        or (
          actor.role = 'manager'
          and public.organization_is_descendant_v1(actor.id, seller.id, true)
        )
      )
  );
$$;

create or replace function public.commerce_can_access_rfq_v2(target_rfq_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- An unassigned RFQ has no trustworthy subtree anchor, so it remains in the
  -- technical-admin triage queue until an allowed seller is assigned.
  select exists (
    select 1
    from public.commerce_rfqs rfq
    join public.profiles actor
      on actor.id = auth.uid()
     and actor.is_active = true
    where rfq.id = target_rfq_id
      and (
        public.profile_role_has_capability(actor.role, 'ADMIN')
        or (
          rfq.assigned_salesperson_id is not null
          and public.commerce_can_access_seller(rfq.assigned_salesperson_id)
        )
      )
  );
$$;

-- Client write authority remains tied to the account owner (or an exact
-- organization ancestor). RFQ-local reassignment must never grant permission
-- to edit the client or create unrelated quotes for it.
create or replace function public.commerce_can_manage_client_v2(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.clients client
    join public.profiles actor
      on actor.id = auth.uid()
     and actor.is_active = true
    where client.id = target_client_id
      and client.status = 'active'
      and client.archived_at is null
      and (
        public.profile_role_has_capability(actor.role, 'ADMIN')
        or (
          client.assigned_salesperson_id is not null
          and public.commerce_can_access_seller(client.assigned_salesperson_id)
        )
      )
  );
$$;

-- Reassignment is intentionally RFQ-local. It grants only the client detail
-- read needed for that accessible request, without changing account ownership.
create or replace function public.commerce_can_read_client_v2(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.clients client
    where client.id = target_client_id
      and client.status = 'active'
      and client.archived_at is null
      and (
        public.commerce_can_manage_client_v2(client.id)
        or exists (
          select 1
          from public.commerce_rfqs linked_rfq
          where linked_rfq.client_id = client.id
            and public.commerce_can_access_rfq_v2(linked_rfq.id)
        )
      )
  );
$$;

-- Historical write RPCs call this function. Keep that compatibility surface
-- manage-only so an RFQ-local reader cannot acquire broader client writes.
create or replace function public.commerce_can_access_client(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.commerce_can_manage_client_v2(target_client_id);
$$;

create or replace function public.list_commerce_manageable_client_ids_v2()
returns table(client_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select client.id as client_id
  from public.clients client
  where client.status = 'active'
    and client.archived_at is null
    and public.commerce_can_manage_client_v2(client.id)
  order by client.id;
$$;

revoke all on function public.commerce_can_access_rfq_v2(uuid) from public;
revoke all on function public.commerce_can_manage_client_v2(uuid) from public, anon;
revoke all on function public.commerce_can_read_client_v2(uuid) from public, anon;
revoke all on function public.list_commerce_manageable_client_ids_v2() from public, anon;
grant execute on function public.commerce_can_access_rfq_v2(uuid) to authenticated, service_role;
grant execute on function public.commerce_can_manage_client_v2(uuid) to authenticated, service_role;
grant execute on function public.commerce_can_read_client_v2(uuid) to authenticated, service_role;
grant execute on function public.list_commerce_manageable_client_ids_v2() to authenticated;

-- Replace the legacy global manager write policies. USING evaluates the
-- current owner and prevents taking over an unrelated/unassigned client;
-- WITH CHECK evaluates the requested owner and keeps reassignment in subtree.
drop policy if exists clients_insert_manager on public.clients;
create policy clients_insert_manager on public.clients
for insert to authenticated
with check (
  public.can_manage_clients()
  and created_by = auth.uid()
  and (
    public.is_admin()
    or (
      assigned_salesperson_id is not null
      and public.commerce_can_access_seller(assigned_salesperson_id)
    )
  )
);

drop policy if exists clients_update_manager on public.clients;
create policy clients_update_manager on public.clients
for update to authenticated
using (
  public.can_manage_clients()
  and (
    public.is_admin()
    or (
      assigned_salesperson_id is not null
      and public.commerce_can_access_seller(assigned_salesperson_id)
    )
  )
)
with check (
  public.can_manage_clients()
  and (
    public.is_admin()
    or (
      assigned_salesperson_id is not null
      and public.commerce_can_access_seller(assigned_salesperson_id)
    )
  )
);

drop policy if exists commerce_client_details_read_scoped on public.commerce_client_details;
create policy commerce_client_details_read_scoped on public.commerce_client_details
for select to authenticated
using (public.commerce_can_manage_client_v2(client_id));

-- RLS decides which quote lines a seller may see; column privileges separately
-- ensure a normal authenticated session can never select the supplier-offer
-- linkage, even through a direct PostgREST query.
revoke select on table public.commerce_quote_items from authenticated;
grant select (
  id, quote_id, line_number, product_id, mpn, manufacturer, description,
  quantity, authorized_unit_price, seller_unit_price, discount_percent,
  currency, line_total, availability_revision, created_at
) on table public.commerce_quote_items to authenticated;

drop policy if exists commerce_rfqs_read_scoped on public.commerce_rfqs;
create policy commerce_rfqs_read_scoped on public.commerce_rfqs
for select to authenticated
using (public.commerce_can_access_rfq_v2(id));

drop policy if exists commerce_rfq_items_read_scoped on public.commerce_rfq_items;
create policy commerce_rfq_items_read_scoped on public.commerce_rfq_items
for select to authenticated
using (public.commerce_can_access_rfq_v2(rfq_id));

create or replace function public.mark_commerce_rfq_in_review_v2(input_rfq_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_rfq public.commerce_rfqs%rowtype;
begin
  select * into locked_rfq
  from public.commerce_rfqs
  where id = input_rfq_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND';
  end if;
  if not public.commerce_can_access_rfq_v2(locked_rfq.id) then
    raise exception using errcode = '42501', message = 'COMMERCE_RFQ_FORBIDDEN';
  end if;
  if locked_rfq.status = 'in_review' then
    return locked_rfq.id;
  end if;
  if locked_rfq.status <> 'assigned' then
    raise exception using errcode = '55000', message = 'COMMERCE_RFQ_TRANSITION_INVALID';
  end if;

  update public.commerce_rfqs
  set status = 'in_review'
  where id = locked_rfq.id;

  return locked_rfq.id;
end;
$$;

create or replace function public.assign_commerce_rfq_seller_v2(
  input_rfq_id uuid,
  input_seller_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  target_seller public.profiles%rowtype;
  locked_rfq public.commerce_rfqs%rowtype;
  actor_is_global boolean;
begin
  select * into actor_profile
  from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  actor_is_global := public.profile_role_has_capability(actor_profile.role, 'ADMIN');
  if not actor_is_global and actor_profile.role <> 'manager' then
    raise exception using errcode = '42501', message = 'COMMERCE_RFQ_ASSIGN_FORBIDDEN';
  end if;

  select * into locked_rfq
  from public.commerce_rfqs
  where id = input_rfq_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND';
  end if;
  if not public.commerce_can_access_rfq_v2(locked_rfq.id) then
    raise exception using errcode = '42501', message = 'COMMERCE_RFQ_FORBIDDEN';
  end if;
  if locked_rfq.status in ('quoted', 'cancelled') then
    raise exception using errcode = '55000', message = 'COMMERCE_RFQ_ASSIGN_INVALID';
  end if;

  select candidate.* into target_seller
  from public.profiles candidate
  join public.organization_members member on member.profile_id = candidate.id
  where candidate.id = input_seller_id
    and candidate.is_active = true
    and member.business_rank in ('owner', 'executive', 'director', 'manager', 'salesperson');
  if not found then
    raise exception using errcode = 'P0002', message = 'COMMERCE_SELLER_NOT_FOUND';
  end if;
  if not actor_is_global
     and not public.organization_is_descendant_v1(actor_profile.id, target_seller.id, true) then
    raise exception using errcode = '42501', message = 'COMMERCE_SELLER_OUTSIDE_SCOPE';
  end if;

  update public.commerce_rfqs
  set assigned_salesperson_id = target_seller.id,
      status = case when status = 'unassigned' then 'assigned' else status end
  where id = locked_rfq.id;

  return locked_rfq.id;
end;
$$;

create or replace function public.list_commerce_assignable_sellers_v2(input_rfq_id uuid)
returns table(id uuid, full_name text, email text, role text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  actor_is_global boolean;
begin
  select * into actor_profile
  from public.profiles
  where profiles.id = auth.uid() and profiles.is_active = true;
  if not found then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  actor_is_global := public.profile_role_has_capability(actor_profile.role, 'ADMIN');
  if not actor_is_global and actor_profile.role <> 'manager' then
    return;
  end if;
  if not public.commerce_can_access_rfq_v2(input_rfq_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_RFQ_FORBIDDEN';
  end if;

  return query
  select candidate.id, candidate.full_name, candidate.email, candidate.role::text
  from public.profiles candidate
  join public.organization_members member on member.profile_id = candidate.id
  where candidate.is_active = true
    and member.business_rank in ('owner', 'executive', 'director', 'manager', 'salesperson')
    and (
      actor_is_global
      or public.organization_is_descendant_v1(actor_profile.id, candidate.id, true)
    )
  order by candidate.full_name, candidate.id;
end;
$$;

create or replace function public.preview_commerce_rfq_pricing_v2(input_rfq_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  rfq_item public.commerce_rfq_items%rowtype;
  product public.commerce_catalog_products%rowtype;
  match_count bigint;
  matched_product_id uuid;
  preview jsonb := '[]'::jsonb;
begin
  if not public.commerce_can_access_rfq_v2(input_rfq_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_RFQ_FORBIDDEN';
  end if;

  for rfq_item in
    select *
    from public.commerce_rfq_items item
    where item.rfq_id = input_rfq_id
    order by item.line_number
  loop
    matched_product_id := null;
    select count(*), (array_agg(candidate.id order by candidate.id))[1]
    into match_count, matched_product_id
    from public.commerce_catalog_products candidate
    where candidate.is_active = true
      and upper(trim(candidate.mpn)) = upper(trim(rfq_item.mpn))
      and (
        nullif(trim(rfq_item.manufacturer), '') is null
        or upper(trim(candidate.manufacturer)) = upper(trim(rfq_item.manufacturer))
      );

    if match_count = 0 then
      preview := preview || jsonb_build_array(jsonb_build_object(
        'itemId', rfq_item.id,
        'status', 'required',
        'reason', 'catalog_not_found'
      ));
    elsif match_count > 1 then
      preview := preview || jsonb_build_array(jsonb_build_object(
        'itemId', rfq_item.id,
        'status', 'required',
        'reason', 'catalog_match_ambiguous'
      ));
    else
      select * into product
      from public.commerce_catalog_products
      where id = matched_product_id and is_active = true;

      if product.authorized_unit_price <= 0 then
        preview := preview || jsonb_build_array(jsonb_build_object(
          'itemId', rfq_item.id,
          'status', 'required',
          'reason', 'authorized_price_unavailable'
        ));
      elsif rfq_item.quantity < product.minimum_order_quantity then
        preview := preview || jsonb_build_array(jsonb_build_object(
          'itemId', rfq_item.id,
          'status', 'required',
          'reason', 'minimum_order_quantity',
          'minimumOrderQuantity', product.minimum_order_quantity
        ));
      else
        preview := preview || jsonb_build_array(jsonb_build_object(
          'itemId', rfq_item.id,
          'status', 'ready',
          'reason', null,
          'productId', product.id,
          'authorizedUnitPrice', product.authorized_unit_price,
          'currency', product.currency,
          'minimumOrderQuantity', product.minimum_order_quantity
        ));
      end if;
    end if;
  end loop;

  return preview;
end;
$$;

create or replace function public.create_commerce_client_from_rfq_v2(input_rfq_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  locked_rfq public.commerce_rfqs%rowtype;
  created_client public.clients%rowtype;
  snapshot jsonb;
  company_name text;
  contact_name text;
  contact_email text;
  preferred_language text;
  assigned_seller_id uuid;
begin
  select * into actor_profile
  from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select * into locked_rfq
  from public.commerce_rfqs
  where id = input_rfq_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND';
  end if;
  if not public.commerce_can_access_rfq_v2(locked_rfq.id) then
    raise exception using errcode = '42501', message = 'COMMERCE_RFQ_FORBIDDEN';
  end if;
  if locked_rfq.client_id is not null then
    return jsonb_build_object('clientId', locked_rfq.client_id, 'idempotent', true);
  end if;
  if locked_rfq.status not in ('unassigned', 'assigned', 'in_review') then
    raise exception using errcode = '55000', message = 'COMMERCE_RFQ_CLIENT_INVALID';
  end if;

  snapshot := locked_rfq.contact_snapshot;
  company_name := nullif(trim(snapshot->>'companyOrName'), '');
  contact_name := nullif(trim(snapshot->>'contact'), '');
  contact_email := lower(nullif(trim(snapshot->>'email'), ''));
  preferred_language := case
    when snapshot->>'preferredLanguage' in ('es', 'en', 'zh') then snapshot->>'preferredLanguage'
    else 'en'
  end;

  if jsonb_typeof(snapshot) <> 'object'
     or company_name is null
     or contact_name is null
     or contact_email is null
     or contact_email !~* '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'COMMERCE_RFQ_CONTACT_INVALID';
  end if;

  assigned_seller_id := coalesce(locked_rfq.assigned_salesperson_id, actor_profile.id);

  insert into public.clients (
    name, status, created_by, updated_by, assigned_salesperson_id
  ) values (
    left(company_name, 160), 'active', actor_profile.id, actor_profile.id, assigned_seller_id
  ) returning * into created_client;

  insert into public.commerce_client_details (
    client_id, contact_name, contact_email, contact_phone, country, city,
    preferred_language, commercial_notes
  ) values (
    created_client.id,
    left(contact_name, 160),
    left(contact_email, 254),
    nullif(left(trim(coalesce(snapshot->>'phone', '')), 60), ''),
    nullif(left(trim(coalesce(snapshot->>'country', '')), 100), ''),
    nullif(left(trim(coalesce(snapshot->>'city', '')), 120), ''),
    preferred_language,
    nullif(left(trim(coalesce(snapshot->>'notes', '')), 1500), '')
  );

  update public.commerce_rfqs
  set client_id = created_client.id,
      assigned_salesperson_id = coalesce(assigned_salesperson_id, assigned_seller_id),
      status = case when status = 'unassigned' then 'assigned' else status end
  where id = locked_rfq.id;

  return jsonb_build_object('clientId', created_client.id, 'idempotent', false);
end;
$$;

-- Generic quote creation is intentionally limited to quotes without an RFQ.
-- Every RFQ-backed quote must use the row-locked, catalog-resolving workflow
-- below; the v1 compatibility wrapper inherits this restriction.
create or replace function public.create_commerce_quote_v2(
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
  select * into actor_profile
  from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if input_rfq_id is not null then
    raise exception using errcode = '22023', message = 'COMMERCE_RFQ_WORKFLOW_REQUIRED';
  end if;
  if not public.commerce_can_manage_client_v2(input_client_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_CLIENT_FORBIDDEN';
  end if;
  if input_items is null
     or jsonb_typeof(input_items) <> 'array'
     or jsonb_array_length(input_items) < 1
     or jsonb_array_length(input_items) > 100
     or input_valid_until is null
     or input_valid_until < current_date
     or input_tax_rate is null
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
    where id = (requested_item->>'productId')::uuid and is_active = true
    for share;
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
  set subtotal = calculated_subtotal,
      tax = calculated_tax,
      total = calculated_total
  where id = created_quote.id;

  insert into public.commerce_quote_events (
    quote_id, actor_id, event_type, previous_status, new_status, metadata
  ) values (
    created_quote.id, actor_profile.id, 'created', null, 'draft',
    jsonb_build_object('version', 1)
  );

  return created_quote.id;
end;
$$;

create or replace function public.update_commerce_quote_v2(
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
  persisted_item public.commerce_quote_items%rowtype;
  linked_rfq_item public.commerce_rfq_items%rowtype;
  product public.commerce_catalog_products%rowtype;
  requested_item jsonb;
  item_index integer := 0;
  persisted_item_count integer;
  rfq_item_count integer;
  match_count bigint;
  matched_product_id uuid;
  requested_product_id uuid;
  requested_quantity bigint;
  requested_discount numeric;
  maximum_discount numeric;
  seller_price numeric;
  item_total numeric;
  calculated_subtotal numeric := 0;
  calculated_tax numeric;
  calculated_total numeric;
begin
  select * into actor_profile
  from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select * into locked_quote
  from public.commerce_quotes
  where id = input_quote_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND';
  end if;
  if not public.commerce_can_access_seller(locked_quote.seller_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_QUOTE_FORBIDDEN';
  end if;
  if locked_quote.version is distinct from input_expected_version then
    raise exception using errcode = '40001', message = 'COMMERCE_VERSION_CONFLICT';
  end if;
  if locked_quote.status <> 'draft' then
    raise exception using errcode = '55000', message = 'COMMERCE_TRANSITION_INVALID';
  end if;
  if input_rfq_id is distinct from locked_quote.rfq_id then
    raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_RFQ_IMMUTABLE';
  end if;
  if locked_quote.rfq_id is not null then
    if input_client_id is distinct from locked_quote.client_id then
      raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_CLIENT_IMMUTABLE';
    end if;
    if not public.commerce_can_access_rfq_v2(locked_quote.rfq_id) then
      raise exception using errcode = '42501', message = 'COMMERCE_RFQ_FORBIDDEN';
    end if;
    if not exists (
      select 1
      from public.commerce_rfqs rfq
      where rfq.id = locked_quote.rfq_id
        and rfq.client_id = locked_quote.client_id
    ) then
      raise exception using errcode = '23514', message = 'COMMERCE_RFQ_CLIENT_MISMATCH';
    end if;
    if not public.commerce_can_read_client_v2(input_client_id) then
      raise exception using errcode = '42501', message = 'COMMERCE_CLIENT_FORBIDDEN';
    end if;
  elsif not public.commerce_can_manage_client_v2(input_client_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_CLIENT_FORBIDDEN';
  end if;
  if input_items is null
     or jsonb_typeof(input_items) <> 'array'
     or jsonb_array_length(input_items) < 1
     or jsonb_array_length(input_items) > 100
     or input_valid_until is null
     or input_valid_until < current_date
     or input_tax_rate is null
     or input_tax_rate < 0 or input_tax_rate > 100 then
    raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_INVALID';
  end if;

  -- An RFQ-origin quote may change quantities, discounts and commercial
  -- fields, but its ordered product structure remains the persisted RFQ
  -- resolution. Validate before deleting any line so rejection is atomic.
  if locked_quote.rfq_id is not null then
    select count(*) into persisted_item_count
    from public.commerce_quote_items item
    where item.quote_id = locked_quote.id;

    select count(*) into rfq_item_count
    from public.commerce_rfq_items item
    where item.rfq_id = locked_quote.rfq_id;

    if persisted_item_count <> jsonb_array_length(input_items)
       or rfq_item_count <> persisted_item_count then
      raise exception using errcode = '23514', message = 'COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE';
    end if;

    item_index := 0;
    for persisted_item in
      select *
      from public.commerce_quote_items item
      where item.quote_id = locked_quote.id
      order by item.line_number
    loop
      item_index := item_index + 1;
      requested_item := input_items -> (item_index - 1);
      select * into linked_rfq_item
      from public.commerce_rfq_items item
      where item.rfq_id = locked_quote.rfq_id
        and item.line_number = item_index;
      if not found then
        raise exception using errcode = '23514', message = 'COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE';
      end if;
      if upper(trim(persisted_item.mpn)) is distinct from upper(trim(linked_rfq_item.mpn))
         or (
           nullif(trim(linked_rfq_item.manufacturer), '') is not null
           and upper(trim(persisted_item.manufacturer)) is distinct from upper(trim(linked_rfq_item.manufacturer))
         ) then
        raise exception using errcode = '23514', message = 'COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE';
      end if;
      if persisted_item.product_id is not null then
        if not exists (
          select 1
          from public.commerce_catalog_products candidate
          where candidate.id = persisted_item.product_id
            and candidate.is_active = true
            and upper(trim(candidate.mpn)) = upper(trim(linked_rfq_item.mpn))
            and (
              nullif(trim(linked_rfq_item.manufacturer), '') is null
              or upper(trim(candidate.manufacturer)) = upper(trim(linked_rfq_item.manufacturer))
            )
        ) then
          raise exception using errcode = '23514', message = 'COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE';
        end if;
      end if;
      begin
        requested_product_id := (requested_item->>'productId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '23514', message = 'COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE';
      end;

      if not (requested_item ? 'productId')
         or persisted_item.line_number <> item_index
         or linked_rfq_item.line_number <> item_index
         or requested_product_id is distinct from persisted_item.product_id then
        raise exception using errcode = '23514', message = 'COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE';
      end if;
    end loop;
    item_index := 0;
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

    begin
      requested_product_id := (requested_item->>'productId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_ITEM_INVALID';
    end;

    -- A null product is legal only for an unresolved RFQ-backed draft. On
    -- every save/refresh we may resolve it, but solely from the immutable RFQ
    -- MPN/manufacturer snapshot; a browser can never nominate a substitute.
    if requested_product_id is null then
      if locked_quote.rfq_id is null then
        raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_ITEM_INVALID';
      end if;

      select * into linked_rfq_item
      from public.commerce_rfq_items item
      where item.rfq_id = locked_quote.rfq_id
        and item.line_number = item_index;
      if not found then
        raise exception using errcode = '23514', message = 'COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE';
      end if;

      matched_product_id := null;
      select count(*), (array_agg(candidate.id order by candidate.id))[1]
      into match_count, matched_product_id
      from public.commerce_catalog_products candidate
      where candidate.is_active = true
        and upper(trim(candidate.mpn)) = upper(trim(linked_rfq_item.mpn))
        and (
          nullif(trim(linked_rfq_item.manufacturer), '') is null
          or upper(trim(candidate.manufacturer)) = upper(trim(linked_rfq_item.manufacturer))
        );

      if match_count = 1 then
        select * into product
        from public.commerce_catalog_products candidate
        where candidate.id = matched_product_id and candidate.is_active = true
        for share;
        if not found
           or product.authorized_unit_price <= 0
           or requested_quantity < product.minimum_order_quantity then
          requested_product_id := null;
        else
          requested_product_id := product.id;
        end if;
      else
        requested_product_id := null;
      end if;

      if requested_product_id is null then
        -- availability_revision=1 is a storage-only sentinel required by the
        -- existing positive constraint. API payloads mask it to null until
        -- a real catalog product and revision are resolved.
        insert into public.commerce_quote_items (
          quote_id, line_number, product_id, mpn, manufacturer, description,
          quantity, authorized_unit_price, seller_unit_price, discount_percent,
          currency, line_total, availability_revision
        ) values (
          locked_quote.id, item_index, null, linked_rfq_item.mpn,
          coalesce(linked_rfq_item.manufacturer, ''),
          coalesce(linked_rfq_item.description, ''), requested_quantity,
          0, 0, 0, 'USD', 0, 1
        );
        continue;
      end if;
    end if;

    select * into product
    from public.commerce_catalog_products
    where id = requested_product_id and is_active = true
    for share;
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
      locked_quote.id, item_index, product.id, product.mpn, product.manufacturer,
      product.description, requested_quantity, product.authorized_unit_price,
      seller_price, requested_discount, product.currency, item_total, product.revision
    );
  end loop;

  calculated_subtotal := round(calculated_subtotal, 2);
  calculated_tax := round(calculated_subtotal * input_tax_rate / 100, 2);
  calculated_total := round(calculated_subtotal + calculated_tax, 2);

  update public.commerce_quotes
  set client_id = input_client_id,
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
    locked_quote.id,
    actor_profile.id,
    'updated',
    'draft',
    'draft',
    jsonb_build_object('previousVersion', locked_quote.version, 'version', locked_quote.version + 1)
  );

  return locked_quote.id;
end;
$$;

create or replace function public.transition_commerce_quote_v2(
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
  select * into actor_profile
  from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select * into locked_quote
  from public.commerce_quotes
  where id = input_quote_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND';
  end if;
  if not public.commerce_can_access_seller(locked_quote.seller_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_QUOTE_FORBIDDEN';
  end if;
  if locked_quote.version is distinct from input_expected_version then
    raise exception using errcode = '40001', message = 'COMMERCE_VERSION_CONFLICT';
  end if;

  allowed := (
    (locked_quote.status = 'draft' and input_new_status in ('sent', 'expired'))
    or (locked_quote.status = 'sent' and input_new_status in ('accepted', 'rejected', 'expired'))
  );
  if not allowed then
    raise exception using errcode = '55000', message = 'COMMERCE_TRANSITION_INVALID';
  end if;
  if input_new_status = 'sent' and locked_quote.valid_until < current_date then
    raise exception using errcode = '23514', message = 'COMMERCE_QUOTE_VALIDITY_EXPIRED';
  end if;
  if input_new_status = 'sent' then
    -- Keep the catalog snapshot stable through the pricing check and status
    -- mutation so a concurrent catalog repricing cannot race quote sending.
    perform 1
    from public.commerce_quote_items item
    join public.commerce_catalog_products product on product.id = item.product_id
    where item.quote_id = locked_quote.id
    for share of product;
  end if;
  if input_new_status = 'sent' and (
    not exists (
      select 1 from public.commerce_quote_items item
      where item.quote_id = locked_quote.id
    )
    or exists (
      select 1 from public.commerce_quote_items item
      where item.quote_id = locked_quote.id
        and (
          item.product_id is null
          or item.authorized_unit_price <= 0
          or not exists (
            select 1
            from public.commerce_catalog_products product
            where product.id = item.product_id
              and product.is_active = true
              and product.revision is not distinct from item.availability_revision
              and product.authorized_unit_price is not distinct from item.authorized_unit_price
              and item.quantity >= product.minimum_order_quantity
          )
        )
    )
  ) then
    raise exception using errcode = '23514', message = 'COMMERCE_QUOTE_PRICING_REQUIRED';
  end if;

  update public.commerce_quotes
  set status = input_new_status,
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

create or replace function public.create_commerce_quote_from_rfq_v2(
  input_rfq_id uuid,
  input_valid_until date,
  input_notes text,
  input_commercial_terms text,
  input_tax_rate numeric default 7
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  locked_rfq public.commerce_rfqs%rowtype;
  existing_quote_id uuid;
  existing_quote_client_id uuid;
  existing_quote_seller_id uuid;
  existing_quote_count bigint;
  existing_quote_item public.commerce_quote_items%rowtype;
  existing_quote_item_count integer;
  created_quote public.commerce_quotes%rowtype;
  rfq_item public.commerce_rfq_items%rowtype;
  product public.commerce_catalog_products%rowtype;
  match_count bigint;
  matched_product_id uuid;
  quote_seller_id uuid;
  pricing_required jsonb := '[]'::jsonb;
  resolved_items jsonb := '[]'::jsonb;
  resolved_item jsonb;
  item_total numeric;
  calculated_subtotal numeric := 0;
  calculated_tax numeric := 0;
  calculated_total numeric := 0;
  rfq_item_count integer := 0;
  quote_item_index integer := 0;
begin
  select * into actor_profile
  from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  select * into locked_rfq
  from public.commerce_rfqs
  where id = input_rfq_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'COMMERCE_NOT_FOUND';
  end if;
  if not public.commerce_can_access_rfq_v2(locked_rfq.id) then
    raise exception using errcode = '42501', message = 'COMMERCE_RFQ_FORBIDDEN';
  end if;
  if locked_rfq.status = 'cancelled' then
    raise exception using errcode = '55000', message = 'COMMERCE_RFQ_QUOTE_INVALID';
  end if;
  if locked_rfq.client_id is null then
    raise exception using errcode = '23514', message = 'COMMERCE_RFQ_CLIENT_REQUIRED';
  end if;
  if not public.commerce_can_read_client_v2(locked_rfq.client_id) then
    raise exception using errcode = '42501', message = 'COMMERCE_CLIENT_FORBIDDEN';
  end if;

  -- The RFQ row lock serializes every supported create path. Generic quote
  -- creation rejects RFQ ids, so no second path can race this check/insert.
  select count(*) into existing_quote_count
  from public.commerce_quotes quote
  where quote.rfq_id = locked_rfq.id;

  if existing_quote_count > 1 then
    raise exception using errcode = '23514', message = 'COMMERCE_RFQ_QUOTE_INTEGRITY';
  end if;
  if existing_quote_count = 1 then
    select quote.id, quote.client_id, quote.seller_id
    into existing_quote_id, existing_quote_client_id, existing_quote_seller_id
    from public.commerce_quotes quote
    where quote.rfq_id = locked_rfq.id;

    if existing_quote_client_id is distinct from locked_rfq.client_id then
      raise exception using errcode = '23514', message = 'COMMERCE_RFQ_QUOTE_INTEGRITY';
    end if;
    if locked_rfq.assigned_salesperson_id is not null
       and existing_quote_seller_id is distinct from locked_rfq.assigned_salesperson_id then
      raise exception using errcode = '23514', message = 'COMMERCE_RFQ_QUOTE_INTEGRITY';
    end if;
    if not exists (
      select 1 from public.profiles seller
      where seller.id = existing_quote_seller_id and seller.is_active = true
    ) then
      raise exception using errcode = '23514', message = 'COMMERCE_RFQ_SELLER_INACTIVE';
    end if;

    select count(*) into rfq_item_count
    from public.commerce_rfq_items item
    where item.rfq_id = locked_rfq.id;
    select count(*) into existing_quote_item_count
    from public.commerce_quote_items item
    where item.quote_id = existing_quote_id;
    if rfq_item_count = 0 or existing_quote_item_count <> rfq_item_count then
      raise exception using errcode = '23514', message = 'COMMERCE_RFQ_QUOTE_INTEGRITY';
    end if;

    -- Rebuild the informational pending list from the persisted draft. This
    -- keeps retries idempotent without pretending unresolved pricing vanished.
    for rfq_item in
      select *
      from public.commerce_rfq_items item
      where item.rfq_id = locked_rfq.id
      order by item.line_number
    loop
      select * into existing_quote_item
      from public.commerce_quote_items item
      where item.quote_id = existing_quote_id
        and item.line_number = rfq_item.line_number;
      if not found then
        raise exception using errcode = '23514', message = 'COMMERCE_RFQ_QUOTE_INTEGRITY';
      end if;
      if upper(trim(existing_quote_item.mpn)) is distinct from upper(trim(rfq_item.mpn))
         or (
           nullif(trim(rfq_item.manufacturer), '') is not null
           and upper(trim(existing_quote_item.manufacturer)) is distinct from upper(trim(rfq_item.manufacturer))
         ) then
        raise exception using errcode = '23514', message = 'COMMERCE_RFQ_QUOTE_INTEGRITY';
      end if;
      if existing_quote_item.product_id is null
         or existing_quote_item.authorized_unit_price <= 0 then
        pricing_required := pricing_required || jsonb_build_array(jsonb_build_object(
          'itemId', rfq_item.id,
          'lineNumber', rfq_item.line_number,
          'mpn', rfq_item.mpn,
          'manufacturer', rfq_item.manufacturer,
          'reason', 'pricing_required'
        ));
      end if;
    end loop;

    update public.commerce_rfqs
    set status = 'quoted',
        assigned_salesperson_id = coalesce(assigned_salesperson_id, existing_quote_seller_id)
    where id = locked_rfq.id;

    return jsonb_build_object(
      'quoteId', existing_quote_id,
      'idempotent', true,
      'pricingRequired', pricing_required
    );
  end if;

  if locked_rfq.status = 'quoted' then
    raise exception using errcode = '23514', message = 'COMMERCE_RFQ_QUOTE_INTEGRITY';
  end if;
  if locked_rfq.status not in ('assigned', 'in_review') then
    raise exception using errcode = '55000', message = 'COMMERCE_RFQ_QUOTE_INVALID';
  end if;
  if input_valid_until is null
     or input_valid_until < current_date
     or input_tax_rate is null
     or input_tax_rate < 0 or input_tax_rate > 100 then
    raise exception using errcode = '22023', message = 'COMMERCE_QUOTE_INVALID';
  end if;

  quote_seller_id := coalesce(locked_rfq.assigned_salesperson_id, actor_profile.id);
  if not exists (
    select 1 from public.profiles seller
    where seller.id = quote_seller_id and seller.is_active = true
  ) then
    raise exception using errcode = '23514', message = 'COMMERCE_RFQ_SELLER_INACTIVE';
  end if;

  for rfq_item in
    select *
    from public.commerce_rfq_items item
    where item.rfq_id = locked_rfq.id
    order by item.line_number
  loop
    rfq_item_count := rfq_item_count + 1;
    matched_product_id := null;
    -- Every RFQ line becomes a quote line. Until catalog resolution and
    -- authorized pricing both succeed, this zero-valued placeholder is a
    -- technical draft state and must never be interpreted as a free offer.
    resolved_item := jsonb_build_object(
      'productId', null,
      'mpn', rfq_item.mpn,
      'manufacturer', coalesce(rfq_item.manufacturer, ''),
      'description', coalesce(rfq_item.description, ''),
      'quantity', rfq_item.quantity,
      'authorizedUnitPrice', 0,
      'currency', 'USD',
      'availabilityRevision', 1
    );

    select count(*), (array_agg(candidate.id order by candidate.id))[1]
    into match_count, matched_product_id
    from public.commerce_catalog_products candidate
    where candidate.is_active = true
      and upper(trim(candidate.mpn)) = upper(trim(rfq_item.mpn))
      and (
        nullif(trim(rfq_item.manufacturer), '') is null
        or upper(trim(candidate.manufacturer)) = upper(trim(rfq_item.manufacturer))
      );

    if match_count = 0 then
      pricing_required := pricing_required || jsonb_build_array(jsonb_build_object(
        'itemId', rfq_item.id,
        'lineNumber', rfq_item.line_number,
        'mpn', rfq_item.mpn,
        'manufacturer', rfq_item.manufacturer,
        'reason', 'catalog_not_found'
      ));
    elsif match_count > 1 then
      pricing_required := pricing_required || jsonb_build_array(jsonb_build_object(
        'itemId', rfq_item.id,
        'lineNumber', rfq_item.line_number,
        'mpn', rfq_item.mpn,
        'manufacturer', rfq_item.manufacturer,
        'reason', 'catalog_match_ambiguous'
      ));
    else
      select * into product
      from public.commerce_catalog_products
      where id = matched_product_id and is_active = true
      for share;

      if not found then
        pricing_required := pricing_required || jsonb_build_array(jsonb_build_object(
          'itemId', rfq_item.id,
          'lineNumber', rfq_item.line_number,
          'mpn', rfq_item.mpn,
          'manufacturer', rfq_item.manufacturer,
          'reason', 'catalog_not_found'
        ));
      elsif product.authorized_unit_price <= 0 then
        pricing_required := pricing_required || jsonb_build_array(jsonb_build_object(
          'itemId', rfq_item.id,
          'lineNumber', rfq_item.line_number,
          'mpn', rfq_item.mpn,
          'manufacturer', rfq_item.manufacturer,
          'reason', 'authorized_price_unavailable'
        ));
      elsif rfq_item.quantity < product.minimum_order_quantity then
        pricing_required := pricing_required || jsonb_build_array(jsonb_build_object(
          'itemId', rfq_item.id,
          'lineNumber', rfq_item.line_number,
          'mpn', rfq_item.mpn,
          'manufacturer', rfq_item.manufacturer,
          'reason', 'minimum_order_quantity',
          'minimumOrderQuantity', product.minimum_order_quantity
        ));
      else
        resolved_item := jsonb_build_object(
          'productId', product.id,
          'mpn', product.mpn,
          'manufacturer', product.manufacturer,
          'description', product.description,
          'quantity', rfq_item.quantity,
          'authorizedUnitPrice', product.authorized_unit_price,
          'currency', product.currency,
          'availabilityRevision', product.revision
        );
      end if;
    end if;
    resolved_items := resolved_items || jsonb_build_array(resolved_item);
  end loop;

  if rfq_item_count = 0 then
    raise exception using errcode = '22023', message = 'COMMERCE_RFQ_ITEMS_REQUIRED';
  end if;
  insert into public.commerce_quotes (
    rfq_id, client_id, seller_id, valid_until, notes, commercial_terms, tax_rate
  ) values (
    locked_rfq.id,
    locked_rfq.client_id,
    quote_seller_id,
    input_valid_until,
    left(coalesce(input_notes, ''), 2000),
    left(coalesce(input_commercial_terms, ''), 3000),
    round(input_tax_rate, 4)
  ) returning * into created_quote;

  for resolved_item in select value from jsonb_array_elements(resolved_items)
  loop
    quote_item_index := quote_item_index + 1;
    item_total := round(
      (resolved_item->>'authorizedUnitPrice')::numeric
      * (resolved_item->>'quantity')::bigint,
      2
    );
    calculated_subtotal := calculated_subtotal + item_total;

    insert into public.commerce_quote_items (
      quote_id, line_number, product_id, mpn, manufacturer, description,
      quantity, authorized_unit_price, seller_unit_price, discount_percent,
      currency, line_total, availability_revision
    ) values (
      created_quote.id,
      quote_item_index,
      (resolved_item->>'productId')::uuid,
      resolved_item->>'mpn',
      resolved_item->>'manufacturer',
      resolved_item->>'description',
      (resolved_item->>'quantity')::bigint,
      (resolved_item->>'authorizedUnitPrice')::numeric,
      (resolved_item->>'authorizedUnitPrice')::numeric,
      0,
      resolved_item->>'currency',
      item_total,
      (resolved_item->>'availabilityRevision')::integer
    );
  end loop;

  calculated_subtotal := round(calculated_subtotal, 2);
  calculated_tax := round(calculated_subtotal * input_tax_rate / 100, 2);
  calculated_total := round(calculated_subtotal + calculated_tax, 2);

  update public.commerce_quotes
  set subtotal = calculated_subtotal,
      tax = calculated_tax,
      total = calculated_total
  where id = created_quote.id;

  insert into public.commerce_quote_events (
    quote_id, actor_id, event_type, previous_status, new_status, metadata
  ) values (
    created_quote.id,
    actor_profile.id,
    'created',
    null,
    'draft',
    jsonb_build_object('version', 1, 'origin', 'rfq')
  );

  -- This is deliberately the final business-state mutation. If any quote or
  -- item write fails, the transaction rolls back and the RFQ is not quoted.
  update public.commerce_rfqs
  set status = 'quoted',
      assigned_salesperson_id = coalesce(assigned_salesperson_id, quote_seller_id)
  where id = locked_rfq.id;

  return jsonb_build_object(
    'quoteId', created_quote.id,
    'idempotent', false,
    'pricingRequired', pricing_required
  );
end;
$$;

-- Compatibility wrappers keep migration-before-deploy safe while routing every
-- legacy API call through the hardened v2 authorization and integrity rules.
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
language sql
security invoker
set search_path = pg_catalog, public
as $$
  select public.create_commerce_quote_v2(
    input_client_id,
    input_rfq_id,
    input_items,
    input_valid_until,
    input_notes,
    input_commercial_terms,
    input_tax_rate
  );
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
language sql
security invoker
set search_path = pg_catalog, public
as $$
  select public.update_commerce_quote_v2(
    input_quote_id,
    input_expected_version,
    input_client_id,
    input_rfq_id,
    input_items,
    input_valid_until,
    input_notes,
    input_commercial_terms,
    input_tax_rate
  );
$$;

create or replace function public.transition_commerce_quote_v1(
  input_quote_id uuid,
  input_expected_version integer,
  input_new_status text,
  input_reason text default null
)
returns uuid
language sql
security invoker
set search_path = pg_catalog, public
as $$
  select public.transition_commerce_quote_v2(
    input_quote_id,
    input_expected_version,
    input_new_status,
    input_reason
  );
$$;

revoke all on function public.mark_commerce_rfq_in_review_v2(uuid) from public, anon;
revoke all on function public.assign_commerce_rfq_seller_v2(uuid, uuid) from public, anon;
revoke all on function public.list_commerce_assignable_sellers_v2(uuid) from public, anon;
revoke all on function public.preview_commerce_rfq_pricing_v2(uuid) from public, anon;
revoke all on function public.create_commerce_client_from_rfq_v2(uuid) from public, anon;
revoke all on function public.create_commerce_quote_v2(uuid, uuid, jsonb, date, text, text, numeric) from public, anon;
revoke all on function public.update_commerce_quote_v2(uuid, integer, uuid, uuid, jsonb, date, text, text, numeric) from public, anon;
revoke all on function public.transition_commerce_quote_v2(uuid, integer, text, text) from public, anon;
revoke all on function public.create_commerce_quote_from_rfq_v2(uuid, date, text, text, numeric) from public, anon;

grant execute on function public.mark_commerce_rfq_in_review_v2(uuid) to authenticated;
grant execute on function public.assign_commerce_rfq_seller_v2(uuid, uuid) to authenticated;
grant execute on function public.list_commerce_assignable_sellers_v2(uuid) to authenticated;
grant execute on function public.preview_commerce_rfq_pricing_v2(uuid) to authenticated;
grant execute on function public.create_commerce_client_from_rfq_v2(uuid) to authenticated;
grant execute on function public.create_commerce_quote_v2(uuid, uuid, jsonb, date, text, text, numeric) to authenticated;
grant execute on function public.update_commerce_quote_v2(uuid, integer, uuid, uuid, jsonb, date, text, text, numeric) to authenticated;
grant execute on function public.transition_commerce_quote_v2(uuid, integer, text, text) to authenticated;
grant execute on function public.create_commerce_quote_from_rfq_v2(uuid, date, text, text, numeric) to authenticated;
grant execute on function public.create_commerce_quote_v1(uuid, uuid, jsonb, date, text, text, numeric) to authenticated;
grant execute on function public.update_commerce_quote_v1(uuid, integer, uuid, uuid, jsonb, date, text, text, numeric) to authenticated;
grant execute on function public.transition_commerce_quote_v1(uuid, integer, text, text) to authenticated;

comment on function public.commerce_can_access_rfq_v2(uuid) is
  'Exact RFQ scope: technical admins globally, managers through organization descendants, sellers only themselves.';
comment on function public.create_commerce_client_from_rfq_v2(uuid) is
  'Human-triggered, row-lock-idempotent conversion of an authorized RFQ prospect into a client.';
comment on function public.create_commerce_quote_from_rfq_v2(uuid, date, text, text, numeric) is
  'Atomically resolves RFQ lines against the seller-safe catalog and marks the RFQ quoted only after quote persistence.';

commit;
