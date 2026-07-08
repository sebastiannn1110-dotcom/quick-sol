# Production Large Imports Checklist

Before selling or installing Quicksol for real client uploads:

- [ ] `npm run diagnose:uploads` has no failures.
- [ ] `npm run diagnose:worker` has no failures.
- [ ] `npm run diagnose:production-imports` has no critical failures.
- [ ] Render Web Service is deployed.
- [ ] Render Background Worker is deployed.
- [ ] Worker has enough RAM for the target files.
- [ ] Supabase Storage global file limit is greater than or equal to `MAX_UPLOAD_SIZE_MB`.
- [ ] Bucket `excel-uploads` is private.
- [ ] Bucket `excel-uploads` allows CSV and XLSX MIME types.
- [ ] Resumable upload is tested with a file above `LARGE_UPLOAD_RESUMABLE_THRESHOLD_MB`.
- [ ] CSV 1 GB import is tested.
- [ ] XLSX large import is tested or explicitly documented as a risk.
- [ ] Worker restart in the middle of a job is tested.
- [ ] Retry after failure is tested.
- [ ] Cancel while queued and while processing is tested.
- [ ] Stale jobs are recovered after heartbeat timeout.
- [ ] Logs are visible in Render and/or Supabase-backed system logs.
- [ ] UI clearly differentiates uploading, uploaded, queued, retrying, processing, completed, failed and cancelled.
- [ ] AI can query processed files after import.
- [ ] Admin can see all uploads.
- [ ] Employee can only see allowed uploads and records.

Recommended stress plans:

- [ ] Smoke plan passes locally.
- [ ] Standard plan passes against Render.
- [ ] Production CSV tests: 100 MB, 500 MB, 1 GB.
- [ ] Production CSV 5 GB test passes if the machine and plan allow it.
- [ ] Production XLSX tests: 100 MB, 500 MB.
- [ ] Production XLSX 1 GB test passes or is documented as not supported for the current worker size.

Do not go live if:

- jobs remain queued indefinitely,
- processing jobs keep stale heartbeat,
- Web service receives file bodies,
- worker temp disk is smaller than expected XLSX files,
- Supabase Storage limit is lower than `MAX_UPLOAD_SIZE_MB`,
- employees can read other employees' restricted records.
