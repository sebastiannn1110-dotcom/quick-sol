# Quiksol Data Intelligence Platform Deployment

## 1. Supabase

1. Create a Supabase project.
2. Run `supabase/migrations/20260624000000_quiksol_platform.sql`.
3. Run `supabase/migrations/20260624010000_observability_logs.sql`.
4. Confirm RLS is enabled on all public tables.
5. Confirm the private Storage bucket `excel-uploads` exists.
6. Create the first admin user in Supabase Auth.
7. Update that user's `profiles.role` to `admin`.

## 2. Environment

Create `.env.local` from `.env.example`.

Required:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is still supported as a legacy alias.

Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser. It is used only in server routes for admin invite/audit/security writes.

## 3. Build

Run:

```bash
npm install
npm run typecheck
npm run lint
npm run test
npm run build
```

## 4. Production Notes

- Use HTTPS only.
- Set strict environment variables in the hosting provider.
- Keep Supabase RLS enabled.
- Keep Storage bucket private.
- Configure Supabase Auth email verification and password reset URLs.
- Use Supabase backups or PITR according to the plan tier.
- Move MVP in-memory rate limiting to Redis/Upstash before high traffic.
- Use `/admin/logs` and `/admin/traces/{traceId}` to diagnose failures end to end.
