begin;

-- Fail closed instead of waiting indefinitely for owned public-table DDL locks.
-- Supabase-managed Auth tables are read below but are never altered by R8.4.
-- Production rollout still schedules a quiet window and inspects table size.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- R8.4. Idempotent Auth/Profile provisioning and conservative reconciliation.
-- Historical R8.3 rows deliberately keep NULL idempotency fields. No password,
-- plaintext target email, token, or credential is persisted here.

alter table public.user_provisioning_intents
  add column idempotency_key uuid,
  add column request_fingerprint bytea,
  add column fingerprint_version smallint,
  add column attempt_count integer not null default 0,
  add column last_attempt_at timestamptz;

alter table public.user_provisioning_intents
  add constraint user_provisioning_intents_r84_fingerprint_check check (
    (
      idempotency_key is null
      and request_fingerprint is null
      and fingerprint_version is null
      and attempt_count = 0
      and last_attempt_at is null
    )
    or (
      idempotency_key is not null
      and request_fingerprint is not null
      and fingerprint_version is not null
      and pg_catalog.octet_length(request_fingerprint) = 32
      and fingerprint_version = 1
      and attempt_count >= 1
      and last_attempt_at is not null
    )
  );

comment on column public.user_provisioning_intents.idempotency_key is
  'R8.4 opaque UUID for one logical provisioning operation; NULL only for legacy rows.';
comment on column public.user_provisioning_intents.request_fingerprint is
  'SHA-256 of the normalized non-secret provisioning payload. Never includes a password or credential.';
comment on column public.user_provisioning_intents.fingerprint_version is
  'Canonical request fingerprint version; NULL for legacy rows.';

create unique index user_provisioning_intents_idempotency_uidx
  on public.user_provisioning_intents (idempotency_key)
  where idempotency_key is not null;

create unique index user_provisioning_intents_r84_email_uidx
  on public.user_provisioning_intents (requested_email_hash)
  where idempotency_key is not null;

create index user_provisioning_intents_email_hash_idx
  on public.user_provisioning_intents (requested_email_hash);

create index user_provisioning_intents_status_created_idx
  on public.user_provisioning_intents (status, created_at, id);

-- Profiles is an application-owned table, so the secondary email defense can
-- remain indexed there. auth.users is managed by Supabase Auth and is only
-- read: at the current scale, the occasional defensive/administrative scan is
-- preferable to requiring incompatible ownership or a shadow Auth table.
create index profiles_provisioning_email_hash_idx
  on public.profiles ((extensions.digest(pg_catalog.lower(pg_catalog.btrim(email)), 'sha256')));

-- Reconciliation reads current user_metadata and historical app_metadata
-- locators directly from auth.users. Those paths are targeted and
-- operator-driven; R8.4 deliberately creates no DDL in the auth schema.

create unique index audit_logs_user_provisioning_completed_uidx
  on public.audit_logs (entity_id)
  where action = 'user_provisioning_completed'
    and entity_type = 'user_provisioning_intent';

create unique index audit_logs_user_provisioning_reconciled_uidx
  on public.audit_logs (entity_id)
  where action = 'user_provisioning_reconciled'
    and entity_type = 'user_provisioning_intent';

create or replace function public.user_provisioning_request_fingerprint_v1(
  input_email text,
  input_full_name text,
  input_role text,
  input_department text,
  input_region text,
  input_is_active boolean,
  input_bio text,
  input_job_title text
)
returns bytea
language sql
immutable
security definer
set search_path = pg_catalog, extensions
as $$
  select extensions.digest(
    pg_catalog.convert_to(
      (
        pg_catalog.jsonb_build_object(
          'domain', 'quiksol:user-provisioning:v1',
          'email', pg_catalog.lower(pg_catalog.btrim(input_email)),
          'fullName', pg_catalog.btrim(input_full_name),
          'role', input_role,
          'department', nullif(pg_catalog.btrim(input_department), ''),
          'region', nullif(pg_catalog.btrim(input_region), ''),
          'isActive', input_is_active,
          'bio', nullif(pg_catalog.btrim(input_bio), ''),
          'jobTitle', nullif(pg_catalog.btrim(input_job_title), '')
        )
      )::text,
      'UTF8'
    ),
    'sha256'
  )
$$;

revoke all on function public.user_provisioning_request_fingerprint_v1(text, text, text, text, text, boolean, text, text) from public, anon, authenticated, service_role;
alter function public.user_provisioning_request_fingerprint_v1(text, text, text, text, text, boolean, text, text) owner to postgres;

-- All future inserts, including compatible v1 callers during the additive
-- rollout, share the email mutex. v1 remains callable but can no longer mint a
-- second operation for an email already claimed by an intent.
create or replace function public.guard_user_provisioning_intent_insert_v2()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  conflicting_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'quiksol:user-provisioning:email:' || pg_catalog.encode(new.requested_email_hash, 'hex'),
      8401
    )
  );

  select intent.status
  into conflicting_status
  from public.user_provisioning_intents intent
  where intent.requested_email_hash = new.requested_email_hash
  order by case when intent.status = 'completed' then 0 else 1 end, intent.id
  limit 1
  for update;

  if found then
    if conflicting_status = 'completed' then
      raise exception using errcode = 'QS842', message = 'USER_ALREADY_PROVISIONED';
    end if;
    raise exception using errcode = 'QS843', message = 'PROVISIONING_IN_PROGRESS';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_user_provisioning_intent_insert_v2() from public, anon, authenticated, service_role;
alter function public.guard_user_provisioning_intent_insert_v2() owner to postgres;

drop trigger if exists user_provisioning_intents_insert_guard_v2 on public.user_provisioning_intents;
create trigger user_provisioning_intents_insert_guard_v2
before insert on public.user_provisioning_intents
for each row execute function public.guard_user_provisioning_intent_insert_v2();

create or replace function public.begin_user_provisioning_internal_v2(
  input_source text,
  input_actor_profile_id uuid,
  input_idempotency_key uuid,
  input_email text,
  input_full_name text,
  input_role text,
  input_department text,
  input_region text,
  input_is_active boolean,
  input_bio text,
  input_job_title text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_email text;
  normalized_full_name text;
  normalized_department text;
  normalized_region text;
  normalized_bio text;
  normalized_job_title text;
  email_hash bytea;
  canonical_fingerprint bytea;
  actor_profile public.profiles%rowtype;
  existing_intent public.user_provisioning_intents%rowtype;
  created_intent public.user_provisioning_intents%rowtype;
  completed_consistent boolean;
begin
  normalized_email := pg_catalog.lower(pg_catalog.btrim(input_email));
  normalized_full_name := pg_catalog.btrim(input_full_name);
  normalized_department := nullif(pg_catalog.btrim(input_department), '');
  normalized_region := nullif(pg_catalog.btrim(input_region), '');
  normalized_bio := nullif(pg_catalog.btrim(input_bio), '');
  normalized_job_title := nullif(pg_catalog.btrim(input_job_title), '');

  if input_idempotency_key is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if input_source not in ('admin_api', 'provision_admin_cli') then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_SOURCE_INVALID';
  end if;
  if normalized_email is null
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_EMAIL_INVALID';
  end if;
  if normalized_full_name is null or normalized_full_name = '' then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_FULL_NAME_INVALID';
  end if;
  if input_role is null
     or input_role not in ('admin', 'manager', 'employee', 'super_admin_dev') then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_ROLE_INVALID';
  end if;
  if input_is_active is null then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_ACTIVE_INVALID';
  end if;
  if normalized_bio is not null and pg_catalog.char_length(normalized_bio) > 500 then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_BIO_INVALID';
  end if;
  if normalized_job_title is not null and pg_catalog.char_length(normalized_job_title) > 120 then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_JOB_TITLE_INVALID';
  end if;

  if input_source = 'admin_api' then
    if input_actor_profile_id is null or input_actor_profile_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
    end if;

    select profile.*
    into actor_profile
    from public.profiles profile
    join auth.users auth_user on auth_user.id = profile.id
    where profile.id = input_actor_profile_id
      and profile.is_active is true
      and public.profile_role_has_capability(profile.role, 'ADMIN')
      and auth_user.email_confirmed_at is not null
      and (auth_user.banned_until is null or auth_user.banned_until <= pg_catalog.now())
    for share of profile;

    if not found then
      raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
    end if;
    if input_role = 'super_admin_dev'
       and not public.profile_role_has_capability(actor_profile.role, 'SUPERADMIN') then
      raise exception using errcode = '42501', message = 'SUPER_ADMIN_DEV_REQUIRED';
    end if;
  else
    if auth.role() is distinct from 'service_role' then
      raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
    end if;
    if input_actor_profile_id is not null then
      raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_CLI_ACTOR_INVALID';
    end if;
    if input_role not in ('admin', 'super_admin_dev') then
      raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_CLI_ROLE_INVALID';
    end if;
  end if;

  email_hash := extensions.digest(normalized_email, 'sha256');
  canonical_fingerprint := public.user_provisioning_request_fingerprint_v1(
    normalized_email,
    normalized_full_name,
    input_role,
    normalized_department,
    normalized_region,
    input_is_active,
    normalized_bio,
    normalized_job_title
  );

  -- A key always locks before an email. Every v2 invocation follows this order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'quiksol:user-provisioning:key:' || input_idempotency_key::text,
      8402
    )
  );

  select intent.*
  into existing_intent
  from public.user_provisioning_intents intent
  where intent.idempotency_key = input_idempotency_key
  for update;

  if found then
    if existing_intent.source is distinct from input_source
       or existing_intent.actor_profile_id is distinct from input_actor_profile_id
       or existing_intent.fingerprint_version is distinct from 1
       or existing_intent.request_fingerprint is distinct from canonical_fingerprint then
      raise exception using errcode = 'QS841', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;

    if existing_intent.status = 'completed' then
      select exists (
        select 1
        from auth.users auth_user
        join public.profiles profile on profile.id = auth_user.id
        where auth_user.id = existing_intent.auth_user_id
          and extensions.digest(
            pg_catalog.lower(pg_catalog.btrim(auth_user.email)),
            'sha256'
          ) = existing_intent.requested_email_hash
          and pg_catalog.lower(pg_catalog.btrim(profile.email)) =
              pg_catalog.lower(pg_catalog.btrim(auth_user.email))
      ) into completed_consistent;

      if not completed_consistent then
        raise exception using errcode = 'QS846', message = 'RECONCILIATION_MISMATCH';
      end if;
    end if;

    update public.user_provisioning_intents intent
    set attempt_count = intent.attempt_count + 1,
        last_attempt_at = pg_catalog.clock_timestamp()
    where intent.id = existing_intent.id
    returning intent.* into existing_intent;

    return pg_catalog.jsonb_build_object(
      'state', case
        when existing_intent.status = 'completed' then 'EXISTING_COMPLETED'
        else 'EXISTING_PENDING'
      end,
      'intent_id', existing_intent.id,
      'auth_user_id', existing_intent.auth_user_id,
      'role', existing_intent.requested_role,
      'status', existing_intent.status,
      'attempt_count', existing_intent.attempt_count
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'quiksol:user-provisioning:email:' || pg_catalog.encode(email_hash, 'hex'),
      8401
    )
  );

  perform 1
  from public.user_provisioning_intents intent
  where intent.requested_email_hash = email_hash
  order by intent.id
  for update;

  if exists (
    select 1 from public.user_provisioning_intents intent
    where intent.requested_email_hash = email_hash
      and intent.status = 'completed'
  ) then
    raise exception using errcode = 'QS842', message = 'USER_ALREADY_PROVISIONED';
  end if;
  if exists (
    select 1 from public.user_provisioning_intents intent
    where intent.requested_email_hash = email_hash
      and intent.status = 'pending'
  ) then
    raise exception using errcode = 'QS843', message = 'PROVISIONING_IN_PROGRESS';
  end if;
  if exists (
    select 1 from auth.users auth_user
    where auth_user.email is not null
      and extensions.digest(
        pg_catalog.lower(pg_catalog.btrim(auth_user.email)),
        'sha256'
      ) = email_hash
  ) or exists (
    select 1 from public.profiles profile
    where extensions.digest(
      pg_catalog.lower(pg_catalog.btrim(profile.email)),
      'sha256'
    ) = email_hash
  ) then
    raise exception using errcode = 'QS842', message = 'USER_ALREADY_PROVISIONED';
  end if;

  insert into public.user_provisioning_intents (
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
  ) values (
    input_source,
    input_actor_profile_id,
    email_hash,
    input_role,
    normalized_full_name,
    normalized_department,
    normalized_region,
    input_is_active,
    normalized_bio,
    normalized_job_title,
    input_idempotency_key,
    canonical_fingerprint,
    1,
    1,
    pg_catalog.clock_timestamp()
  )
  returning * into created_intent;

  return pg_catalog.jsonb_build_object(
    'state', 'NEW',
    'intent_id', created_intent.id,
    'auth_user_id', null,
    'role', created_intent.requested_role,
    'status', created_intent.status,
    'attempt_count', created_intent.attempt_count
  );
end;
$$;

create or replace function public.begin_user_provisioning_v2(
  operation_idempotency_key uuid,
  requested_email text,
  requested_full_name text,
  requested_role text,
  requested_department text default null,
  requested_region text default null,
  requested_is_active boolean default true,
  requested_bio text default null,
  requested_job_title text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select public.begin_user_provisioning_internal_v2(
    'admin_api',
    auth.uid(),
    operation_idempotency_key,
    requested_email,
    requested_full_name,
    requested_role,
    requested_department,
    requested_region,
    requested_is_active,
    requested_bio,
    requested_job_title
  )
$$;

create or replace function public.begin_cli_user_provisioning_v2(
  operation_idempotency_key uuid,
  requested_email text,
  requested_full_name text,
  requested_role text,
  requested_department text default null,
  requested_region text default null,
  requested_is_active boolean default true,
  requested_bio text default null,
  requested_job_title text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select public.begin_user_provisioning_internal_v2(
    'provision_admin_cli',
    null,
    operation_idempotency_key,
    requested_email,
    requested_full_name,
    requested_role,
    requested_department,
    requested_region,
    requested_is_active,
    requested_bio,
    requested_job_title
  )
$$;

revoke all on function public.begin_user_provisioning_internal_v2(text, uuid, uuid, text, text, text, text, text, boolean, text, text) from public, anon, authenticated, service_role;
revoke all on function public.begin_user_provisioning_v2(uuid, text, text, text, text, text, boolean, text, text) from public, anon, authenticated, service_role;
revoke all on function public.begin_cli_user_provisioning_v2(uuid, text, text, text, text, text, boolean, text, text) from public, anon, authenticated, service_role;
grant execute on function public.begin_user_provisioning_v2(uuid, text, text, text, text, text, boolean, text, text) to authenticated;
grant execute on function public.begin_cli_user_provisioning_v2(uuid, text, text, text, text, text, boolean, text, text) to service_role;

alter function public.begin_user_provisioning_internal_v2(text, uuid, uuid, text, text, text, text, text, boolean, text, text) owner to postgres;
alter function public.begin_user_provisioning_v2(uuid, text, text, text, text, text, boolean, text, text) owner to postgres;
alter function public.begin_cli_user_provisioning_v2(uuid, text, text, text, text, text, boolean, text, text) owner to postgres;

-- R8.4 makes the lifecycle success audit part of the Auth INSERT transaction.
-- The creation channel remains raw_user_meta_data only; raw_app_meta_data is
-- read solely by the historical reconciliation classifier below.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  raw_intent_id text;
  target_intent_id uuid;
  target_intent public.user_provisioning_intents%rowtype;
  normalized_auth_email text;
begin
  raw_intent_id := nullif(
    pg_catalog.btrim(new.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  );

  if raw_intent_id is null then
    if public.user_provisioning_intent_required_v1() then
      raise exception using errcode = 'QS831', message = 'PROVISIONING_INTENT_REQUIRED';
    end if;

    insert into public.profiles (id, full_name, email, role, department, region)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'full_name', pg_catalog.split_part(new.email, '@', 1), 'Quiksol User'),
      coalesce(new.email, ''),
      'employee',
      null,
      null
    )
    on conflict (id) do nothing;
    return new;
  end if;

  begin
    target_intent_id := raw_intent_id::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'QS832', message = 'PROVISIONING_INTENT_ID_INVALID';
  end;

  select intent.*
  into target_intent
  from public.user_provisioning_intents intent
  where intent.id = target_intent_id
  for update;

  if not found then
    raise exception using errcode = 'QS833', message = 'PROVISIONING_INTENT_NOT_FOUND';
  end if;
  if target_intent.status <> 'pending'
     or target_intent.auth_user_id is not null
     or target_intent.completed_at is not null then
    raise exception using errcode = 'QS834', message = 'PROVISIONING_INTENT_ALREADY_CONSUMED';
  end if;
  if target_intent.source not in ('admin_api', 'provision_admin_cli')
     or target_intent.requested_role not in ('admin', 'manager', 'employee', 'super_admin_dev')
     or nullif(pg_catalog.btrim(target_intent.requested_full_name), '') is null
     or target_intent.requested_is_active is null
     or pg_catalog.octet_length(target_intent.requested_email_hash) <> 32 then
    raise exception using errcode = 'QS836', message = 'PROVISIONING_INTENT_PAYLOAD_INVALID';
  end if;

  normalized_auth_email := pg_catalog.lower(pg_catalog.btrim(new.email));
  if normalized_auth_email is null
     or extensions.digest(normalized_auth_email, 'sha256') <> target_intent.requested_email_hash then
    raise exception using errcode = 'QS835', message = 'PROVISIONING_INTENT_EMAIL_MISMATCH';
  end if;

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
  ) values (
    new.id,
    pg_catalog.btrim(target_intent.requested_full_name),
    normalized_auth_email,
    target_intent.requested_role,
    target_intent.requested_department,
    target_intent.requested_region,
    target_intent.requested_bio,
    target_intent.requested_job_title,
    target_intent.requested_is_active
  );

  update public.user_provisioning_intents intent
  set status = 'completed',
      auth_user_id = new.id,
      completed_at = pg_catalog.clock_timestamp()
  where intent.id = target_intent_id
    and intent.status = 'pending';

  if not found then
    raise exception using errcode = 'QS834', message = 'PROVISIONING_INTENT_ALREADY_CONSUMED';
  end if;

  insert into public.audit_logs (
    actor_id,
    actor_email,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    target_intent.actor_profile_id,
    null,
    'user_provisioning_completed',
    'user_provisioning_intent',
    target_intent.id,
    pg_catalog.jsonb_build_object(
      'source', target_intent.source,
      'requestedRole', target_intent.requested_role,
      'authUserId', new.id
    )
  );

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
alter function public.handle_new_user() owner to postgres;

create or replace function public.classify_user_provisioning_intent_v1(
  target_intent_id uuid
)
returns table(
  intent_id uuid,
  technical_auth_user_id uuid,
  classification text,
  locator_channel text,
  intent_status text,
  created_at timestamptz,
  completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  target_intent public.user_provisioning_intents%rowtype;
  candidate_auth auth.users%rowtype;
  target_profile public.profiles%rowtype;
  candidate_count integer;
  other_claim_count integer;
  user_locator boolean;
  app_locator boolean;
begin
  select intent.*
  into target_intent
  from public.user_provisioning_intents intent
  where intent.id = target_intent_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'PROVISIONING_INTENT_NOT_FOUND';
  end if;

  intent_id := target_intent.id;
  technical_auth_user_id := null;
  locator_channel := 'NONE';
  intent_status := target_intent.status;
  created_at := target_intent.created_at;
  completed_at := target_intent.completed_at;

  if target_intent.status = 'completed' then
    technical_auth_user_id := target_intent.auth_user_id;

    select auth_user.*
    into candidate_auth
    from auth.users auth_user
    where auth_user.id = target_intent.auth_user_id;

    if not found then
      classification := 'COMPLETED_AUTH_MISSING';
      return next;
      return;
    end if;

    user_locator := nullif(
      pg_catalog.btrim(candidate_auth.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
      ''
    ) = target_intent.id::text;
    app_locator := nullif(
      pg_catalog.btrim(candidate_auth.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
      ''
    ) = target_intent.id::text;
    locator_channel := case
      when user_locator and app_locator then 'BOTH'
      when user_locator then 'USER_METADATA'
      when app_locator then 'APP_METADATA'
      else 'NONE'
    end;


    if (
      user_locator
      and nullif(
        pg_catalog.btrim(candidate_auth.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
        ''
      ) is not null
      and not app_locator
    ) or (
      app_locator
      and nullif(
        pg_catalog.btrim(candidate_auth.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
        ''
      ) is not null
      and not user_locator
    ) then
      classification := 'AMBIGUOUS';
      return next;
      return;
    end if;

    select profile.*
    into target_profile
    from public.profiles profile
    where profile.id = candidate_auth.id;

    if not found then
      classification := 'COMPLETED_PROFILE_MISSING';
      return next;
      return;
    end if;

    select count(*)::integer
    into other_claim_count
    from public.user_provisioning_intents intent
    where intent.id <> target_intent.id
      and intent.auth_user_id = candidate_auth.id;

    if candidate_auth.email is null
       or extensions.digest(
         pg_catalog.lower(pg_catalog.btrim(candidate_auth.email)),
         'sha256'
       ) <> target_intent.requested_email_hash
       or pg_catalog.lower(pg_catalog.btrim(target_profile.email)) is distinct from
          pg_catalog.lower(pg_catalog.btrim(candidate_auth.email))
       or other_claim_count <> 0 then
      classification := 'AMBIGUOUS';
    else
      classification := 'COMPLETED_CONSISTENT';
    end if;
    return next;
    return;
  end if;

  select count(*)::integer
  into candidate_count
  from auth.users auth_user
  where nullif(
      pg_catalog.btrim(auth_user.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
      ''
    ) = target_intent.id::text
    or nullif(
      pg_catalog.btrim(auth_user.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
      ''
    ) = target_intent.id::text;

  if candidate_count = 0 then
    classification := 'PENDING_NO_AUTH';
    return next;
    return;
  end if;
  if candidate_count <> 1 then
    classification := 'AMBIGUOUS';
    return next;
    return;
  end if;

  select auth_user.*
  into candidate_auth
  from auth.users auth_user
  where nullif(
      pg_catalog.btrim(auth_user.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
      ''
    ) = target_intent.id::text
    or nullif(
      pg_catalog.btrim(auth_user.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
      ''
    ) = target_intent.id::text;

  technical_auth_user_id := candidate_auth.id;
  user_locator := nullif(
    pg_catalog.btrim(candidate_auth.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  ) = target_intent.id::text;
  app_locator := nullif(
    pg_catalog.btrim(candidate_auth.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  ) = target_intent.id::text;
  locator_channel := case
    when user_locator and app_locator then 'BOTH'
    when user_locator then 'USER_METADATA'
    when app_locator then 'APP_METADATA'
    else 'NONE'
  end;

  -- One Auth row carrying two different non-empty locators is never an exact
  -- historical match for either intent. This also prevents concurrent apply
  -- attempts from surfacing a raw unique-violation race.
  if (
    user_locator
    and nullif(
      pg_catalog.btrim(candidate_auth.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
      ''
    ) is not null
    and not app_locator
  ) or (
    app_locator
    and nullif(
      pg_catalog.btrim(candidate_auth.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
      ''
    ) is not null
    and not user_locator
  ) then
    classification := 'AMBIGUOUS';
    return next;
    return;
  end if;

  if candidate_auth.email is null
     or extensions.digest(
       pg_catalog.lower(pg_catalog.btrim(candidate_auth.email)),
       'sha256'
     ) <> target_intent.requested_email_hash then
    classification := 'AMBIGUOUS';
    return next;
    return;
  end if;

  select profile.*
  into target_profile
  from public.profiles profile
  where profile.id = candidate_auth.id;

  if not found then
    classification := 'PENDING_AUTH_NO_PROFILE';
    return next;
    return;
  end if;

  select count(*)::integer
  into other_claim_count
  from public.user_provisioning_intents intent
  where intent.id <> target_intent.id
    and intent.auth_user_id = candidate_auth.id;

  if other_claim_count = 0
     and pg_catalog.btrim(target_profile.full_name) = target_intent.requested_full_name
     and pg_catalog.lower(pg_catalog.btrim(target_profile.email)) =
         pg_catalog.lower(pg_catalog.btrim(candidate_auth.email))
     and target_profile.role = target_intent.requested_role
     and nullif(pg_catalog.btrim(target_profile.department), '') is not distinct from target_intent.requested_department
     and nullif(pg_catalog.btrim(target_profile.region), '') is not distinct from target_intent.requested_region
     and target_profile.is_active is not distinct from target_intent.requested_is_active
     and nullif(pg_catalog.btrim(target_profile.bio), '') is not distinct from target_intent.requested_bio
     and nullif(pg_catalog.btrim(target_profile.job_title), '') is not distinct from target_intent.requested_job_title then
    classification := 'PENDING_AUTH_PROFILE_MATCH';
  else
    classification := 'PENDING_AUTH_PROFILE_MISMATCH';
  end if;

  return next;
end;
$$;

revoke all on function public.classify_user_provisioning_intent_v1(uuid) from public, anon, authenticated, service_role;
alter function public.classify_user_provisioning_intent_v1(uuid) owner to postgres;

create or replace function public.preview_user_provisioning_reconciliation_v1(
  target_intent_id uuid default null
)
returns table(
  intent_id uuid,
  technical_auth_user_id uuid,
  classification text,
  locator_channel text,
  intent_status text,
  created_at timestamptz,
  completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;

  if target_intent_id is not null then
    return query
    select classified.*
    from public.classify_user_provisioning_intent_v1(target_intent_id) classified;
    return;
  end if;

  return query
  select classified.*
  from public.user_provisioning_intents intent
  cross join lateral public.classify_user_provisioning_intent_v1(intent.id) classified
  order by classified.created_at, classified.intent_id;
end;
$$;

revoke all on function public.preview_user_provisioning_reconciliation_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.preview_user_provisioning_reconciliation_v1(uuid) to service_role;
alter function public.preview_user_provisioning_reconciliation_v1(uuid) owner to postgres;

create or replace function public.reconcile_user_provisioning_intent_v1(
  target_intent_id uuid,
  reconciliation_actor_profile_id uuid,
  reconciliation_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_profile public.profiles%rowtype;
  target_intent public.user_provisioning_intents%rowtype;
  classified record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if nullif(pg_catalog.btrim(reconciliation_reason), '') is null
     or pg_catalog.char_length(pg_catalog.btrim(reconciliation_reason)) > 500 then
    raise exception using errcode = '22023', message = 'RECONCILIATION_REASON_INVALID';
  end if;

  select profile.*
  into actor_profile
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  where profile.id = reconciliation_actor_profile_id
    and profile.is_active is true
    and public.profile_role_has_capability(profile.role, 'SUPERADMIN')
    and auth_user.email_confirmed_at is not null
    and (auth_user.banned_until is null or auth_user.banned_until <= pg_catalog.now())
  for share of profile;

  if not found then
    raise exception using errcode = '42501', message = 'SUPER_ADMIN_DEV_REQUIRED';
  end if;

  select intent.*
  into target_intent
  from public.user_provisioning_intents intent
  where intent.id = target_intent_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'PROVISIONING_INTENT_NOT_FOUND';
  end if;

  select *
  into classified
  from public.classify_user_provisioning_intent_v1(target_intent.id);

  if classified.classification = 'COMPLETED_CONSISTENT' then
    return pg_catalog.jsonb_build_object(
      'state', 'ALREADY_COMPLETED',
      'code', 'PROVISIONING_ALREADY_COMPLETED',
      'intent_id', target_intent.id,
      'auth_user_id', target_intent.auth_user_id
    );
  end if;

  if classified.classification = 'PENDING_NO_AUTH' then
    return pg_catalog.jsonb_build_object(
      'state', 'NO_CHANGE',
      'code', 'PROVISIONING_RETRYABLE',
      'intent_id', target_intent.id,
      'auth_user_id', null
    );
  end if;

  if classified.classification <> 'PENDING_AUTH_PROFILE_MATCH' then
    raise exception using errcode = 'QS846', message = 'RECONCILIATION_MISMATCH';
  end if;

  -- auth.users is Supabase-managed and postgres is guaranteed read access,
  -- not ownership or UPDATE privilege. Re-read the exact Auth row without a
  -- row-locking clause; the intent remains FOR UPDATE and the application-owned
  -- Profile remains FOR SHARE. The broader Auth TOCTOU is deferred to R8-04.
  perform 1
  from auth.users auth_user
  where auth_user.id = classified.technical_auth_user_id;

  if not found then
    raise exception using errcode = 'QS846', message = 'RECONCILIATION_MISMATCH';
  end if;

  perform 1
  from public.profiles profile
  where profile.id = classified.technical_auth_user_id
  for share;

  if not found then
    raise exception using errcode = 'QS846', message = 'RECONCILIATION_MISMATCH';
  end if;

  select *
  into classified
  from public.classify_user_provisioning_intent_v1(target_intent.id);

  if classified.classification <> 'PENDING_AUTH_PROFILE_MATCH' then
    raise exception using errcode = 'QS846', message = 'RECONCILIATION_MISMATCH';
  end if;

  update public.user_provisioning_intents intent
  set status = 'completed',
      auth_user_id = classified.technical_auth_user_id,
      completed_at = pg_catalog.clock_timestamp()
  where intent.id = target_intent.id
    and intent.status = 'pending';

  if not found then
    raise exception using errcode = 'QS846', message = 'RECONCILIATION_MISMATCH';
  end if;

  insert into public.audit_logs (
    actor_id,
    actor_email,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    actor_profile.id,
    null,
    'user_provisioning_reconciled',
    'user_provisioning_intent',
    target_intent.id,
    pg_catalog.jsonb_build_object(
      'reason', pg_catalog.btrim(reconciliation_reason),
      'previousClassification', 'PENDING_AUTH_PROFILE_MATCH',
      'result', 'completed',
      'authUserId', classified.technical_auth_user_id
    )
  );

  return pg_catalog.jsonb_build_object(
    'state', 'RECONCILED',
    'code', null,
    'intent_id', target_intent.id,
    'auth_user_id', classified.technical_auth_user_id
  );
end;
$$;

revoke all on function public.reconcile_user_provisioning_intent_v1(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_user_provisioning_intent_v1(uuid, uuid, text) to service_role;
alter function public.reconcile_user_provisioning_intent_v1(uuid, uuid, text) owner to postgres;

create or replace function public.preview_auth_profile_orphans_v1()
returns table(
  technical_auth_user_id uuid,
  classification text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;

  return query
  select
    auth_user.id,
    'HISTORICAL_AUTH_NO_PROFILE_NO_INTENT'::text,
    auth_user.created_at
  from auth.users auth_user
  where not exists (
      select 1 from public.profiles profile where profile.id = auth_user.id
    )
    and not exists (
      select 1
      from public.user_provisioning_intents intent
      where intent.auth_user_id = auth_user.id
        or nullif(
          pg_catalog.btrim(auth_user.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
          ''
        ) = intent.id::text
        or nullif(
          pg_catalog.btrim(auth_user.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
          ''
        ) = intent.id::text
    )
  order by auth_user.created_at, auth_user.id;
end;
$$;

revoke all on function public.preview_auth_profile_orphans_v1() from public, anon, authenticated, service_role;
grant execute on function public.preview_auth_profile_orphans_v1() to service_role;
alter function public.preview_auth_profile_orphans_v1() owner to postgres;

-- No new table was introduced. The existing AUTH_IDENTITY/PRESERVE Database
-- Safety classification for user_provisioning_intents remains authoritative.

commit;
