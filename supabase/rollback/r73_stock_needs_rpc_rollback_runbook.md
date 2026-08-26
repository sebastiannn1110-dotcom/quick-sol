# R7.3 Stock Needs RPC rollback

Use this rollback only if the R7.3 RPC migration causes incorrect results,
authorization drift, repeated statement timeouts, or an unacceptable regression.
It restores only `public.get_stock_needs_page_v1` to the verified PRE-R7.3
definition. It does not change data or schema objects used by uploads and jobs.

## Preconditions

1. Keep Maintenance Mode ON for the entire rollback and verification window.
2. Confirm `quick-sol-worker` is suspended. Do not resume it for this procedure.
3. Confirm the target Supabase project and record the current migration/catalog
   state. Do not use a connection string for any other environment.
4. Save a sanitized `pg_get_functiondef` plus owner, volatility,
   `SECURITY DEFINER`, `search_path`, ACL and effective grants for the current
   function. Never print the database URL or credentials.
5. Verify the rollback file SHA-256 against the release record.

## Controlled command

Supply the production connection through the operator's secret environment and
run from the repository root. The command must be executed manually by the
authorized cutover operator; Codex must not execute it against production.

```sh
psql "$DATABASE_URL" -X --set ON_ERROR_STOP=1 --file supabase/rollback/r73_restore_stock_needs_rpc_before.sql
```

The SQL is transactional. An error before `commit` aborts the function/ACL
change as one unit.

## Post-rollback verification

1. Re-query the exact function identity arguments. Confirm one target overload,
   return type `jsonb`, owner `postgres`, volatility `STABLE`,
   `SECURITY DEFINER`, and `search_path=pg_catalog, public`.
2. Recompute the normalized catalog fingerprint and compare it to the recorded
   PRE-R7.3 fingerprint.
3. Confirm EXECUTE is effective for `authenticated` and `service_role`, and is
   not effective for `anon` or `PUBLIC`.
4. Run the Stock Needs role-scope, cross-tenant, readiness and representative
   page/filter smoke tests. Check application logs for errors and timeouts.
5. In the application/operations dashboard, confirm Maintenance Mode is still
   ON and capture evidence. This SQL never changes Maintenance Mode.
6. In Render, confirm `quick-sol-worker` is still suspended and capture
   evidence. Do not resume it as part of rollback.

Escalate any fingerprint, permission, tenant-scope or result mismatch. Keep
Maintenance Mode ON and the worker suspended until an authorized decision.
