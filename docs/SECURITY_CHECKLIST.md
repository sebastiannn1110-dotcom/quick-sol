# Security Checklist

- Supabase Auth protects all internal pages.
- Middleware redirects unauthenticated users to `/login`.
- `/admin` routes require `admin` role.
- Server routes never trust user IDs from the browser.
- Uploads use the authenticated user from the server session.
- RLS is enabled on all public tables.
- Employees can read only their own uploads and records.
- Managers can read only department or region scoped data.
- Admins can read global data and manage profiles.
- Service role key is used only in server code.
- `excel-uploads` bucket is private.
- Uploads are stored under `{userId}/{uploadBatchId}/uuid.ext`.
- `.xlsm`, scripts and executable extensions are rejected.
- File size, row count and sheet count limits are configurable.
- Excel formulas are not executed.
- Formula errors are saved as import errors.
- CSV formula injection is escaped for suspicious cell prefixes.
- Security headers are configured in `next.config.mjs`.
- Rate limiting exists for upload/search/records APIs.
- Audit logs record admin and upload events.
- Security events record unauthorized admin attempts.
- System logs, client logs and performance logs are available to admins only.
- Logs use traceId/requestId correlation and sanitize secrets before writing.
- `/admin/traces/[traceId]` shows the chronological timeline for debugging.
- Destructive delete is avoided; uploads are archived.
- Stack traces are not returned to users.

Residual MVP risk:

- The required `xlsx` package currently has npm advisories with no upstream fix. Keep upload limits strict and process files server-side only.
- In-memory rate limiting is not distributed. Replace with Redis/Upstash for multi-instance deployments.
