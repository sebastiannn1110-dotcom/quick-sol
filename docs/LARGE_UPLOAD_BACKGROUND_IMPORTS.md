# Large Upload Background Imports

Quiksol no longer processes large Excel or CSV files inside the `/api/upload` HTTP request. The upload flow is now:

1. Browser calls `POST /api/upload/initiate` with file metadata.
2. API validates auth, file type, size, idempotency key and creates:
   - `upload_batches`
   - `import_jobs`
   - a signed Supabase Storage upload URL
3. Browser uploads the file directly to Supabase Storage.
4. Browser calls `POST /api/upload/finalize`.
5. A Render worker runs `npm run worker:imports`, claims queued jobs and parses the file by stream.
6. The UI polls `GET /api/upload/jobs/:id` every 2.5 seconds for status, upload progress, processing progress and row counts.

## Why This Fixes Render 502

The old flow used multipart parsing inside the Next.js route and parsed the workbook before responding. Large files could keep the HTTP request open too long and could load too much into memory.

The new flow keeps the web request short. Render receives only JSON metadata, while the large file goes directly from the browser to Supabase Storage. The worker downloads the object to temp storage and parses rows in batches.

## Supported Files

- `.xlsx` with `exceljs` streaming `WorkbookReader`
- `.csv` with `csv-parse` streaming parser

Legacy `.xls` is rejected in the large upload flow because it does not have a safe streaming reader in this codebase. Convert `.xls` to `.xlsx` or `.csv`.

## Database Migration

Run:

```bash
supabase db push
```

or apply:

```text
supabase/migrations/20260706000000_background_import_jobs.sql
```

The migration adds job progress columns to `upload_batches`, creates `import_jobs`, creates `import_job_errors`, creates the default `excel-uploads` bucket and updates RLS for the new statuses.

## Environment Variables

```env
MAX_UPLOAD_SIZE_MB=25
UPLOAD_CHUNK_SIZE_MB=8
UPLOAD_TIMEOUT_SECONDS=60
UPLOAD_STORAGE_PROVIDER=supabase
SUPABASE_STORAGE_BUCKET=excel-uploads
UPLOAD_TEMP_DIR=.tmp/imports
ENABLE_BACKGROUND_IMPORTS=true
IMPORT_BATCH_SIZE=1000
WORKER_CONCURRENCY=1
WORKER_POLL_INTERVAL_MS=5000
MAX_ROWS_PER_FILE=20000
MAX_EXCEL_ROWS=20000
MAX_EXCEL_SHEETS=30
```

`MAX_ROWS_PER_FILE` has priority. `MAX_EXCEL_ROWS` remains as a legacy alias.

## Render Services

Web service:

```bash
npm run build
npm run start
```

Worker service:

```bash
npm run worker:imports
```

Use the same Supabase and email environment variables in both services. The worker requires `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`.

## Testing

Small validation:

```bash
npm run typecheck
npm run test
```

One-shot worker smoke test:

```bash
npm run worker:imports:once
```

Manual large-file test:

1. Start the web app and the worker.
2. Open `/upload`.
3. Upload `excel de test/Quiksol_AI_Mega_Test_35000.xlsx` or another large `.xlsx`/`.csv`.
4. Confirm the UI shows upload progress, then queued/processing progress.
5. Confirm the history row moves through `pending_upload`, `queued`, `processing`, then `completed` or `failed`.
6. If it fails, use the retry button. If it is still queued/processing, use cancel.

## Logs To Check In Render

Look for these actions:

- `upload_started`
- `upload_completed`
- `job_queued`
- `processing_started`
- `rows_processed`
- `import_batch_insert_started`
- `import_batch_inserted`
- `processing_completed`
- `processing_failed`
- `processing_cancelled`

Each log includes request/job identifiers, upload batch id, file name and memory usage where applicable.

## Remaining Risks

- Supabase Storage bucket must exist and allow signed uploads. The migration creates the default `excel-uploads` bucket.
- Supabase signed upload CORS must allow the deployed app domain.
- `.xls` is intentionally rejected for large imports.
- The worker must be deployed as a separate Render service; queued jobs will not process if only the web service is running.
