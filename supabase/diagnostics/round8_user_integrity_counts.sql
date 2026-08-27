-- R8.1 read-only diagnostic. The single result row contains counts only; no PII is projected.
select
  count(*) filter (where auth_user.id is not null and profile.id is null) as auth_without_profile,
  count(*) filter (where profile.id is not null and auth_user.id is null) as profile_without_auth,
  count(*) filter (
    where auth_user.id is not null
      and profile.id is not null
      and lower(btrim(auth_user.email)) is distinct from lower(btrim(profile.email))
  ) as email_mismatches,
  count(*) filter (
    where auth_user.id is not null
      and profile.id is not null
      and profile.is_active is true
      and profile.role in ('admin', 'super_admin_dev')
      and auth_user.email_confirmed_at is not null
      and (auth_user.banned_until is null or auth_user.banned_until <= now())
  ) as effective_admins
from auth.users as auth_user
full outer join public.profiles as profile on profile.id = auth_user.id;
