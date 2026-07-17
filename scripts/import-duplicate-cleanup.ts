import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  BUSINESS_RECORD_DUPLICATE_CRITERION,
  buildDuplicateCleanupPlan
} from "../lib/upload/duplicate-cleanup";

const execAsync = promisify(exec);
const PAGE_SIZE = 5000;

type JsonRecord = Record<string, unknown>;
type CliJsonResult = {
  rows: JsonRecord[];
};
type RunSqlOptions = {
  debug?: boolean;
  label?: string;
};
type JobLookup = {
  jobId: string;
  uploadBatchId: string;
  status: string | null;
  rowsReturned: number;
};
type DuplicateDiagnostics = JsonRecord & {
  jobId: string;
  uploadBatchId: string;
  sampleDuplicateGroups: unknown[];
  plan: ReturnType<typeof buildDuplicateCleanupPlan>;
};

function arg(name: string) {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function assertUuid(value: string | undefined, name: string) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Missing or invalid ${name}.`);
  }
  return value;
}

function safeErrorMessage(error: unknown) {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.code, record.details, record.hint].filter(Boolean).map(String);
    if (parts.length) return parts.join(" | ").slice(0, 800);
  }
  const value = error instanceof Error ? error.message : JSON.stringify(error);
  return String(value ?? "Unknown error").slice(0, 800);
}

function normalizeCliRows(parsed: unknown): CliJsonResult {
  if (Array.isArray(parsed)) {
    return { rows: parsed.filter((row): row is JsonRecord => Boolean(row) && typeof row === "object" && !Array.isArray(row)) };
  }

  if (parsed && typeof parsed === "object") {
    const record = parsed as JsonRecord;
    if (Array.isArray(record.rows)) {
      return { rows: record.rows.filter((row): row is JsonRecord => Boolean(row) && typeof row === "object" && !Array.isArray(row)) };
    }
    if (Array.isArray(record.data)) {
      return { rows: record.data.filter((row): row is JsonRecord => Boolean(row) && typeof row === "object" && !Array.isArray(row)) };
    }
    const knownRowKeys = ["audit", "cleanup", "diagnostics", "job_lookup", "page", "result"];
    if (knownRowKeys.some((key) => key in record)) return { rows: [record] };
  }

  throw new Error("Supabase CLI JSON output did not include a rows array or top-level row array.");
}

function parseCliJson(stdout: string): CliJsonResult {
  const cleaned = stdout.replace(/\u001b\[[0-9;]*m/g, "");
  const starts = Array.from(cleaned.matchAll(/[\[{]/g), (match) => match.index ?? -1).filter((index) => index >= 0);

  for (const start of starts) {
    const opener = cleaned[start];
    const closer = opener === "[" ? "]" : "}";
    const end = cleaned.lastIndexOf(closer);
    if (end < start) continue;

    try {
      return normalizeCliRows(JSON.parse(cleaned.slice(start, end + 1)));
    } catch {
      // Keep scanning. Supabase CLI can print prefixed noise before the JSON payload.
    }
  }

  const tableHint = cleaned.includes("┌")
    ? " Supabase CLI returned table output; ensure --output-format json is supported by this CLI version."
    : "";
  throw new Error(`Unable to parse Supabase CLI JSON output.${tableHint} First output: ${cleaned.slice(0, 200)}`);
}

function debugLog(enabled: boolean | undefined, payload: JsonRecord) {
  if (!enabled) return;
  console.error(JSON.stringify({ debug: true, ...payload }, null, 2));
}

async function runSql(sql: string, options: RunSqlOptions = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quiksol-supabase-query-"));
  const sqlPath = path.join(tempDir, "query.sql");
  try {
    await fs.writeFile(sqlPath, sql, "utf8");
    debugLog(options.debug, {
      label: options.label ?? "sql",
      sqlPath,
      sql
    });
    const escapedSqlPath = `"${sqlPath.replace(/"/g, '\\"')}"`;
    const { stdout } = await execAsync(`npx supabase db query --linked --output-format json --file ${escapedSqlPath}`, {
      maxBuffer: 1024 * 1024 * 50
    });
    const parsed = parseCliJson(stdout);
    debugLog(options.debug, {
      label: `${options.label ?? "sql"}_result`,
      rowsReturned: parsed.rows.length
    });
    return parsed;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseJsonCell(value: unknown) {
  if (typeof value === "string") return JSON.parse(value) as JsonRecord;
  if (value && typeof value === "object") return value as JsonRecord;
  return {};
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function getJobLookup(jobId: string, debug?: boolean): Promise<JobLookup> {
  const sql = `
    select jsonb_build_object(
      'rowCount', count(*),
      'job', coalesce((jsonb_agg(to_jsonb(job_rows))->0), 'null'::jsonb)
    ) as job_lookup
    from (
      select
        id,
        status,
        upload_batch_id,
        created_at,
        updated_at
      from public.import_jobs
      where id = ${sqlLiteral(jobId)}::uuid
    ) job_rows;
  `;
  const result = await runSql(sql, { debug, label: "job_lookup" });
  const lookup = parseJsonCell(result.rows[0]?.job_lookup);
  const rowsReturned = Number(lookup.rowCount ?? 0);
  const job = parseJsonCell(lookup.job);
  const uploadBatchId = String(job.upload_batch_id ?? "");

  debugLog(debug, {
    label: "job_lookup_parsed",
    jobId,
    rowsReturned,
    uploadBatchId: uploadBatchId || null,
    status: job.status ?? null
  });

  if (rowsReturned <= 0) {
    throw new Error(`SQL returned 0 rows from public.import_jobs for jobId ${jobId}.`);
  }
  if (!uploadBatchId) {
    throw new Error(`Import job ${jobId} exists in public.import_jobs but upload_batch_id is missing.`);
  }

  return {
    jobId: String(job.id ?? jobId),
    uploadBatchId,
    status: job.status ? String(job.status) : null,
    rowsReturned
  };
}

async function tableExists(tableName: string) {
  const sql = `
    select jsonb_build_object(
      'exists',
      exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = ${sqlLiteral(tableName)}
      )
    ) as result;
  `;
  const result = await runSql(sql);
  const payload = parseJsonCell(result.rows?.[0]?.result);
  return payload.exists === true;
}

async function writeCleanupAudit(action: string, uploadBatchId: string, metadata: JsonRecord) {
  try {
    if (!(await tableExists("audit_logs"))) return { recorded: false, reason: "audit_logs not found" };
  } catch (error) {
    return { recorded: false, reason: safeErrorMessage(error) };
  }

  const sql = `
    insert into public.audit_logs (
      actor_id,
      actor_email,
      action,
      entity_type,
      entity_id,
      ip_address,
      user_agent,
      metadata
    )
    values (
      null,
      'system:duplicate-cleanup-cli',
      ${sqlLiteral(action)},
      'upload_batch',
      ${sqlLiteral(uploadBatchId)}::uuid,
      null,
      'quiksol-cli',
      ${sqlLiteral(JSON.stringify(metadata))}::jsonb
    );
    select jsonb_build_object('recorded', true) as audit;
  `;

  try {
    await runSql(sql);
    return { recorded: true };
  } catch (error) {
    return { recorded: false, reason: safeErrorMessage(error) };
  }
}

function buildDedupeCte(jobId: string) {
  return `
    with job as (
      select
        id,
        upload_batch_id,
        status,
        original_file_name,
        total_rows,
        processed_rows,
        successful_rows,
        failed_rows,
        warning_count,
        rows_with_warnings,
        technical_error_count,
        progress_percent
      from public.import_jobs
      where id = ${sqlLiteral(jobId)}::uuid
    ),
    upload as (
      select
        u.id,
        u.status,
        u.original_file_name,
        u.total_rows,
        u.processed_rows,
        u.successful_rows,
        u.valid_rows,
        u.failed_rows,
        u.warning_count,
        u.rows_with_warnings,
        u.technical_error_count
      from public.upload_batches u
      join job j on j.upload_batch_id = u.id
    ),
    expected as (
      select greatest(
        coalesce(j.successful_rows, 0),
        coalesce(u.successful_rows, 0),
        coalesce(u.valid_rows, 0),
        coalesce(j.processed_rows, 0),
        coalesce(j.total_rows, 0),
        coalesce(u.total_rows, 0)
      )::int as expected_records
      from job j
      left join upload u on true
    ),
    active_records as (
      select
        br.id,
        br.row_index,
        br.category,
        br.created_at,
        md5(coalesce(br.raw_data, '{}'::jsonb)::text) as raw_hash,
        md5(coalesce(br.normalized_data, '{}'::jsonb)::text) as normalized_hash
      from public.business_records br
      join job j on j.upload_batch_id = br.upload_batch_id
      where br.archived_at is null
    ),
    ranked as (
      select
        *,
        count(*) over (
          partition by row_index, raw_hash, normalized_hash, coalesce(category, '')
        ) as group_size,
        first_value(id) over (
          partition by row_index, raw_hash, normalized_hash, coalesce(category, '')
          order by created_at desc, id desc
        ) as keeper_id,
        row_number() over (
          partition by row_index, raw_hash, normalized_hash, coalesce(category, '')
          order by created_at desc, id desc
        ) as duplicate_rank
      from active_records
    ),
    duplicate_groups as (
      select
        row_index,
        raw_hash,
        normalized_hash,
        coalesce(category, '') as category,
        count(*) as records_in_group,
        min(created_at) as first_seen_at,
        max(created_at) as last_seen_at,
        max(keeper_id::text) as keeper_id
      from ranked
      where group_size > 1
      group by row_index, raw_hash, normalized_hash, coalesce(category, '')
    ),
    candidates as (
      select
        id,
        row_index,
        raw_hash,
        normalized_hash,
        coalesce(category, '') as category,
        created_at,
        keeper_id
      from ranked
      where duplicate_rank > 1
    )
  `;
}

async function getDiagnostics(jobId: string, debug?: boolean): Promise<DuplicateDiagnostics> {
  const jobLookup = await getJobLookup(jobId, debug);
  const sql = `
    ${buildDedupeCte(jobId)}
    select jsonb_build_object(
      'jobId', (select id from job),
      'uploadBatchId', (select upload_batch_id from job),
      'fileName', coalesce((select original_file_name from job), (select original_file_name from upload)),
      'jobStatus', (select status from job),
      'uploadStatus', (select status from upload),
      'rowsProcessed', (
        select greatest(coalesce(j.processed_rows, 0), coalesce(u.processed_rows, 0))::int
        from job j
        left join upload u on true
      ),
      'rowsImported', (
        select greatest(coalesce(j.successful_rows, 0), coalesce(u.successful_rows, 0), coalesce(u.valid_rows, 0))::int
        from job j
        left join upload u on true
      ),
      'jobTotalRows', (select total_rows from job),
      'warningCount', (
        select greatest(coalesce(j.warning_count, 0), coalesce(u.warning_count, 0))::int
        from job j
        left join upload u on true
      ),
      'rowsWithWarnings', (
        select greatest(coalesce(j.rows_with_warnings, 0), coalesce(u.rows_with_warnings, 0))::int
        from job j
        left join upload u on true
      ),
      'technicalErrors', (
        select greatest(coalesce(j.technical_error_count, 0), coalesce(u.technical_error_count, 0))::int
        from job j
        left join upload u on true
      ),
      'criterion', ${sqlLiteral(BUSINESS_RECORD_DUPLICATE_CRITERION)},
      'expectedRecords', (select expected_records from expected),
      'activeRecords', (select count(*) from active_records),
      'businessRecordsCountReal', (select count(*) from active_records),
      'duplicateGroups', (select count(*) from duplicate_groups),
      'duplicateRecordsToArchive', (select count(*) from candidates),
      'possibleDuplicatesCount', (select count(*) from candidates),
      'duplicateDetectionMethod', ${sqlLiteral(BUSINESS_RECORD_DUPLICATE_CRITERION)},
      'uniqueRecordsAfterExactDedupe', (select count(*) from ranked where duplicate_rank = 1),
      'maxGroupSize', coalesce((select max(records_in_group) from duplicate_groups), 0),
      'createdAtRange', (
        select jsonb_build_object('first', min(created_at), 'last', max(created_at))
        from active_records
      ),
      'sampleDuplicateGroups', coalesce((
        select jsonb_agg(jsonb_build_object(
          'rowIndex', row_index,
          'recordsInGroup', records_in_group,
          'recordsToArchive', records_in_group - 1,
          'rawHashPrefix', left(raw_hash, 12),
          'normalizedHashPrefix', left(normalized_hash, 12),
          'keeperId', keeper_id,
          'firstSeenAt', first_seen_at,
          'lastSeenAt', last_seen_at
        ))
        from (
          select *
          from duplicate_groups
          order by records_in_group desc, row_index nulls last
          limit 10
        ) samples
      ), '[]'::jsonb)
    ) as diagnostics;
  `;
  const result = await runSql(sql, { debug, label: "duplicate_diagnostics" });
  if (result.rows.length <= 0) {
    throw new Error(`Duplicate diagnostics SQL returned 0 rows after public.import_jobs confirmed jobId ${jobId}.`);
  }
  const diagnostics = parseJsonCell(result.rows[0]?.diagnostics);
  if (!diagnostics.jobId) {
    throw new Error(
      `Duplicate diagnostics SQL did not return jobId after public.import_jobs confirmed upload_batch_id ${jobLookup.uploadBatchId}.`
    );
  }
  if (!diagnostics.uploadBatchId) {
    throw new Error(`Duplicate diagnostics SQL did not return upload_batch_id for jobId ${jobId}.`);
  }

  debugLog(debug, {
    label: "duplicate_diagnostics_parsed",
    jobId,
    rowsReturned: result.rows.length,
    uploadBatchId: diagnostics.uploadBatchId,
    activeRecords: diagnostics.activeRecords ?? null,
    expectedRecords: diagnostics.expectedRecords ?? null,
    duplicateRecordsToArchive: diagnostics.duplicateRecordsToArchive ?? null
  });

  const plan = buildDuplicateCleanupPlan({
    expectedRecords: Number(diagnostics.expectedRecords ?? 0),
    activeRecords: Number(diagnostics.activeRecords ?? 0),
    duplicateGroups: Number(diagnostics.duplicateGroups ?? 0),
    duplicateRecordsToArchive: Number(diagnostics.duplicateRecordsToArchive ?? 0),
    uniqueRecordsAfterExactDedupe: Number(diagnostics.uniqueRecordsAfterExactDedupe ?? 0),
    maxGroupSize: Number(diagnostics.maxGroupSize ?? 0)
  });

  return {
    ...diagnostics,
    jobId: String(diagnostics.jobId),
    uploadBatchId: String(diagnostics.uploadBatchId),
    sampleDuplicateGroups: Array.isArray(diagnostics.sampleDuplicateGroups) ? diagnostics.sampleDuplicateGroups : [],
    plan
  };
}

async function getCandidatePage(jobId: string, offset: number, debug?: boolean) {
  const sql = `
    ${buildDedupeCte(jobId)}
    select jsonb_build_object(
      'candidates', coalesce(jsonb_agg(jsonb_build_object(
        'id', id,
        'rowIndex', row_index,
        'rawHashPrefix', left(raw_hash, 12),
        'normalizedHashPrefix', left(normalized_hash, 12),
        'keeperId', keeper_id,
        'createdAt', created_at
      ) order by row_index nulls last, created_at, id), '[]'::jsonb)
    ) as page
    from (
      select *
      from candidates
      order by row_index nulls last, created_at, id
      limit ${PAGE_SIZE}
      offset ${offset}
    ) page_rows;
  `;
  const result = await runSql(sql, { debug, label: `candidate_page_${offset}` });
  const page = parseJsonCell(result.rows[0]?.page);
  return (page.candidates ?? []) as JsonRecord[];
}

async function writeReport(jobId: string, diagnostics: JsonRecord, includeCandidates: boolean, debug?: boolean) {
  const outputDir = path.join(process.cwd(), "outputs", "duplicate-cleanup");
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(outputDir, `${stamp}-${jobId}-${includeCandidates ? "backup" : "dry-run"}.json`);
  const report: JsonRecord = {
    generatedAt: new Date().toISOString(),
    mode: includeCandidates ? "backup_before_soft_archive" : "dry_run",
    diagnostics
  };

  let candidateCount = 0;
  let candidateIdsSha256: string | null = null;
  if (includeCandidates) {
    const candidates: JsonRecord[] = [];
    const idHash = createHash("sha256");
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await getCandidatePage(jobId, offset, debug);
      candidates.push(...page);
      for (const candidate of page) idHash.update(`${String(candidate.id ?? "")}\n`);
      if (page.length < PAGE_SIZE) break;
    }
    report.candidates = candidates;
    candidateCount = candidates.length;
    candidateIdsSha256 = idHash.digest("hex");
    report.candidateCount = candidateCount;
    report.candidateIdsSha256 = candidateIdsSha256;
  }

  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { reportPath, candidateCount, candidateIdsSha256 };
}

async function assertReportExists(reportPath: string) {
  const stats = await fs.stat(reportPath);
  if (!stats.isFile() || stats.size <= 0) throw new Error("Backup report was not created.");
}

function validateApplyPreflight(diagnostics: DuplicateDiagnostics, candidateCount: number) {
  if (!diagnostics.jobId) throw new Error("Cannot apply cleanup because the job was not confirmed.");
  if (!diagnostics.uploadBatchId) throw new Error("Cannot apply cleanup because upload_batch_id was not confirmed.");
  if (!diagnostics.plan.cleanupSafe) throw new Error(`Cleanup is not safe automatically. Confidence is ${diagnostics.plan.confidenceLevel}.`);
  if (diagnostics.plan.confidenceLevel !== "high") throw new Error(`Cleanup requires high confidence. Current confidence is ${diagnostics.plan.confidenceLevel}.`);
  if (diagnostics.plan.duplicateRecordsToArchive <= 0) throw new Error("No exact duplicate records were detected.");
  if (candidateCount <= 0) throw new Error("No target IDs were calculated.");
  if (candidateCount !== diagnostics.plan.duplicateRecordsToArchive) {
    throw new Error(`Backup candidate count mismatch. Expected ${diagnostics.plan.duplicateRecordsToArchive}, got ${candidateCount}.`);
  }
}

async function applySoftArchive(jobId: string, debug?: boolean) {
  const sql = `
    ${buildDedupeCte(jobId)}
    , archived as (
      update public.business_records br
      set archived_at = now()
      from candidates c
      where br.id = c.id
        and br.archived_at is null
      returning br.id
    )
    select jsonb_build_object(
      'archivedRecords', (select count(*) from archived),
      'remainingActiveRecords', (
        select count(*)
        from public.business_records br
        join job j on j.upload_batch_id = br.upload_batch_id
        where br.archived_at is null
      )
    ) as cleanup;
  `;
  const result = await runSql(sql, { debug, label: "apply_soft_archive" });
  return parseJsonCell(result.rows[0]?.cleanup);
}

function buildSummary(jobId: string, diagnostics: DuplicateDiagnostics) {
  return {
    jobId,
    uploadBatchId: diagnostics.uploadBatchId,
    fileName: diagnostics.fileName ?? null,
    jobStatus: diagnostics.jobStatus ?? null,
    uploadStatus: diagnostics.uploadStatus ?? null,
    rowsProcessed: Number(diagnostics.rowsProcessed ?? 0),
    rowsImported: Number(diagnostics.rowsImported ?? 0),
    businessRecordsCountReal: diagnostics.plan.activeRecords,
    realActiveRecords: diagnostics.plan.activeRecords,
    expectedRecords: diagnostics.plan.expectedRecords,
    possibleDuplicatesCount: diagnostics.plan.duplicateRecordsToArchive,
    duplicateGroups: diagnostics.plan.duplicateGroups,
    duplicateRecordsToArchive: diagnostics.plan.duplicateRecordsToArchive,
    plannedRemainingRecords: diagnostics.plan.plannedRemainingRecords,
    residualAfterCleanup: diagnostics.plan.residualAfterCleanup,
    duplicateDetectionMethod: diagnostics.plan.criterion,
    criterion: diagnostics.plan.criterion,
    confidenceLevel: diagnostics.plan.confidenceLevel,
    cleanupSafe: diagnostics.plan.cleanupSafe,
    cleanupMode: diagnostics.plan.cleanupMode,
    risk: diagnostics.plan.risk,
    recommendedAction: diagnostics.plan.recommendation
  };
}

async function main() {
  let mutationStarted = false;
  try {
    const jobId = assertUuid(arg("jobId") ?? arg("job-id"), "jobId");
    const apply = hasFlag("apply");
    const explicitDryRun = hasFlag("dry-run");
    const debug = hasFlag("debug");
    if (apply && explicitDryRun) throw new Error("Use either --dry-run or --apply, not both.");

    debugLog(debug, {
      label: "args",
      jobId,
      jobIdLength: jobId.length,
      apply,
      dryRun: explicitDryRun || !apply
    });

    const diagnostics = await getDiagnostics(jobId, debug);
    const { reportPath, candidateCount, candidateIdsSha256 } = await writeReport(jobId, diagnostics, apply, debug);
    const summary = buildSummary(jobId, diagnostics);

    if (!apply) {
      console.log(JSON.stringify({
        mode: "dry-run",
        reportPath,
        ...summary,
        groupedDuplicateCandidates: diagnostics.sampleDuplicateGroups
      }, null, 2));
      return;
    }

    validateApplyPreflight(diagnostics, candidateCount);
    await assertReportExists(reportPath);

    const auditBase = {
      ...summary,
      reportPath,
      backupCandidateCount: candidateCount,
      candidateIdsSha256
    };
    console.log(JSON.stringify({
      mode: "apply-preflight",
      reportPath,
      ...summary,
      backupCandidateCount: candidateCount,
      candidateIdsSha256,
      note: "About to soft-archive exact duplicate records by setting archived_at; no rows will be hard-deleted."
    }, null, 2));

    const startedAudit = await writeCleanupAudit("cleanup_started", diagnostics.uploadBatchId, auditBase);
    mutationStarted = true;
    const cleanup = await applySoftArchive(jobId, debug);
    const completedAudit = await writeCleanupAudit("cleanup_completed", diagnostics.uploadBatchId, {
      ...auditBase,
      archivedRecords: cleanup.archivedRecords,
      remainingActiveRecords: cleanup.remainingActiveRecords,
      residualAfterCleanup: Number(cleanup.remainingActiveRecords ?? 0) - Number(diagnostics.plan.expectedRecords ?? 0)
    });

    console.log(JSON.stringify({
      mode: "apply",
      reportPath,
      ...summary,
      duplicateRecordsPlanned: summary.duplicateRecordsToArchive,
      archivedRecords: cleanup.archivedRecords,
      remainingActiveRecords: cleanup.remainingActiveRecords,
      residualAfterCleanup: Number(cleanup.remainingActiveRecords ?? 0) - Number(diagnostics.plan.expectedRecords ?? 0),
      audit: {
        cleanupStarted: startedAudit,
        cleanupCompleted: completedAudit
      },
      note: "Records were soft-archived by setting archived_at; no rows were hard-deleted."
    }, null, 2));
  } catch (error) {
    console.error(safeErrorMessage(error));
    if (!mutationStarted) console.error("No records were modified.");
    else console.error("Mutation started before the failure. Use the backup report to verify and restore if needed.");
    process.exit(1);
  }
}

main();
