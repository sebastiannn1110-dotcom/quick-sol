export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-700">Configuration</p>
        <h1 className="text-2xl font-semibold text-slate-950">Settings</h1>
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-950">Storage</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Primary database</dt>
              <dd className="font-medium text-slate-950">Supabase PostgreSQL</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Raw/normalized data</dt>
              <dd className="font-medium text-slate-950">business_records JSONB</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Private bucket</dt>
              <dd className="font-medium text-slate-950">excel-uploads</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Local demo fallback</dt>
              <dd className="font-medium text-slate-950">Development only</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-950">Security Controls</h2>
          <ul className="mt-4 space-y-2 text-sm text-slate-600">
            <li>Supabase Auth and server-side profile checks.</li>
            <li>RLS policies for profiles, uploads, sheets, records, errors and logs.</li>
            <li>Admin routes blocked by middleware and API role checks.</li>
            <li>Original files stored in private Supabase Storage paths.</li>
            <li>Rate limits on upload, records and search endpoints.</li>
            <li>Security headers configured in Next.js.</li>
          </ul>
        </div>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-950">Operational Documents</h2>
        <ul className="mt-4 space-y-2 text-sm text-slate-600">
          <li>SQL migration: /supabase/migrations/20260624000000_quiksol_platform.sql</li>
          <li>Environment example: /.env.example</li>
          <li>Deployment guide: /docs/DEPLOYMENT.md</li>
          <li>Security checklist: /docs/SECURITY_CHECKLIST.md</li>
          <li>Backup and recovery: /docs/BACKUP_AND_RECOVERY.md</li>
        </ul>
      </section>
    </div>
  );
}
