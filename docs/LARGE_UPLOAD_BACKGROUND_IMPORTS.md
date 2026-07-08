# Production Large Upload Architecture

Quicksol large imports are designed for production: the Web service never receives the file body, never parses files inside `/api/upload`, and never depends on a long HTTP request.

## Final Flow

1. Browser calls `POST /api/upload/initiate` with metadata only.
2. Web validates auth, file type, `MAX_UPLOAD_SIZE_MB`, row/sheet limits and idempotency key.
3. Web creates `upload_batches` and `import_jobs`.
4. Browser uploads directly to Supabase Storage:
   - files below `LARGE_UPLOAD_RESUMABLE_THRESHOLD_MB` use the existing signed upload flow.
   - files at or above the threshold use Supabase TUS resumable upload.
5. Browser calls `POST /api/upload/finalize`.
6. A separate Render Background Worker runs `npm run worker:imports`.
7. Worker claims jobs with Postgres locking, updates heartbeat, streams CSV/XLSX, inserts batches, and updates progress.
8. UI polls job status and shows separate upload and processing progress.

## Required Migrations

Apply all migrations, including:

```text
supabase/migrations/20260706000000_background_import_jobs.sql
supabase/migrations/20260708000000_large_imports_production_hardening.sql
```

The hardening migration adds `heartbeat_at`, `next_retry_at`, `last_error`, `worker_id`, `cancel_requested`, `upload_strategy`, worker heartbeat fields, retry indexes, and the `claim_import_job` RPC.

## Render Web Service

Purpose: UI, auth and JSON APIs only.

Build:

```bash
npm run build
```

Start:

```bash
npm run start
```

Required variables:

```env
NEXT_PUBLIC_APP_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=excel-uploads
UPLOAD_STORAGE_PROVIDER=supabase
ENABLE_BACKGROUND_IMPORTS=true
MAX_UPLOAD_SIZE_MB=10240
MAX_ROWS_PER_FILE=10000000
MAX_EXCEL_ROWS=10000000
MAX_EXCEL_SHEETS=50
LARGE_UPLOAD_RESUMABLE_THRESHOLD_MB=100
IMPORT_BATCH_SIZE=1000
SUPABASE_INSERT_CHUNK_SIZE=500
```

Delete or rename:

```env
MAX_UPLOAD_SIZE_GB
```

If present, the app reports: `MAX_UPLOAD_SIZE_GB is not used. Use MAX_UPLOAD_SIZE_MB instead.`

## Render Worker Service

Purpose: required Background Worker for imports.

Start:

```bash
npm run worker:imports
```

Required variables:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=excel-uploads
UPLOAD_STORAGE_PROVIDER=supabase
ENABLE_BACKGROUND_IMPORTS=true
MAX_UPLOAD_SIZE_MB=10240
MAX_ROWS_PER_FILE=10000000
MAX_EXCEL_ROWS=10000000
MAX_EXCEL_SHEETS=50
LARGE_UPLOAD_RESUMABLE_THRESHOLD_MB=100
IMPORT_BATCH_SIZE=1000
SUPABASE_INSERT_CHUNK_SIZE=500
UPLOAD_TEMP_DIR=.tmp/imports
WORKER_CONCURRENCY=1
WORKER_POLL_INTERVAL_MS=5000
WORKER_STALE_AFTER_MINUTES=30
WORKER_MAX_ATTEMPTS=3
WORKER_HEARTBEAT_INTERVAL_MS=15000
```

Initial production recommendation:

- Web: stable plan; it does not process large files.
- Worker: at least 4 GB RAM.
- Frequent large files: 8 GB RAM or more.
- Temp disk for XLSX: 50 GB minimum, 100 GB preferred.

## Supabase Pro Configuration

In Supabase Dashboard:

1. Open Storage.
2. Open Settings.
3. Set Global file size limit to at least `10240 MB` for 10 GB imports.
4. Open bucket `excel-uploads`.
5. Keep it private.
6. Allowed MIME types should include CSV and XLSX.
7. Bucket limit must be compatible with `MAX_UPLOAD_SIZE_MB`.

## CSV vs XLSX

CSV is preferred for extremely large files. It streams with low memory and can be optimized toward remote streaming later.

XLSX is supported with `exceljs` streaming reader, but the worker downloads the object to `UPLOAD_TEMP_DIR` first because XLSX parsing needs random-access ZIP handling internally. For XLSX, verify temp disk before production tests and expect higher CPU/RAM than CSV.

## Idempotency And Retries

Current protections:

- `idempotency_key` is unique per user while upload is active.
- Retry reuses the same `upload_batch_id` and `import_job_id`.
- Worker deletes partial `business_records`, `import_errors`, `import_job_errors`, and `upload_sheets` for the batch before reprocessing.
- Jobs are claimed through `claim_import_job` with `FOR UPDATE SKIP LOCKED`.
- Stale `processing` jobs are recovered by heartbeat timeout.

Residual risk: perfect file hashing is not implemented yet. If the same physical file is renamed or modified with a different browser timestamp, it can create a new idempotency key. A future hardening step should add client-side SHA-256 for smaller files and server-side/staging hash metadata for very large files.

## Diagnostics

```bash
npm run diagnose:uploads
npm run diagnose:worker
npm run diagnose:production-imports
```

The new production diagnostics validate env, Supabase clients, bucket, base schema, production columns, queued jobs, stale processing jobs, latest heartbeat, recent import errors and temp disk space.

## Logs

Minimum production log actions include:

- `upload_initiate_received`
- `upload_initiate_completed`
- `upload_resumable_started`
- `upload_resumable_progress`
- `upload_resumable_completed`
- `upload_finalize_received`
- `job_queued`
- `worker_started`
- `worker_env_loaded`
- `worker_poll_started`
- `queued_jobs_found`
- `job_claim_started`
- `job_claim_completed`
- `processing_started`
- `heartbeat_updated`
- `rows_processed`
- `batch_insert_started`
- `batch_insert_completed`
- `processing_completed`
- `processing_failed`
- `processing_cancelled`
- `stale_job_recovered`

Logs include request/job/upload identifiers, file size, worker id, row counters, duration, memory usage and error details when available.
