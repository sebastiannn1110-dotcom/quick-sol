# Quiksol Data Intelligence Platform Deployment

## 1. Supabase

1. Create a Supabase project.
2. Run `supabase/migrations/20260624000000_quiksol_platform.sql`.
3. Run `supabase/migrations/20260624010000_observability_logs.sql`.
4. Confirm RLS is enabled on all public tables.
5. Confirm the private Storage bucket `excel-uploads` exists.
6. Create the first admin user in Supabase Auth.
7. Update that user's `profiles.role` to `admin`.
8. Provision the default admin logins from a trusted machine:

```bash
npm run provision:admins
```

This command uses `SUPABASE_SERVICE_ROLE_KEY` only on the server/local machine. It creates or updates:

- `admin@quiksol.local`
- `braian@admin.quiksol`

To confirm both passwords can sign in through Supabase Auth, run:

```bash
npm run provision:admins -- --verify-login
```

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
- Large uploads require a separate Render Background Worker running `npm run worker:imports`.
- For 10 GB initial production uploads, set `MAX_UPLOAD_SIZE_MB=10240` and configure Supabase Storage global/bucket limits to at least `10240 MB`.
- Do not set `MAX_UPLOAD_SIZE_GB`; the app ignores it and reports a warning.
- See `docs/LARGE_UPLOAD_BACKGROUND_IMPORTS.md` and `docs/PRODUCTION_LARGE_IMPORTS_CHECKLIST.md` before selling or installing production large imports.
