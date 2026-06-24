# Backup and Recovery

## Supabase Database

- Enable Supabase automated backups.
- Use point-in-time recovery if the production plan supports it.
- Export critical tables regularly: `profiles`, `upload_batches`, `upload_sheets`, `business_records`, `import_errors`, `audit_logs`, `security_events`.
- Retain audit and security logs according to company policy.

## Storage

- Keep `excel-uploads` private.
- Export storage objects periodically if regulatory retention requires it.
- Never use public permanent URLs for uploaded spreadsheets.

## Recovery

1. Restore database backup or PITR snapshot.
2. Validate RLS policies are still enabled.
3. Validate Storage bucket policies.
4. Re-run smoke tests: login, upload, employee records isolation, admin access.
5. Compare upload counts and record counts with the last known audit snapshot.

## Data Retention

- Archive uploads instead of hard deleting from the UI.
- Keep raw data and normalized data for traceability.
- Review old archived uploads through admin workflows before physical deletion.
