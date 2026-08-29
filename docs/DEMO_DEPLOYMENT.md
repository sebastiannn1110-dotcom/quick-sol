# QuikSol commercial demo deployment plan

This is an execution plan only. The implementation worktree did not run migrations, seed remote data, change Render, deploy, commit, or push.

## Immutable sources

- Base worktree: `C:\Users\sebas\OneDrive\Escritorio\quiksol-demo-worktrees\base-demo`
  - branch: `demo/quiksol-commercial-base`
  - start SHA: `b0f95ea4dd1be5b85ac1c6f2992133e8d8193295`
- Web worktree: `C:\Users\sebas\OneDrive\Escritorio\quiksol-demo-worktrees\web-demo`
  - branch: `demo/quiksol-commercial-web`
  - start SHA: `662e6a00f81742e92f94f9a36c37a85de749351f`

Never include or execute the unrelated historical file `20260828120000_purge_uploaded_business_data_preserve_identities.sql` from the original base worktree.

## Required environment names

Base service (`quick-sol`):

- existing Supabase variables (`NEXT_PUBLIC_SUPABASE_URL`, publishable/anon key, `SUPABASE_SERVICE_ROLE_KEY`)
- `COMMERCE_INTAKE_HMAC_SECRET` (server only, at least 32 random characters)
- `COMMERCE_PUBLIC_QUOTE_BASE_URL` (HTTPS base-service origin)

Web service (`quiksol-web`):

- existing web Supabase variables (`NEXT_PUBLIC_SUPABASE_URL`, publishable/anon key, `SUPABASE_SERVICE_ROLE_KEY`)
- `NEXT_PUBLIC_SITE_URL`
- `PLATFORM_API_BASE_URL`
- `COMMERCE_INTAKE_HMAC_SECRET` (same value as base; server only)
- `EMPLOYEE_SESSION_SECRET`
- `EMPLOYEE_COMMERCE_DEMO_MODE=false`
- existing optional Customer AI variables (`AI_ASSISTANT_ENABLED`, `OPENAI_API_KEY`, `OPENAI_MODEL`)

No catalog-publication secret is needed. Base exposes a deliberately public, rate-limited, no-store allowlist containing only approvals with `publish_to_catalog=true`.

CLI-only DEMO seed guards are documented in `.env.example`; they must not be exposed to either browser.

## Exact deployment order

1. Back up both Supabase projects and record migration history.
2. Apply only the web migration `20260829120000_demo_public_catalog_rfq_safety.sql` to the web Supabase project.
3. Apply these base migrations, in this order, to the base Supabase project:
   1. `20260829090000_commerce_backend_real.sql`
   2. `20260829100000_sourcing_workflow_and_of_adapter.sql`
   3. `20260829160000_organization_employee_analytics.sql`
   4. `20260829170000_demo_database_safety_catalog.sql`
      (fail-closed: the new demo tables and private sourcing bucket remain `PRESERVE` until a separately authorized purge-policy review)
4. Configure the base environment names above. Do not expose server-only values with a `NEXT_PUBLIC_` prefix.
5. Deploy the reviewed base worktree build.
6. Configure the web environment names above, keeping `EMPLOYEE_COMMERCE_DEMO_MODE=false`.
7. Deploy the reviewed web worktree build.
8. Run foundational health/auth checks: inactive user rejection, expired-token rejection/refresh, logout, and employee/manager/admin scope checks.
9. Run both seed dry-runs and review their exact project refs and deterministic plan.
10. Apply the guarded base DEMO seed, then the guarded web catalog DEMO seed. Do not use either production customer data or a non-allowlisted project.
11. Run a public catalog smoke for `QKS-DEMO-MCU-042`; confirm no exact stock, raw cost, supplier, GP, or margin appears.
12. Run an anonymous and authenticated cart-to-RFQ smoke. Confirm one atomic web parent/items transaction and one idempotent base RFQ with the web external ID.
13. Run the employee quote smoke: draft, version conflict, price refresh, send, PDF, secure customer link, accepted/rejected transition, and immutable event ledger.
14. Run the Sourcing smoke: request, two offers for one MPN, private attachment, approval, explicit publication, seller-safe catalog refresh, and raw-cost denial for seller.
15. Run Opportunity Finder parity fixtures before using the approved-offer adapter; then verify provenance and the existing matcher result.
16. Run Employee Analytics and Team Structure scope checks, including cross-department manager subtree, cycle rejection, version conflict, and separate compensation denial for managers/admin non-owners.
17. Run Internal AI text and voice questions in EN/ES/ZH, including latest upload, quote metrics, client open quotes, and sourcing lookup. Confirm no compensation response.
18. Run Customer AI lookup/add-to-cart/start-RFQ in EN/ES/ZH and a visible-copy smoke in FR/DE/JA/KO.
19. Run Chat with two real demo users in separate browser sessions: realtime message plus one small private attachment.
20. Rehearse desktop, mobile, iPad landscape (`1024x768`), and iPad portrait (`768x1024`).

## DEMO data commands (do not run until steps 9-10)

First run dry-runs, which perform no network access or writes:

```powershell
# base-demo
npm run seed:demo

# web-demo
npm run demo:catalog:seed
```

Base apply requires every explicit safeguard shown by the script:

```powershell
$env:QUIKSOL_DEMO_SEED_ALLOWED = 'true'
$env:QUIKSOL_DEMO_PROJECT_REF = '<project-ref>'
$env:QUIKSOL_DEMO_USER_PASSWORD = '<strong-temporary-demo-password>'
npm run seed:demo:apply -- --confirm=QUIKSOL_DEMO_DATA_ONLY --project-ref=<project-ref>
```

Web catalog apply is separate and guarded:

```powershell
$env:QUIKSOL_DEMO_SEED_CONFIRM = 'LOAD_DEMO_DATA'
npm run demo:catalog:seed -- --apply
```

All seeded identities use `.demo.invalid`; records and metadata are marked `DEMO`. Rotate or remove any temporary demo credentials after recording according to the normal R8 provisioning process.

## Acceptance evidence

Before approval, archive the output of:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Run those four commands independently in both worktrees. Also archive the focused Opportunity Finder parity and R8 signup/last-admin/provisioning results.

## Stop conditions

Stop immediately if deployment would require a service-role key in the browser, a matcher/UOM/ranking change, weaker R8/RLS guarantees, destructive business-data migration, public raw cost or exact stock, seller-visible supplier documents, or salary in the normal organization/AI payload.
