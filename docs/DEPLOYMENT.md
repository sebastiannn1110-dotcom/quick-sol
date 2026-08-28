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
npm run provision:admins:apply -- --target-email=<exact-email> --project-ref=<expected-ref> --idempotency-key=<operation-uuid>
```

The idempotency key identifies one logical creation and is not a secret. Generate it outside the command, record it with the operation, and reuse that exact UUID for every retry. Never generate a new key merely because a response was lost or timed out. A completed replay returns the same user without calling Auth creation again; it cannot recover or return the original temporary password, and it never resets the password during replay. The complete credential-recovery lifecycle remains explicitly deferred to R8.7; R8.4 does not persist a password or invent a replacement.

Provisioning apply does not list Auth first and never updates or upserts an existing Profile. An Auth user that does not belong to the same completed operation is a deterministic conflict and must go through the separate preview/apply reconciliation workflow. Provisioning and reconciliation must not be combined into one command.

Reconciliation is preview-first and exposes technical IDs only. Preview intents or historical Auth-without-Profile orphans with:

```bash
npm run reconcile:users -- --project-ref=<expected-ref>
npm run reconcile:users -- --project-ref=<expected-ref> --intent-id=<intent-uuid>
npm run reconcile:users:orphans -- --project-ref=<expected-ref>
```

The orphan command is diagnostic only; R8.4 intentionally has no automatic orphan repair. After a Super Admin Dev has reviewed an exact `PENDING_AUTH_PROFILE_MATCH`, the separate apply command requires the intent, actor and a non-secret audit reason. The reason is stored in audit and is visible in process arguments while the command runs, so it must never contain email addresses, other PII, credentials, or tokens:

```bash
npm run reconcile:users:apply -- --project-ref=<expected-ref> --intent-id=<intent-uuid> --actor-profile-id=<super-admin-profile-uuid> --reason="validated exact historical match"
```

Apply never creates or changes Auth/Profile data. It only completes an already exact intent and records one audit event; mismatches fail closed with `RECONCILIATION_MISMATCH`.

R8.4 production rollout is deliberately ordered and operator-controlled:

R8.4 treats `auth.users`, `auth.identities`, and the entire `auth` schema as
Supabase-managed. Its migration must not create indexes, constraints, grants,
ownership changes, or any other DDL there. Auth remains the read-only source of
truth for pre-existing-user defense and historical reconciliation. Those
occasional administrative lookups may scan the small Auth census; the hot
idempotency path remains indexed on the application-owned
`public.user_provisioning_intents` table. Do not add a shadow Auth table merely
to avoid that scan.

1. Apply the additive R8.4 database migration while the R8.3B gate remains `true`; do not rerun the R8.3B release gate.
2. Deploy the R8.4 application and CLI code.
3. Smoke one creation plus a same-key replay and verify the same intent/Auth/Profile with no second lifecycle audit.
4. Run reconciliation preview only, including the separate orphan census.
5. Obtain explicit operator approval for each exact `PENDING_AUTH_PROFILE_MATCH` intent.
6. Apply reconciliation one intent at a time with the reviewed actor and reason.

The migration and application deploy never apply historical reconciliation automatically.

Password rotation remains a separate action and does not require a provisioning idempotency key:

```bash
npm run provision:admins:rotate -- --target-email=<exact-email> --project-ref=<expected-ref>
```

Rotation is fail-closed: the exact allowlisted Auth user must be active and confirmed, and its active Profile must have the same ID, normalized email, and role. If any state is absent or mismatched, the command returns `ROTATION_RECONCILIATION_REQUIRED` and changes nothing. A valid rotation sends only the new password to Auth; it never changes Auth email/metadata or writes the Profile.

Rotation requires `QUIKSOL_ADMIN_ROTATION_PASSWORD`; a new or pending user creation requires `QUIKSOL_ADMIN_PROVISIONING_PASSWORD`. Supply either only as a temporary process/CI secret. Never put a real value in `.env`, CLI arguments, source code, logs, screenshots, or documentation. The script rejects `--password`, refuses partial targets, validates the project ref against `NEXT_PUBLIC_SUPABASE_URL`, and removes temporary secret variables from its process before exiting.

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
