import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
function source(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n?/g, "\n");
}

describe("Opportunity Finder access and isolation integration", () => {
  it("protects the route for authenticated employee, manager and admin users", () => {
    expect(source("proxy.ts")).toContain('"/opportunity-finder"');
    expect(source("app/opportunity-finder/page.tsx")).toContain("EmployeeGuard");
    expect(source("components/EmployeeGuard.tsx")).toContain('["admin", "manager", "employee"]');
  });

  it("makes the two-file finder the single seller navigation entry", () => {
    const sidebar = source("components/Sidebar.tsx");
    expect(sidebar).toContain('href: "/opportunity-finder"');
    expect(sidebar).not.toContain('href: "/mpn-comparator"');
    expect(sidebar).not.toContain('href: "/opportunities"');
  });

  it("keeps every job read scoped to the authenticated owner", () => {
    const api = source("lib/opportunity-finder/api.ts");
    expect(api).toContain('.eq("created_by", userId)');
    const migration = source("supabase/migrations/20260727090000_opportunity_finder.sql");
    expect(migration).toContain("created_by = auth.uid()");
    expect(migration).toContain("Canonical rows intentionally have no authenticated-user policy");
  });

  it("never stages rows in business_records or selects forbidden commercial fields", () => {
    const worker = source("lib/opportunity-finder/worker.ts");
    expect(worker).not.toContain('from("business_records")');
    const resultSelect = source("lib/opportunity-finder/api.ts").split("export const OPPORTUNITY_RESULT_SELECT")[1];
    expect(resultSelect).not.toMatch(/"price"|"cost"|"gp"|"gp_rate"|"commission"|"raw_data"/);
  });

  it("uses a dedicated worker without modifying duplicate cleanup", () => {
    expect(source("package.json")).toContain('"worker:opportunity-finder"');
    expect(source("scripts/opportunity-finder-worker.ts")).toContain("claimNextOpportunityFinderJob");
  });

  it("runs the Opportunity Finder worker with the production web process", () => {
    expect(source("package.json")).toContain('"start": "node scripts/start-production.mjs"');
    const productionStart = source("scripts/start-production.mjs");
    expect(productionStart).toContain('nextCli, "start"');
    expect(productionStart).toContain('"scripts/opportunity-finder-worker.ts"');
    expect(productionStart).toContain("SIGTERM");
  });

  it("derives idempotency from browser-computed file bytes", () => {
    const component = source("components/opportunity-finder/OpportunityFinder.tsx");
    const pipeline = source("lib/opportunity-finder/pipeline.ts");
    expect(component).toContain("selectedFiles.map((file) => sha256OpportunityFileContents(file!))");
    expect(pipeline).toContain("await file.arrayBuffer()");
    expect(pipeline).toContain('crypto.subtle.digest("SHA-256"');
    expect(component).toContain("contentSha256: contentHashes[index]");
    expect(component).not.toContain("uploadAttemptIdRef");
    expect(component).not.toContain("idempotencyKey:");
  });

  it("resolves pgcrypto digest from Supabase's trusted extensions schema", () => {
    const migration = source("supabase/migrations/20260808120000_opportunity_finder_advanced.sql");
    for (const functionName of [
      "materialize_opportunity_finder_entities",
      "opportunity_finder_candidate_uuid",
      "replace_opportunity_finder_job_output"
    ]) {
      const definition = migration.split(`create or replace function public.${functionName}`)[1]
        ?.split("as $$")[0];
      expect(definition).toContain("set search_path = pg_catalog, extensions, public");
    }
  });

  it("validates one/two-file modes and queues background work instead of parsing in HTTP", () => {
    const createRoute = source("app/api/opportunity-finder/jobs/route.ts");
    const profileRoute = source("app/api/opportunity-finder/jobs/[id]/profile/route.ts");
    expect(createRoute).toContain('comparisonMode: z.enum(["single_file", "two_files"])');
    expect(createRoute).toContain("z.array(fileSchema).min(1).max(2)");
    expect(createRoute).toContain("createSignedUploadUrl");
    expect(createRoute).not.toContain("parseOpportunityWorkbook");
    expect(profileRoute).toContain('status: "queued"');
  });

  it("allows only the database-only platform snapshot to use a JSON locator", () => {
    const migration = source("supabase/migrations/20260814160000_opportunity_virtual_file_storage.sql");
    expect(migration).toContain("new.source_kind = 'platform_snapshot'");
    expect(migration).toContain("then '.json'");
    expect(migration).toContain("when lower(new.original_file_name) ~ '\\.csv$' then '.csv'");
    expect(migration).toContain("when lower(new.original_file_name) ~ '\\.xlsx$' then '.xlsx'");
    expect(migration).toContain("opportunity_file_extension_invalid");
    expect(migration).not.toMatch(/allowed_mime_types[\s\S]*application\/json/i);
  });

  it("relaxes physical size only for a verified canonical platform snapshot", () => {
    const migration = source("supabase/migrations/20260815120000_fix_virtual_snapshot_verification.sql");
    const materializePatch = migration.split("corrected_guard constant text")[1]
      ?.split("$corrected_guard$;")[0] ?? "";
    expect(materializePatch).toContain("file.validation_status <> 'verified'");
    expect(materializePatch).toContain("file.content_sha256 is null");
    expect(materializePatch).toContain("file.source_kind = 'uploaded' and file.actual_size_bytes is null");
    expect(materializePatch).toContain("file.source_kind = 'platform_snapshot'");
    expect(materializePatch).toContain("file.mime_type is distinct from 'application/json'");
    expect(materializePatch).toContain("file.storage_bucket is distinct from 'opportunity-finder'");
    expect(materializePatch).toContain("locked_job.created_by::text");
    expect(materializePatch).toContain("file.id::text || '.json'");
    expect(migration).not.toMatch(/create\s+policy|drop\s+policy|alter\s+table[\s\S]{0,80}(enable|disable|force)\s+row\s+level\s+security/i);
  });

  it("reuses only unexpired active or successful single-file jobs", () => {
    const migration = source("supabase/migrations/20260815120000_fix_virtual_snapshot_verification.sql");
    const lookup = migration.split("corrected_lookup constant text")[1]
      ?.split("$corrected_lookup$;")[0] ?? "";
    for (const status of [
      "uploading",
      "queued",
      "profiling",
      "awaiting_roles",
      "parsing",
      "matching",
      "completed",
      "completed_with_warnings"
    ]) {
      expect(lookup).toContain(`'${status}'`);
    }
    expect(lookup).not.toContain("'failed'");
    expect(lookup).not.toContain("'cancelled'");
    expect(lookup).toContain("job.expires_at > now()");
    expect(lookup).toContain("pg_advisory_xact_lock");
    expect(lookup).toContain("job.comparison_mode = 'single_file'");
    expect(migration).toContain("create unique index opportunity_finder_jobs_two_file_idempotency_uidx");
    expect(migration).toContain("comparison_mode = 'two_files'");
  });

  it("covers upload, virtual snapshot, idempotency and zero-match runtime regressions", () => {
    const runtime = source("supabase/tests/opportunity_finder_virtual_snapshot_hotfix_runtime.sql");
    for (const assertion of [
      "physical CSV without actual size was accepted",
      "physical XLSX without actual size was accepted",
      "physical JSON upload was accepted",
      "unverified virtual snapshot was accepted",
      "virtual snapshot with invalid type was accepted",
      "virtual snapshot with invalid locator was accepted",
      "failed job was reused",
      "cancelled job was reused",
      "expired job was reused",
      "completed job was not reused",
      "processing job was not reused",
      "zero-match single-file job did not finish successfully"
    ]) {
      expect(runtime).toContain(assertion);
    }
    expect(runtime).toContain("rollback;");
  });

  it("guards snapshot effects by loaded job identity and clears provisional handoff state", () => {
    const component = source("components/opportunity-finder/OpportunityFinder.tsx");
    expect(component).toContain("data?.job.id !== jobId");
    const snapshotEffect = component.split("data?.job.id !== jobId")[1]
      ?.split("const roleCompatibility")[0] ?? "";
    expect(snapshotEffect).toContain('apiError.message === "COMPARISON_ALREADY_EXISTS"');
    expect(snapshotEffect).toContain("apiError.reusedExistingJob");
    expect(snapshotEffect.indexOf("setData(null)")).toBeLessThan(snapshotEffect.indexOf("setJobId(apiError.jobId)"));
    expect(snapshotEffect).not.toContain('apiError.message === "DATASET_SNAPSHOT_NOT_READY"');
  });

  it("persists cancellation, safe retry and owner-scoped idempotency", () => {
    const cancelRoute = source("app/api/opportunity-finder/jobs/[id]/cancel/route.ts");
    const retryRoute = source("app/api/opportunity-finder/jobs/[id]/retry/route.ts");
    const confirmRoute = source("app/api/opportunity-finder/jobs/[id]/confirm/route.ts");
    const profileRoute = source("app/api/opportunity-finder/jobs/[id]/profile/route.ts");
    const jobRoute = source("app/api/opportunity-finder/jobs/[id]/route.ts");
    const worker = source("lib/opportunity-finder/worker.ts");
    const migration = source("supabase/migrations/20260727090000_opportunity_finder.sql");
    expect(cancelRoute).toContain('rpc("cancel_opportunity_finder_job"');
    expect(retryRoute).toContain('rpc("retry_opportunity_finder_job"');
    expect(confirmRoute).toContain('rpc("confirm_opportunity_finder_roles"');
    expect(profileRoute).toContain('rpc("queue_opportunity_finder_profile"');
    expect(jobRoute).toContain('rpc("prepare_opportunity_finder_job_deletion"');
    expect(jobRoute).toContain('rpc("finalize_opportunity_finder_job_deletion"');
    expect(confirmRoute).toContain("file_b_valid_until");
    expect(worker).toContain('"reset_opportunity_finder_job_attempt"');
    expect(worker).not.toContain('.delete().eq("job_id", job.id)');
    expect(migration).toContain("opportunity_finder_jobs_owner_idempotency_uidx");
  });

  it("fences worker writes and rejects zero-row conditional updates", () => {
    const worker = source("lib/opportunity-finder/worker.ts");
    expect(worker).toContain('.update({ ...values, heartbeat_at: nowIso(), updated_at: nowIso() }, { count: "exact" })');
    expect(worker).toContain('.eq("locked_by", fence.workerId)');
    expect(worker).toContain('.eq("lock_token", fence.lockToken)');
    expect(worker).toContain('.eq("processing_fence", fence.processingFence)');
    expect(worker).toContain('if (fence && count === 0) throw new Error("OPPORTUNITY_WORKER_FENCE_LOST")');
    expect(worker).toContain('throw new Error("OPPORTUNITY_OUTPUT_FENCE_MISSING")');
    expect(worker).toContain("ingestion_lock_token: fence.lockToken");
    expect(worker).toContain("ingestion_fence: fence.processingFence");
  });

  it("binds verified file hashes and stages parser rejections until atomic commit", () => {
    const worker = source("lib/opportunity-finder/worker.ts");
    expect(worker).toContain('createHash("sha256")');
    expect(worker).toContain('pairHash.update(`pipeline:${OPPORTUNITY_FINDER_PIPELINE_VERSION}\\n`');
    expect(worker).toContain('pairHash.update(`${item.side}:${item.digest}\\n`');
    expect(worker).toContain("content_pair_sha256: pairHash.digest(\"hex\")");
    expect(worker).toContain("onRejected: async (rows) => {");
    expect(worker).toContain('"rejected_rows",');
    expect(worker).toContain("rows.map(rejectedRowInsert)");
    expect(worker).not.toContain('.from("opportunity_finder_rejected_rows")');
    expect(worker).toContain("safe_raw_value: row.safeRawValue");
  });

  it("stages every output path in fenced chunks and publishes it atomically", () => {
    const worker = source("lib/opportunity-finder/worker.ts");
    const reviewRoute = source("app/api/opportunity-finder/jobs/[id]/reviews/route.ts");
    const migration = source("supabase/migrations/20260808120000_opportunity_finder_advanced.sql");
    expect(worker).toContain('supabase.rpc("begin_opportunity_finder_output"');
    expect(worker).toContain('supabase.rpc("append_opportunity_finder_output"');
    expect(worker).toContain('supabase.rpc("commit_staged_opportunity_finder_output"');
    expect(worker).not.toContain('supabase.rpc("replace_opportunity_finder_job_output"');
    expect(worker).not.toContain('.from("opportunity_finder_results")');
    expect(worker).not.toContain('.from("opportunity_finder_possible_matches")');
    expect(worker).not.toContain("ATOMIC_OUTPUT_ALLOCATION_LIMIT");
    expect(worker).toContain("demand_part_option_id: allocation.demandPartOptionId");
    expect(worker).toContain("supply_lot_id: allocation.supplyLotId");
    expect(worker).toContain("OPPORTUNITY_ALLOCATION_DEMAND_OPTION_ID_MISSING");
    expect(worker).toContain('"reset_opportunity_finder_job_attempt"');
    expect(migration).toContain("incomplete_opportunity_output_manifest");
    expect(migration).toContain("input_start_index + item.ordinal - 1");
    expect(migration).not.toContain("output_payload_too_large");
    expect(reviewRoute).toContain('context.supabase.rpc(\n    "decide_opportunity_finder_review"');
    expect(migration).toContain("decision row, target review_status and audit event commit atomically");
    expect(migration).toContain("durable_review_required_before_allocation");
    expect(migration).toContain("allocation_option_lot_identity_mismatch");
    expect(migration).toContain("allocation_unit_of_measure_mismatch");
    expect(migration).toContain("has_approved_opportunity_finder_allocation_review");
  });

  it("runs retention cleanup continuously and never deletes jobs with live objects", () => {
    const cleanup = source("scripts/cleanup-opportunity-finder.ts");
    const productionStart = source("scripts/start-production.mjs");
    expect(productionStart).toContain('"scripts/cleanup-opportunity-finder.ts", "--loop"');
    expect(cleanup).toContain('"claim_opportunity_finder_file_retention"');
    expect(cleanup).toContain('"finalize_opportunity_finder_file_retention"');
    expect(cleanup).toContain('"abort_opportunity_finder_file_retention"');
    expect(cleanup).toContain('"prepare_opportunity_finder_expired_job_deletion"');
    expect(cleanup).toContain('"finalize_opportunity_finder_job_deletion"');
    expect(cleanup).toContain("jobsWithLiveObjects");
    expect(cleanup).toContain("jobsWithLiveObjects.has(job.id)");
    expect(cleanup).toContain("expiredJobsDeferred");
    expect(cleanup).not.toMatch(/\.from\("opportunity_finder_files"\)[\s\S]{0,200}\.(update|delete)\(/);
    expect(cleanup).not.toMatch(/\.from\("opportunity_finder_jobs"\)[\s\S]{0,200}\.delete\(/);
  });

  it("keeps privileged Storage access behind canonical owner/job/file references", () => {
    const worker = source("lib/opportunity-finder/worker.ts");
    const jobRoute = source("app/api/opportunity-finder/jobs/[id]/route.ts");
    const profileRoute = source("app/api/opportunity-finder/jobs/[id]/profile/route.ts");
    const cleanup = source("scripts/cleanup-opportunity-finder.ts");
    for (const privilegedCaller of [worker, jobRoute, profileRoute, cleanup]) {
      expect(privilegedCaller).toContain("assertCanonicalOpportunityStorageReference");
    }
    expect(jobRoute.indexOf("assertCanonicalOpportunityStorageReference"))
      .toBeLessThan(jobRoute.indexOf("service.storage"));
    expect(cleanup.indexOf("assertCanonicalOpportunityStorageReference"))
      .toBeLessThan(cleanup.indexOf("supabase.storage"));
  });

  it("uses authenticated reads for ownership and service-role writes for job mutations", () => {
    const routes = [
      "app/api/opportunity-finder/jobs/route.ts",
      "app/api/opportunity-finder/jobs/[id]/profile/route.ts",
      "app/api/opportunity-finder/jobs/[id]/confirm/route.ts",
      "app/api/opportunity-finder/jobs/[id]/retry/route.ts",
      "app/api/opportunity-finder/jobs/[id]/cancel/route.ts",
      "app/api/opportunity-finder/jobs/[id]/route.ts"
    ].map(source);
    for (const route of routes) {
      expect(route).toContain("createSupabaseServiceRoleClient");
    }
    expect(routes.join("\n")).not.toMatch(/context\.supabase\s*\n\s*\.from\("opportunity_finder_(jobs|files)"\)\s*\n\s*\.(insert|update|delete)/);
  });

  it("passes the job-level client context into every matcher execution path", () => {
    const worker = source("lib/opportunity-finder/worker.ts");
    expect(worker).toContain("customerContext: job.client_context ?? null");
    expect(worker).toContain("clientContext: input.customerContext");
  });

  it("publishes materialized entity counts in the incremental summary", () => {
    const worker = source("lib/opportunity-finder/worker.ts");
    expect(worker).toContain("summary.demandEvents = identities.demandEventCount");
    expect(worker).toContain("summary.demandPartOptions = identities.demandPartOptionCount");
    expect(worker).toContain("summary.supplyLots = identities.supplyLotCount");
  });

  it("uses a unique final tie-breaker for every paginated canonical-row scan", () => {
    const worker = source("lib/opportunity-finder/worker.ts");
    const paginatedCanonicalOrdering = /\.order\("normalized_mpn", \{ ascending: true \}\)\s+\.order\("required_date", \{ ascending: true, nullsFirst: false \}\)\s+\.order\("original_index", \{ ascending: true \}\)\s+\.order\("id", \{ ascending: true \}\)\s+\.range\(offset, offset \+ QUERY_PAGE_SIZE - 1\)/g;
    expect(worker.match(paginatedCanonicalOrdering)).toHaveLength(2);
  });

  it("keeps legacy seller routes available during the transition", () => {
    expect(fs.existsSync(path.join(root, "app/mpn-comparator/page.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(root, "app/opportunities/page.tsx"))).toBe(true);
  });

  it("uses mobile cards, stacked controls and touch-sized actions without a wide table", () => {
    const finder = source("components/opportunity-finder/OpportunityFinder.tsx");
    const card = source("components/opportunity-finder/OpportunityCard.tsx");
    expect(finder).toContain("overflow-x-hidden");
    expect(finder).toContain("md:grid-cols-2");
    expect(finder).toContain("min-h-11");
    expect(card).toContain("grid-cols-2");
    expect(card).not.toContain("<table");
    const responsiveVerifier = source("scripts/verify-opportunity-responsive.mjs");
    for (const width of [360, 390, 430, 768, 1024, 1366, 1440, 1920]) {
      expect(responsiveVerifier).toContain(`width: ${width}`);
    }
  });

  it("ships ES, EN and simplified Chinese module copy", () => {
    const i18n = source("lib/opportunity-finder/i18n.ts");
    expect(i18n).toContain('title: "Buscador de oportunidades"');
    expect(i18n).toContain('title: "Opportunity Finder"');
    expect(i18n).toContain('title: "销售机会查找器"');
    expect(i18n).not.toContain("High Confidence");
  });
});
