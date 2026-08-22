# Quiksol Data Intelligence Platform Deployment

## 1. Supabase

1. Create a Supabase project.
2. Run `supabase/migrations/20260624000000_quiksol_platform.sql`.
3. Run `supabase/migrations/20260624010000_observability_logs.sql`.
4. Confirm RLS is enabled on all public tables.
5. Confirm the private Storage bucket `excel-uploads` exists.
6. Prepare admin provisioning from a trusted machine. The default command is always non-mutating:

```bash
npm run provision:admins
```

It reports `DRY RUN / PREPARED ONLY / NO CHANGES`; it does not connect to Supabase or modify Auth/profiles. Mutating or remote-inspection modes require one exact allowlisted target and the expected Supabase project ref:

```bash
npm run provision:admins:inspect -- --target-email=<exact-email> --project-ref=<expected-ref>
npm run provision:admins:apply -- --target-email=<exact-email> --project-ref=<expected-ref>
```

For an existing user, apply updates only the approved metadata/profile and preserves the current password. Password rotation is a separate action:

```bash
npm run provision:admins:rotate -- --target-email=<exact-email> --project-ref=<expected-ref>
```

Rotation requires `QUIKSOL_ADMIN_ROTATION_PASSWORD`; new-user creation requires `QUIKSOL_ADMIN_PROVISIONING_PASSWORD`. Supply either only as a temporary process/CI secret. Never put a real value in `.env`, CLI arguments, source code, logs, screenshots, or documentation. The script rejects `--password`, refuses partial targets, validates the project ref against `NEXT_PUBLIC_SUPABASE_URL`, and removes temporary secret variables from its process before exiting.

Removing an exposed credential from the current source does not remove it from Git history. Treat every previous provisioning credential as compromised until it is rotated and the old value is confirmed invalid. See `docs/ADMIN_CREDENTIAL_HISTORY_CLEANUP_PLAN.md`; that plan must not be executed as part of ordinary provisioning.

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
