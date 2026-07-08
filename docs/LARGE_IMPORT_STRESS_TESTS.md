# Large Import Stress Tests

This repo includes a real stress harness for the Quicksol large upload flow.

Command:

```bash
npm run test:large-imports
```

The script generates test files under `outputs/large-import-stress/` and can execute the real flow:

1. `POST /api/upload/initiate`
2. signed upload to Supabase Storage
3. `POST /api/upload/finalize`
4. optional one-shot worker execution
5. polling `GET /api/upload/jobs/:id`
6. console report with pass/fail, duration, peak memory, rows processed, rows/sec, batches and recommendations

## Required Variables For Real API Tests

```env
QUICKSOL_BASE_URL=https://quick-sol.onrender.com
QUICKSOL_AUTH_COOKIE=copy_the_cookie_header_from_a_logged_in_browser
LARGE_IMPORT_SPAWN_WORKER=1
SUPABASE_SERVICE_ROLE_KEY=only_needed_for_worker_and_system_log_batch_counts
```

`QUICKSOL_AUTH_COOKIE` is required because the app authenticates API routes through Supabase SSR cookies. Copy it from the browser DevTools request headers while logged in as a test user.

## Plans

Smoke plan, default:

```bash
npm run test:large-imports
```

Standard plan:

```bash
npm run test:large-imports -- --plan=standard
```

Full plan:

```bash
npm run test:large-imports -- --plan=full
```

Generate files only:

```bash
npm run test:large-imports -- --plan=generate
```

or:

```bash
npm run test:large-imports -- --plan=full --generate-only
```

## Generated Files

CSV:

- 10,000 rows
- 100,000 rows
- 500,000 rows
- 1,000,000 rows

XLSX:

- 10,000 rows
- 50,000 rows
- 100,000 rows
- 250,000 rows

Bad cases:

- corrupt `.xlsx`
- missing columns
- false extension
- formulas
- duplicate idempotency key
- cancelled job
- failed job retry
- worker restart mid-process

## Optional Bad/Destructive Cases

Retry failed job:

```bash
LARGE_IMPORT_RUN_RETRY_CASE=1 npm run test:large-imports -- --plan=bad-cases
```

Duplicate upload:

```bash
LARGE_IMPORT_RUN_DUPLICATE_CASE=1 npm run test:large-imports -- --plan=bad-cases
```

Worker restart mid-process:

```bash
LARGE_IMPORT_INCLUDE_RESTART=1 LARGE_IMPORT_RESTART_KILL_AFTER_MS=2500 npm run test:large-imports -- --plan=standard
```

This can leave a job in `processing` if stale-lock recovery is not implemented. The harness attempts to cancel it after the check.

## Useful Tuning

```env
LARGE_IMPORT_PLAN=standard
LARGE_IMPORT_TIMEOUT_MS=1200000
LARGE_IMPORT_POLL_MS=2500
LARGE_IMPORT_MEMORY_POLL_MS=500
LARGE_IMPORT_ALLOW_SKIPS=1
LARGE_IMPORT_OUTPUT_DIR=outputs/large-import-stress
```

## Report

The console prints:

- passed
- failed
- duration
- memory peak
- rows processed
- recommendation

The same data is saved to:

```text
outputs/large-import-stress/latest-report.json
```

