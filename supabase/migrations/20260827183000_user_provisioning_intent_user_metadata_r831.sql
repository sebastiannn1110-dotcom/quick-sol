-- R8.3.1: GoTrue can persist custom app_metadata after the initial
-- auth.users INSERT. user_metadata carries only the opaque intent locator;
-- every authoritative Profile value remains in user_provisioning_intents.

begin;

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

    -- R8.3A compatibility only: exact R8.1 least-privilege behavior.
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

  -- This INSERT and the intent completion are part of the surrounding
  -- auth.users INSERT transaction. Any failure rolls back all three states.
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
  values (
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

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
alter function public.handle_new_user() owner to postgres;

commit;
