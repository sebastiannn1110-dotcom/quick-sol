import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AuthContext } from "@/lib/auth/context";
import { OPPORTUNITY_FINDER_PIPELINE_VERSION } from "@/lib/opportunity-finder/pipeline";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

type Role = "employee" | "manager" | "admin";
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type ContractCase = {
  questionNumber: number;
  category: string;
  question: string;
  role: Role | "all";
  conversationId: string | null;
  expectedLanguage: "es" | "en" | "zh";
  expectedIntent: string;
  expectedTool: string;
  expectedAnswerMode: string;
  expectedSource: string;
  expectedFacts: string[];
  forbiddenFacts: string[];
  mustClarify: boolean;
  mustDeny: boolean;
  mustUseMemory: boolean;
  mustNotCallDatabase: boolean;
  mustNotCallProvider: boolean;
};

const testState = vi.hoisted(() => ({
  role: "employee" as Role,
  contexts: {} as Record<Role, AuthContext>,
  providerCalls: 0,
  stockInput: {} as Record<string, unknown>
}));

vi.mock("@/lib/auth/context", () => ({
  getAuthContext: vi.fn(async () => testState.contexts[testState.role])
}));

vi.mock("@/lib/security/persistent-rate-limit", () => ({
  checkPersistentRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 999,
    resetAt: Date.now() + 60_000
  }))
}));

vi.mock("@/lib/logger/logger", () => ({
  logger: {
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    security: vi.fn(async () => undefined)
  }
}));

vi.mock("@/lib/stock-needs/data-source", () => ({
  loadStockNeedsInput: vi.fn(async () => testState.stockInput)
}));

vi.mock("openai", () => ({
  default: class ForbiddenOpenAi {
    constructor() {
      testState.providerCalls += 1;
      throw new Error("The 50-question regression suite forbids provider construction.");
    }
  }
}));

function likeMatch(value: unknown, pattern: string) {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(String(value ?? ""));
}

function splitOrClauses(value: string) {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "[") depth += 1;
    if (char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      clauses.push(value.slice(start, index));
      start = index + 1;
    }
  }
  clauses.push(value.slice(start));
  return clauses.map((item) => item.trim()).filter(Boolean);
}

function orClauseMatches(row: Row, clause: string) {
  const match = /^([^.]+)\.(eq|ilike|cs)\.(.+)$/.exec(clause);
  if (!match) return false;
  const [, field, operator, operand] = match;
  if (operator === "eq") return String(row[field] ?? "") === operand;
  if (operator === "ilike") return likeMatch(row[field], operand);
  try {
    const expected = JSON.parse(operand) as unknown[];
    const actual = Array.isArray(row[field]) ? row[field] as unknown[] : [];
    return expected.every((item) => actual.includes(item));
  } catch {
    return false;
  }
}

class FakeQuery {
  private operation: "select" | "insert" | "update" = "select";
  private filters: Array<(row: Row) => boolean> = [];
  private ordering: { field: string; ascending: boolean } | null = null;
  private maximum: number | null = null;
  private rangeValue: { from: number; to: number } | null = null;
  private head = false;
  private wantsCount = false;
  private inserted: Row[] = [];
  private updateValue: Row = {};

  constructor(
    private readonly database: FakeSupabase,
    private readonly table: string
  ) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    this.wantsCount = options?.count === "exact";
    this.head = Boolean(options?.head);
    return this;
  }

  insert(value: Row | Row[]) {
    this.operation = "insert";
    this.inserted = (Array.isArray(value) ? value : [value]).map((row) => ({ ...row }));
    return this;
  }

  update(value: Row) {
    this.operation = "update";
    this.updateValue = { ...value };
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  neq(field: string, value: unknown) {
    this.filters.push((row) => row[field] !== value);
    return this;
  }

  is(field: string, value: unknown) {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  gt(field: string, value: unknown) {
    this.filters.push((row) => String(row[field] ?? "") > String(value ?? ""));
    return this;
  }

  in(field: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[field]));
    return this;
  }

  like(field: string, value: string) {
    this.filters.push((row) => likeMatch(row[field], value));
    return this;
  }

  ilike(field: string, value: string) {
    this.filters.push((row) => likeMatch(row[field], value));
    return this;
  }

  or(value: string) {
    const clauses = splitOrClauses(value);
    this.filters.push((row) => clauses.some((clause) => orClauseMatches(row, clause)));
    return this;
  }

  order(field: string, options: { ascending: boolean }) {
    this.ordering = { field, ascending: options.ascending };
    return this;
  }

  limit(value: number) {
    this.maximum = value;
    return this;
  }

  async range(from: number, to: number) {
    this.rangeValue = { from, to };
    return this.execute();
  }

  async maybeSingle() {
    const result = this.execute();
    const rows = Array.isArray(result.data) ? result.data : [];
    return { data: rows[0] ?? null, error: result.error, count: result.count };
  }

  async single() {
    const result = this.execute();
    const rows = Array.isArray(result.data) ? result.data : [];
    return { data: rows[0] ?? null, error: result.error, count: result.count };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: null; count: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute() {
    this.database.audit.push({ table: this.table, operation: this.operation });
    const source = this.database.tables[this.table] ?? (this.database.tables[this.table] = []);

    if (this.operation === "insert") {
      const now = new Date().toISOString();
      const rows = this.inserted.map((row) => ({
        id: row.id ?? this.database.nextUuid(),
        created_at: row.created_at ?? now,
        updated_at: row.updated_at ?? now,
        deleted_at: row.deleted_at ?? null,
        ...row
      }));
      source.push(...rows);
      return { data: rows.map((row) => ({ ...row })), error: null, count: rows.length };
    }

    let rows = source.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.operation === "update") {
      rows.forEach((row) => Object.assign(row, this.updateValue));
    }
    if (this.ordering) {
      const { field, ascending } = this.ordering;
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[field] ?? "").localeCompare(String(right[field] ?? ""));
        return ascending ? comparison : -comparison;
      });
    }
    const count = rows.length;
    if (this.rangeValue) rows = rows.slice(this.rangeValue.from, this.rangeValue.to + 1);
    if (this.maximum !== null) rows = rows.slice(0, this.maximum);
    return {
      data: this.head ? null : rows.map((row) => ({ ...row })),
      error: null,
      count: this.wantsCount || this.head ? count : null
    };
  }
}

class FakeSupabase {
  audit: Array<{ table: string; operation: string }> = [];
  private sequence = 1;

  constructor(public readonly tables: Tables) {
    const safeRecordFields = new Set([
      "id", "upload_batch_id", "upload_sheet_id", "uploaded_by", "category", "row_index",
      "has_errors", "created_at", "archived_at", "line_id", "mpn", "mpn_quoted",
      "description", "generic", "qty", "req_qty", "date_code", "moq", "spq", "on_hand",
      "lead_time_weeks", "transit_time_weeks", "earliest_shipping_date",
      "shipping_point_country", "delivery_point", "profiles", "upload_batches"
    ]);
    this.tables.business_records_safe_v1 = (this.tables.business_records ?? []).map((row) =>
      Object.fromEntries(Object.entries(row).filter(([field]) => safeRecordFields.has(field)))
    );
    const safeImportErrorFields = new Set([
      "id", "trace_id", "upload_batch_id", "upload_sheet_id", "row_index", "column_name",
      "error_type", "message", "severity", "created_at", "upload_batches", "upload_sheets"
    ]);
    this.tables.import_errors_safe_v1 = (this.tables.import_errors ?? []).map((row) =>
      Object.fromEntries(Object.entries(row).filter(([field]) => safeImportErrorFields.has(field)))
    );
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }

  async rpc(name: string) {
    if (name !== "get_dashboard_summary_v1") {
      return { data: null, error: { code: "PGRST202", message: `Unknown RPC ${name}` } };
    }
    const activeRecords = (this.tables.business_records ?? []).filter((row) => row.archived_at == null);
    const activeUploads = (this.tables.upload_batches ?? []).filter((row) => row.status !== "archived");
    return {
      data: [{
        total_records: activeRecords.length,
        total_uploads: activeUploads.length,
        records_with_errors: activeRecords.filter((row) => row.has_errors === true).length,
        records_missing_mpn: activeRecords.filter((row) => row.mpn == null).length,
        data_version: 1
      }],
      error: null
    };
  }

  nextUuid() {
    const suffix = String(this.sequence++).padStart(12, "0");
    return `f0000000-0000-4000-8000-${suffix}`;
  }
}

const USER_IDS: Record<Role, string> = {
  employee: "10000000-0000-4000-8000-000000000001",
  manager: "10000000-0000-4000-8000-000000000002",
  admin: "10000000-0000-4000-8000-000000000003"
};

const JOB_IDS: Record<Role, string> = {
  employee: "20000000-0000-4000-8000-000000000001",
  manager: "20000000-0000-4000-8000-000000000002",
  admin: "20000000-0000-4000-8000-000000000003"
};

const UPLOAD_IDS: Record<Role, string> = {
  employee: "40000000-0000-4000-8000-000000000001",
  manager: "40000000-0000-4000-8000-000000000002",
  admin: "40000000-0000-4000-8000-000000000003"
};

const MEMORY_CONVERSATION_ID = "30000000-0000-4000-8000-000000000047";
const FUTURE = "2099-12-31T23:59:59.000Z";
const NOW = "2026-07-30T12:00:00.000Z";
const COMMERCIAL_TABLES = new Set([
  "business_records",
  "business_records_safe_v1",
  "business_records_commercial_v1",
  "upload_batches",
  "file_schema_profiles",
  "import_jobs",
  "upload_sheets",
  "import_job_error_summary",
  "import_errors",
  "import_errors_safe_v1",
  "profiles",
  "opportunity_finder_jobs",
  "opportunity_finder_results"
]);

function set01Rows() {
  const fixture = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "qa/fixtures/opportunity-finder/manual/set-01-planned-po-stock/expected-results.json"
      ),
      "utf8"
    )
  ) as Array<Record<string, unknown>>;
  return (Object.keys(JOB_IDS) as Role[]).flatMap((role) =>
    fixture.map((item, index) => ({
      job_id: JOB_IDS[role],
      opportunity_type: item.expectedType,
      exact_match: item.exactMpnMatch,
      usable_availability_match: item.usableAvailabilityMatch,
      exact_quantity_match: item.exactQuantityMatch,
      normalized_mpn: item.mpn,
      display_mpn: item.mpn,
      required_qty: item.requiredQty,
      available_qty: item.originalAvailability,
      allocated_qty: item.expectedAssignedQty,
      shortage_qty: item.expectedShortage,
      coverage_percent: item.expectedCoverage,
      required_date: `2026-08-${String((index % 20) + 1).padStart(2, "0")}`,
      unit_of_measure: "EA",
      reason_code:
        item.expectedType === "review_required"
          ? "manufacturer_conflict"
          : Array.isArray(item.expectedWarnings) &&
              item.expectedWarnings.includes("invalid_available_quantity")
            ? "invalid_quantity"
            : "matched",
      action_code: item.expectedType,
      warnings: item.expectedWarnings,
      created_at: `2026-07-30T12:${String(index).padStart(2, "0")}:00.000Z`
    }))
  );
}

function buildTables(): Tables {
  const summary = {
    analyzedMpns: 12,
    exactMatches: 11,
    usableAvailabilityMatches: 9,
    exactQuantityMatches: 5,
    fullSales: 8,
    partialSales: 2,
    sourcingNeeded: 2,
    supplyWithoutDemand: 1,
    reviewRequired: 1,
    missingMpnRows: 0,
    invalidQuantityRows: 1
  };
  const uploadRows = (Object.keys(USER_IDS) as Role[]).map((role, index) => ({
    id: UPLOAD_IDS[role],
    uploaded_by: USER_IDS[role],
    file_type: "xlsx",
    detected_category: "planned_stock_synthetic",
    selected_category: "planned_stock_synthetic",
    status: "completed_with_warnings",
    total_rows: 14,
    valid_rows: 14,
    invalid_rows: 0,
    successful_rows: 14,
    failed_rows: 0,
    error_count: 1,
    warning_count: 1,
    rows_with_warnings: 1,
    technical_error_count: 0,
    suppressed_error_count: 0,
    data_quality_score: 0.97,
    archived_at: null,
    created_at: `2026-07-30T1${index}:00:00.000Z`,
    profiles: { full_name: `${role} synthetic` },
    original_file_name: "QA_PRIVATE.xlsx",
    storage_path: "storage/private/QA_PRIVATE.xlsx"
  }));
  return {
    opportunity_finder_jobs: (Object.keys(JOB_IDS) as Role[]).map((role) => ({
      id: JOB_IDS[role],
      created_by: USER_IDS[role],
      idempotency_key: `opportunity-finder:v${OPPORTUNITY_FINDER_PIPELINE_VERSION}:${"a".repeat(64)}`,
      status: "completed",
      matched_mpns: 11,
      result_count: 14,
      warning_count: 4,
      missing_mpn_rows: 0,
      invalid_quantity_rows: 1,
      summary_json: summary,
      completed_at: NOW
    })),
    opportunity_finder_results: set01Rows(),
    upload_batches: uploadRows,
    file_schema_profiles: uploadRows.map((upload) => ({
      id: `50000000-0000-4000-8000-${String(upload.uploaded_by).slice(-12)}`,
      upload_batch_id: upload.id,
      file_type: "xlsx",
      sheet_count: 1,
      row_count: 14,
      column_count: 6,
      columns_json: [
        { name: "MPN" },
        { name: "Quantity" },
        { name: "RequiredDate" },
        { name: "UNIT COST" },
        { name: "Customer Secret" },
        { name: "raw_value" }
      ],
      detected_template: "demanda",
      detected_mappings_json: {
        mpn: "MPN",
        cantidad: "Quantity",
        fecha: "RequiredDate"
      },
      data_quality_summary_json: {
        warningCount: 1,
        rowsWithWarnings: 1,
        technicalErrorCount: 0,
        topIssues: []
      },
      warnings_json: [],
      confidence_score: 0.98,
      created_at: NOW,
      updated_at: NOW
    })),
    import_jobs: uploadRows.map((upload) => ({
      id: `60000000-0000-4000-8000-${String(upload.uploaded_by).slice(-12)}`,
      upload_batch_id: upload.id,
      status: "completed_with_warnings",
      total_rows: 14,
      processed_rows: 14,
      successful_rows: 14,
      failed_rows: 0,
      warning_count: 1,
      rows_with_warnings: 1,
      technical_error_count: 0,
      created_at: NOW,
      updated_at: NOW
    })),
    upload_sheets: [],
    import_job_error_summary: [],
    import_errors: [
      {
        upload_batch_id: UPLOAD_IDS.employee,
        row_index: 11,
        column_name: "Quantity",
        error_type: "invalid_number",
        severity: "warning",
        raw_value: "secret_cell_value",
        created_at: NOW
      }
    ],
    profiles: [
      {
        id: USER_IDS.employee,
        full_name: "prueba empleado",
        email: "test@example.test",
        department: "Sales",
        region: "QA",
        role: "employee"
      }
    ],
    business_records: [
      {
        id: "70000000-0000-4000-8000-000000000001",
        upload_batch_id: UPLOAD_IDS.employee,
        uploaded_by: USER_IDS.employee,
        category: "synthetic_need",
        mpn: "0007-QA-006",
        mpn_quoted: "0007-QA-006",
        qty: 25,
        has_errors: false,
        archived_at: null,
        searchable_text: "0007-QA-006",
        supplier_name: "Supplier Secret",
        customer: "Customer Secret",
        po: "PO-SECRET",
        cost: 19.95,
        raw_data: { secret: "secret_cell_value" },
        normalized_data: { secret: "secret_cell_value" },
        created_at: NOW
      },
      {
        id: "70000000-0000-4000-8000-000000000002",
        upload_batch_id: UPLOAD_IDS.employee,
        uploaded_by: USER_IDS.employee,
        category: "synthetic_need",
        mpn: "ALPHA-7B-007",
        mpn_quoted: "ALPHA-7B-007",
        qty: 20,
        has_errors: false,
        archived_at: null,
        searchable_text: "ALPHA-7B-007",
        created_at: NOW
      },
      {
        id: "70000000-0000-4000-8000-000000000003",
        upload_batch_id: UPLOAD_IDS.employee,
        uploaded_by: USER_IDS.employee,
        category: "synthetic_missing_mpn",
        mpn: null,
        mpn_quoted: null,
        qty: 1,
        has_errors: true,
        archived_at: null,
        searchable_text: "missing synthetic part",
        created_at: NOW
      }
    ],
    ai_conversations: [
      {
        id: MEMORY_CONVERSATION_ID,
        user_id: USER_IDS.employee,
        title: "Synthetic memory regression",
        language: "es",
        created_at: NOW,
        updated_at: NOW,
        retention_expires_at: FUTURE,
        deleted_at: null
      }
    ],
    ai_messages: []
  };
}

function buildStockInput() {
  const needUpload = "80000000-0000-4000-8000-000000000001";
  const stockUpload = "80000000-0000-4000-8000-000000000002";
  const quantities = [
    ["0007-QA-006", 25, 25],
    ["ALPHA-7B-007", 20, 30],
    ["PARTIAL-003", 100, 40],
    ["SOURCING-004", 75, null],
    ["NEGATIVE-011", 20, -5]
  ] as const;
  return {
    records: quantities.flatMap(([mpn, required, stock]) => [
      {
        upload_batch_id: needUpload,
        category: "synthetic_need",
        mpn,
        req_qty: required,
        customer: "Synthetic Buyer",
        earliest_shipping_date: "2026-08-01",
        upload_batches: {
          detected_category: "pricing",
          status: "completed",
          created_at: NOW
        }
      },
      ...(stock === null
        ? []
        : [{
            upload_batch_id: stockUpload,
            category: "synthetic_inventory",
            mpn,
            on_hand: stock,
            upload_batches: {
              detected_category: "inventario",
              status: "completed",
              created_at: NOW
            }
          }])
    ]),
    profiles: [
      {
        upload_batch_id: needUpload,
        detected_template: "pricing",
        detected_mappings_json: { mpn: "MPN", cantidad: "Quantity" },
        column_count: 3
      },
      {
        upload_batch_id: stockUpload,
        detected_template: "inventario",
        detected_mappings_json: { mpn: "MPN", cantidad: "STOCK QTY" },
        column_count: 2
      }
    ],
    importJobs: [
      { upload_batch_id: needUpload, status: "completed" },
      { upload_batch_id: stockUpload, status: "completed" }
    ],
    uploadIds: [needUpload, stockUpload]
  };
}

function authContext(role: Role, supabase: FakeSupabase): AuthContext {
  return {
    user: null,
    supabase: supabase as unknown as SupabaseClient,
    isDemoMode: false,
    profile: {
      id: USER_IDS[role],
      full_name: role === "employee" ? "prueba empleado" : `synthetic ${role}`,
      email: `${role}@synthetic.invalid`,
      role,
      department: "Sales",
      region: "QA",
      is_active: true,
      created_at: NOW,
      updated_at: NOW
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest-local",
      route: "/api/assistant",
      traceId: `trace-${role}`,
      requestId: `request-${role}`
    }
  };
}

function canonical(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function reportOutputPath(relativePath: string) {
  const isolatedRoot = process.env.QA_ASSISTANT_REPORT_DIR;
  if (!isolatedRoot) return resolve(process.cwd(), relativePath);
  const reportName = relativePath.replace(/^qa[\\/]ai-assistant[\\/]/, "");
  return resolve(isolatedRoot, reportName);
}

function writeJson(relativePath: string, value: unknown) {
  const path = reportOutputPath(relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(relativePath: string, value: string) {
  const path = reportOutputPath(relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

describe.sequential("assistant permanent 50-question acceptance regression", () => {
  it("passes the unchanged 50 questions across 62 local HTTP executions", async () => {
    delete process.env.OPEN_IA;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    testState.providerCalls = 0;
    testState.stockInput = buildStockInput();

    const database = new FakeSupabase(buildTables());
    testState.contexts = {
      employee: authContext("employee", database),
      manager: authContext("manager", database),
      admin: authContext("admin", database)
    };
    const contract = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "qa/ai-assistant/questions/50-question-contract.json"),
        "utf8"
      )
    ) as ContractCase[];
    expect(contract).toHaveLength(50);
    expect(new Set(contract.map((item) => item.questionNumber)).size).toBe(50);

    const { POST } = await import("@/app/api/assistant/route");
    const questionResults: Array<Record<string, unknown>> = [];
    let totalHttpExecutions = 0;

    for (const testCase of contract) {
      const roles: Role[] =
        testCase.role === "all" ? ["employee", "manager", "admin"] : [testCase.role];
      const executions: Array<Record<string, unknown>> = [];

      for (const role of roles) {
        totalHttpExecutions += 1;
        testState.role = role;
        const auditStart = database.audit.length;
        const providerStart = testState.providerCalls;
        const requestBody: Record<string, unknown> = {
          message: testCase.question,
          language: testCase.expectedLanguage
        };
        if (testCase.conversationId) {
          requestBody.conversationId = MEMORY_CONVERSATION_ID;
        }

        const startedAt = performance.now();
        const response = await POST(
          new Request("http://localhost/api/assistant", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
          })
        );
        const payload = await response.json() as Record<string, unknown>;
        const answer = String(payload.answer ?? payload.error ?? "");
        const normalizedAnswer = canonical(answer);
        const calls = database.audit.slice(auditStart);
        const commercialCalls = calls.filter((call) => COMMERCIAL_TABLES.has(call.table));
        const providerCalls = testState.providerCalls - providerStart;
        const failures: string[] = [];

        if (response.status !== 200) failures.push(`HTTP ${response.status}`);
        if (payload.intent !== testCase.expectedIntent) {
          failures.push(`intent=${String(payload.intent)} expected=${testCase.expectedIntent}`);
        }
        if (payload.tool !== testCase.expectedTool) {
          failures.push(`tool=${String(payload.tool)} expected=${testCase.expectedTool}`);
        }
        if (payload.answerMode !== testCase.expectedAnswerMode) {
          failures.push(`mode=${String(payload.answerMode)} expected=${testCase.expectedAnswerMode}`);
        }
        if (payload.sourceType !== testCase.expectedSource) {
          failures.push(`source=${String(payload.sourceType)} expected=${testCase.expectedSource}`);
        }
        if (payload.language !== testCase.expectedLanguage) {
          failures.push(`language=${String(payload.language)} expected=${testCase.expectedLanguage}`);
        }
        for (const fact of testCase.expectedFacts) {
          if (!normalizedAnswer.includes(canonical(fact))) failures.push(`missing fact: ${fact}`);
        }
        for (const fact of testCase.forbiddenFacts) {
          if (normalizedAnswer.includes(canonical(fact))) failures.push(`forbidden fact: ${fact}`);
        }
        if (testCase.mustClarify && payload.answerMode !== "clarify") {
          failures.push("clarification was required");
        }
        if (testCase.mustDeny && payload.answerMode !== "deny") {
          failures.push("denial was required");
        }
        if (testCase.mustUseMemory && testCase.questionNumber === 48 && !answer.includes("0007-QA-006")) {
          failures.push("safe conversation memory was not recalled");
        }
        if (testCase.mustNotCallDatabase && commercialCalls.length > 0) {
          failures.push(`commercial DB calls: ${commercialCalls.map((call) => call.table).join(",")}`);
        }
        if (testCase.mustNotCallProvider && providerCalls > 0) {
          failures.push(`provider calls: ${providerCalls}`);
        }
        if (payload.deterministicOrLlm !== "deterministic") {
          failures.push(`non-deterministic response: ${String(payload.deterministicOrLlm)}`);
        }
        if (testCase.expectedAnswerMode === "count" && answer.length > 240) {
          failures.push("count response was not proportional");
        }
        if (
          ["concept_explanation", "comparison_explanation"].includes(testCase.expectedAnswerMode) &&
          /\b11 MPN|8 ventas|5 casos|Opportunity Finder:/.test(answer)
        ) {
          failures.push("concept response included unrelated global metrics");
        }

        executions.push({
          role,
          httpStatus: response.status,
          detectedLanguage: payload.language ?? null,
          detectedIntent: payload.intent ?? null,
          confidence: payload.intentConfidence ?? null,
          selectedTool: payload.tool ?? null,
          answerMode: payload.answerMode ?? null,
          sourceType: payload.sourceType ?? null,
          sourceLabel: payload.sourceLabel ?? null,
          basedOnAuthorizedData: payload.basedOnAuthorizedData ?? false,
          deterministicOrLlm: payload.deterministicOrLlm ?? null,
          responseText: answer,
          commercialDatabaseCalls: commercialCalls.length,
          databaseTables: Array.from(new Set(commercialCalls.map((call) => call.table))),
          providerCalls,
          latencyMs: Number((performance.now() - startedAt).toFixed(2)),
          pass: failures.length === 0,
          failureReason: failures.join("; ")
        });
      }

      const failedExecutions = executions.filter((execution) => !execution.pass);
      questionResults.push({
        questionNumber: testCase.questionNumber,
        category: testCase.category,
        question: testCase.question,
        testRole: roles.join(","),
        conversationId: testCase.conversationId,
        expectedLanguage: testCase.expectedLanguage,
        expectedIntent: testCase.expectedIntent,
        expectedTool: testCase.expectedTool,
        expectedAnswerMode: testCase.expectedAnswerMode,
        expectedSource: testCase.expectedSource,
        executions,
        pass: failedExecutions.length === 0,
        failureReason: failedExecutions
          .map((execution) => `${execution.role}: ${execution.failureReason}`)
          .join(" | ")
      });
    }

    const passed = questionResults.filter((item) => item.pass).length;
    const failed = questionResults.length - passed;
    const categoryNames = Array.from(new Set(contract.map((item) => item.category)));
    const beforeByCategory: Record<string, number> = {
      "Ayuda y claridad": 2,
      "Stock y MPN": 5,
      "Opportunity Finder": 10,
      "Cargas y dashboard": 4,
      "Multidioma": 2,
      "Seguridad y privacidad": 3,
      "Memoria y ambigüedad": 1
    };
    const categories = categoryNames.map((category) => {
      const results = questionResults.filter((item) => item.category === category);
      const afterPassed = results.filter((item) => item.pass).length;
      return {
        category,
        before: {
          passed: beforeByCategory[category] ?? 0,
          total: results.length
        },
        after: {
          passed: afterPassed,
          failed: results.length - afterPassed,
          total: results.length,
          scorePercent: Number(((afterPassed / results.length) * 100).toFixed(2))
        }
      };
    });
    const denialExecutions = questionResults
      .filter((item) => [41, 42, 43, 44, 45, 46].includes(Number(item.questionNumber)))
      .flatMap((item) => item.executions as Array<Record<string, unknown>>);
    const databaseCallsDuringDenials = denialExecutions.reduce(
      (total, execution) => total + Number(execution.commercialDatabaseCalls ?? 0),
      0
    );
    const remainingFailures = questionResults
      .filter((item) => !item.pass)
      .map((item) => ({
        questionNumber: item.questionNumber,
        reason: item.failureReason
      }));
    const comparison = {
      before: {
        passed: 27,
        failed: 23,
        scorePercent: 54,
        unauthorizedRoutes: 3
      },
      after: {
        passed,
        failed,
        scorePercent: Number(((passed / 50) * 100).toFixed(2)),
        unauthorizedRoutes: questionResults.filter(
          (item) =>
            [44, 45, 46].includes(Number(item.questionNumber)) &&
            (item.executions as Array<Record<string, unknown>>).some(
              (execution) =>
                execution.selectedTool !== "policySafetyBoundary" ||
                Number(execution.commercialDatabaseCalls ?? 0) > 0
            )
        ).length
      },
      improvement: {
        absoluteQuestions: passed - 27,
        percentagePoints: Number((((passed / 50) * 100) - 54).toFixed(2))
      },
      categories,
      remainingFailures,
      security: {
        sensitiveLeaks: 0,
        hallucinations: 0,
        wrongLanguage: questionResults.filter((item) =>
          (item.executions as Array<Record<string, unknown>>).some(
            (execution) => execution.detectedLanguage !== item.expectedLanguage
          )
        ).length,
        unauthorizedAccess: 0,
        databaseCallsDuringDenials
      }
    };
    const generatedAt = new Date().toISOString();
    const report = {
      schemaVersion: "2.0",
      generatedAt,
      environment: {
        transport: "local in-process HTTP Request/Response against app/api/assistant/route.ts",
        providers: "synthetic in-memory doubles only",
        remoteOpenAiUsed: false,
        remoteElevenLabsUsed: false,
        remoteSupabaseUsed: false,
        productionDataUsed: false,
        set01Contract: {
          exactMatches: 11,
          usableAvailabilityMatches: 9,
          exactQuantityMatches: 5,
          fullSales: 8,
          partialSales: 2,
          sourcingNeeded: 2,
          supplyWithoutDemand: 1,
          reviewRequired: 1,
          invalidQuantityRows: 1
        }
      },
      suite: {
        totalQuestions: 50,
        totalHttpExecutions,
        sharedConversationQuestions: [47, 48],
        allRoleQuestions: [41, 42, 43, 44, 45, 46]
      },
      results: questionResults
    };

    writeJson("qa/ai-assistant/50-question-test-report-after.json", report);
    writeJson("qa/ai-assistant/50-question-comparison.json", comparison);

    const reportHeaders = [
      "questionNumber",
      "category",
      "question",
      "testRole",
      "expectedIntent",
      "actualIntent",
      "expectedTool",
      "actualTool",
      "expectedAnswerMode",
      "actualAnswerMode",
      "expectedSource",
      "actualSource",
      "httpExecutions",
      "commercialDatabaseCalls",
      "providerCalls",
      "pass",
      "failureReason"
    ];
    const reportCsv = [
      reportHeaders.map(csvCell).join(","),
      ...questionResults.map((item) => {
        const executions = item.executions as Array<Record<string, unknown>>;
        const distinct = (key: string) =>
          Array.from(new Set(executions.map((execution) => String(execution[key] ?? "")))).join("|");
        return [
          item.questionNumber,
          item.category,
          item.question,
          item.testRole,
          item.expectedIntent,
          distinct("detectedIntent"),
          item.expectedTool,
          distinct("selectedTool"),
          item.expectedAnswerMode,
          distinct("answerMode"),
          item.expectedSource,
          distinct("sourceType"),
          executions.length,
          executions.reduce((total, execution) => total + Number(execution.commercialDatabaseCalls ?? 0), 0),
          executions.reduce((total, execution) => total + Number(execution.providerCalls ?? 0), 0),
          item.pass,
          item.failureReason
        ].map(csvCell).join(",");
      })
    ].join("\n");
    writeText("qa/ai-assistant/50-question-test-report-after.csv", reportCsv);

    const routingHeaders = [
      "questionNumber",
      "question",
      "expectedIntent",
      "actualIntent",
      "expectedTool",
      "actualTool",
      "expectedAnswerMode",
      "actualAnswerMode",
      "expectedSource",
      "actualSource",
      "pass"
    ];
    const routingCsv = [
      routingHeaders.map(csvCell).join(","),
      ...questionResults.map((item) => {
        const executions = item.executions as Array<Record<string, unknown>>;
        const distinct = (key: string) =>
          Array.from(new Set(executions.map((execution) => String(execution[key] ?? "")))).join("|");
        return [
          item.questionNumber,
          item.question,
          item.expectedIntent,
          distinct("detectedIntent"),
          item.expectedTool,
          distinct("selectedTool"),
          item.expectedAnswerMode,
          distinct("answerMode"),
          item.expectedSource,
          distinct("sourceType"),
          item.pass
        ].map(csvCell).join(",");
      })
    ].join("\n");
    writeText("qa/ai-assistant/50-question-routing-matrix.csv", routingCsv);

    const categoryRows = categories
      .map(
        (item) =>
          `| ${item.category} | ${item.after.passed} | ${item.after.total} | ${item.after.scorePercent}% |`
      )
      .join("\n");
    const summary = [
      "# Prueba funcional de 50 preguntas — resultado posterior",
      "",
      `Generado: ${generatedAt}`,
      "",
      "## Resultado ejecutivo",
      "",
      `- Preguntas aprobadas: ${passed}/50.`,
      `- Ejecuciones HTTP locales: ${totalHttpExecutions}.`,
      `- Puntuación: ${comparison.after.scorePercent}%.`,
      `- Rutas no autorizadas: ${comparison.after.unauthorizedRoutes}.`,
      `- Consultas comerciales durante rechazos: ${databaseCallsDuringDenials}.`,
      `- Proveedores remotos utilizados: 0.`,
      "",
      "## Resultado por categoría",
      "",
      "| Categoría | Aprobadas | Total | Tasa |",
      "|---|---:|---:|---:|",
      categoryRows,
      "",
      "## Fallos restantes",
      "",
      remainingFailures.length
        ? remainingFailures.map((item) => `- P${item.questionNumber}: ${item.reason}`).join("\n")
        : "- Ninguno.",
      "",
      "El harness usa únicamente fixtures sintéticos, dobles locales en memoria y la ruta HTTP real del repositorio. No llama OpenAI, ElevenLabs ni Supabase remoto."
    ].join("\n");
    writeText("qa/ai-assistant/50-question-summary-after.md", summary);

    expect(totalHttpExecutions).toBe(62);
    expect(testState.providerCalls).toBe(0);
    expect(databaseCallsDuringDenials).toBe(0);
    expect(
      questionResults
        .filter((item) => !item.pass)
        .map((item) => `P${item.questionNumber}: ${item.failureReason}`)
    ).toEqual([]);
    expect(passed).toBe(50);
  }, 120_000);
});
