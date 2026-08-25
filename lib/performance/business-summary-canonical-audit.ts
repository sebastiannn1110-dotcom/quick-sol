import { createHash } from "node:crypto";
import {
  buildBusinessMpnSummaryRows,
  buildBusinessOpportunityEntityRows,
  type BusinessMpnSummaryRow,
  type BusinessOpportunityEntityRow
} from "@/lib/performance/business-summaries";
import type { StockNeedsRecord } from "@/lib/stock-needs/stock-needs";

export const R7_CANONICAL_AUDIT_SEED = "quiksol-r7-canonical-v1";
export const R7_CANONICAL_EVALUATION_AT = "2026-08-25T12:00:00.000Z";
export const R7_CANONICAL_UPLOAD_ID = "7c000000-0000-4000-8000-000000000010";

const SUMMARY_DECIMAL_FIELDS = [
  "demand_qty",
  "stock_qty",
  "excess_qty",
  "received_qty",
  "stock_required_qty",
  "stock_available_qty"
] as const;
const ENTITY_DECIMAL_FIELDS = [
  "required_qty",
  "available_qty",
  "excess_qty",
  "lead_time_weeks",
  "moq",
  "spq"
] as const;

type SummaryDecimalField = typeof SUMMARY_DECIMAL_FIELDS[number];
type EntityDecimalField = typeof ENTITY_DECIMAL_FIELDS[number];
type DecimalLike = string | number | bigint | null;
type ExactDecimal = { coefficient: bigint; scale: number };
type AuditSummaryRow = Omit<BusinessMpnSummaryRow, SummaryDecimalField> & Record<SummaryDecimalField, string | null>;
type AuditEntityRow = Omit<BusinessOpportunityEntityRow, EntityDecimalField> & Record<EntityDecimalField, string | null>;

export type CanonicalDifference = {
  field: string;
  type: "decimal" | "non_decimal" | "row" | "key" | "warning" | "count";
  before: unknown;
  after: unknown;
  expected: unknown;
  cause: string;
  classification: "EXPECTED_DECIMAL_CORRECTION" | "UNEXPECTED_DIFFERENCE";
};

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_TEN = BigInt(10);

function pow10(power: number) {
  if (!Number.isSafeInteger(power) || power < 0) throw new Error("DECIMAL_SCALE_INVALID");
  return BIGINT_TEN ** BigInt(power);
}

function normalizeExactDecimal(value: ExactDecimal): ExactDecimal {
  let { coefficient, scale } = value;
  if (coefficient === BIGINT_ZERO) return { coefficient: BIGINT_ZERO, scale: 0 };
  while (scale > 0 && coefficient % BIGINT_TEN === BIGINT_ZERO) {
    coefficient /= BIGINT_TEN;
    scale -= 1;
  }
  return { coefficient, scale };
}

export function parseExactDecimal(value: Exclude<DecimalLike, null>): ExactDecimal {
  const text = String(value).trim();
  const match = text.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new Error(`DECIMAL_INVALID:${text}`);
  const sign = match[1] === "-" ? -BIGINT_ONE : BIGINT_ONE;
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(exponent)) throw new Error("DECIMAL_EXPONENT_INVALID");
  let coefficient = BigInt(`${integer}${fraction}` || "0") * sign;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= pow10(-scale);
    scale = 0;
  }
  return normalizeExactDecimal({ coefficient, scale });
}

function addExactDecimals(left: ExactDecimal | null, right: ExactDecimal): ExactDecimal {
  if (!left) return right;
  const scale = Math.max(left.scale, right.scale);
  return normalizeExactDecimal({
    coefficient: left.coefficient * pow10(scale - left.scale)
      + right.coefficient * pow10(scale - right.scale),
    scale
  });
}

export function formatExactDecimal(value: ExactDecimal): string {
  const normalized = normalizeExactDecimal(value);
  if (normalized.coefficient === BIGINT_ZERO) return "0";
  const negative = normalized.coefficient < BIGINT_ZERO;
  const digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  if (normalized.scale === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(normalized.scale + 1, "0");
  const split = padded.length - normalized.scale;
  return `${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`;
}

export function canonicalDecimal(value: DecimalLike): string | null {
  return value === null ? null : formatExactDecimal(parseExactDecimal(value));
}

export function sumCanonicalDecimals(values: Array<Exclude<DecimalLike, null>>): string {
  const total = values.reduce<ExactDecimal | null>(
    (sum, value) => addExactDecimals(sum, parseExactDecimal(value)),
    null
  );
  return formatExactDecimal(total ?? { coefficient: BIGINT_ZERO, scale: 0 });
}

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CANONICAL_NUMBER_INVALID");
    return value;
  }
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  throw new Error("CANONICAL_VALUE_UNSUPPORTED");
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sourceId(index: number) {
  return `7c000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function seededNumber(seed: string) {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export type CanonicalAuditFixture = {
  seed: string;
  evaluationAt: string;
  records: StockNeedsRecord[];
  decimalByRecord: Map<string, string>;
};

export function buildCanonicalAuditFixture(rowCount = 10_000): CanonicalAuditFixture {
  if (!Number.isSafeInteger(rowCount) || rowCount < 1) throw new Error("AUDIT_ROW_COUNT_INVALID");
  const seedValue = seededNumber(R7_CANONICAL_AUDIT_SEED);
  const quantities = ["0.2", "1.2300", "2", "17.500", "99999.0001", "0.0009", "3.1415"];
  const decimalByRecord = new Map<string, string>();
  const records = Array.from({ length: rowCount }, (_, index) => {
    const id = sourceId(index);
    const fractionCase = index < Math.min(1000, rowCount);
    const quantity = fractionCase ? "0.1" : quantities[(index + seedValue) % quantities.length];
    const group = fractionCase ? "FRACTION" : String((index + seedValue) % 11).padStart(2, "0");
    decimalByRecord.set(id, quantity);
    return {
      id,
      upload_batch_id: R7_CANONICAL_UPLOAD_ID,
      created_at: new Date(Date.parse(R7_CANONICAL_EVALUATION_AT) - index * 1000).toISOString(),
      raw_data: {
        MPN: `R7-CANON-${group}`,
        "Required Qty": quantity,
        "Required Date": "2026-09-30",
        Customer: `Synthetic Customer ${(index + seedValue) % 5}`,
        Manufacturer: `Synthetic Maker ${Math.floor(index / 11) % 2}`,
        UOM: "EA"
      },
      normalized_data: {},
      mpn: `R7-CANON-${group}`,
      req_qty: Number(quantity),
      upload_batches: {
        id: R7_CANONICAL_UPLOAD_ID,
        original_file_name: "r7-canonical-synthetic.xlsx",
        detected_category: "pricing",
        status: "completed",
        created_at: R7_CANONICAL_EVALUATION_AT
      }
    } as StockNeedsRecord;
  });
  return {
    seed: R7_CANONICAL_AUDIT_SEED,
    evaluationAt: R7_CANONICAL_EVALUATION_AT,
    records,
    decimalByRecord
  };
}

function summaryKey(row: Pick<BusinessMpnSummaryRow, "normalized_mpn">) {
  return row.normalized_mpn;
}

function entityKey(row: Pick<BusinessOpportunityEntityRow, "source_record_id" | "entity_kind" | "entity_key">) {
  return `${row.source_record_id}\u0000${row.entity_kind}\u0000${row.entity_key}`;
}

function canonicalSummaryRow(row: BusinessMpnSummaryRow | AuditSummaryRow) {
  const canonical = { ...row } as Record<string, unknown>;
  for (const field of SUMMARY_DECIMAL_FIELDS) canonical[field] = canonicalDecimal(row[field]);
  return canonical as unknown as AuditSummaryRow;
}

function canonicalEntityRow(row: BusinessOpportunityEntityRow | AuditEntityRow) {
  const canonical = { ...row } as Record<string, unknown>;
  for (const field of ENTITY_DECIMAL_FIELDS) canonical[field] = canonicalDecimal(row[field]);
  return canonical as unknown as AuditEntityRow;
}

function aggregateAfterRows(fixture: CanonicalAuditFixture, chunkSize: number) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("AUDIT_CHUNK_SIZE_INVALID");
  const grouped = new Map<string, {
    row: AuditSummaryRow;
    decimalTotals: Record<SummaryDecimalField, ExactDecimal | null>;
    oracleTotals: Record<SummaryDecimalField, ExactDecimal | null>;
    manufacturers: Set<string>;
    warnings: Set<string>;
  }>();
  const entities: AuditEntityRow[] = [];
  const oracleEntities: AuditEntityRow[] = [];

  fixture.records.forEach((record, sourceIndex) => {
    // These are precisely the per-source partials staged by R7. Chunk position
    // affects fencing/cursors, never the canonical business ordering.
    void Math.floor(sourceIndex / chunkSize);
    const [partial] = buildBusinessMpnSummaryRows({ records: [record] });
    if (!partial) throw new Error("AUDIT_SUMMARY_PARTIAL_MISSING");
    const key = summaryKey(partial);
    let aggregate = grouped.get(key);
    if (!aggregate) {
      const row = canonicalSummaryRow(partial);
      row.source_record_count = 0;
      const decimalTotals = Object.fromEntries(SUMMARY_DECIMAL_FIELDS.map((field) => [field, null])) as Record<SummaryDecimalField, ExactDecimal | null>;
      const oracleTotals = Object.fromEntries(SUMMARY_DECIMAL_FIELDS.map((field) => [field, null])) as Record<SummaryDecimalField, ExactDecimal | null>;
      aggregate = { row, decimalTotals, oracleTotals, manufacturers: new Set(), warnings: new Set() };
      grouped.set(key, aggregate);
    }
    for (const field of [
      "display_mpn", "customer_name", "supplier_name", "manufacturer_name",
      "stock_customer_name", "stock_supplier_name", "stock_manufacturer_name",
      "required_date", "lead_time", "unit_of_measure"
    ] as const) {
      if (aggregate.row[field] === null && partial[field] !== null) {
        (aggregate.row as unknown as Record<string, unknown>)[field] = partial[field];
      }
    }
    const originalDecimal = fixture.decimalByRecord.get(String(record.id));
    if (!originalDecimal) throw new Error("AUDIT_SOURCE_DECIMAL_MISSING");
    for (const field of SUMMARY_DECIMAL_FIELDS) {
      if (partial[field] === null) continue;
      aggregate.decimalTotals[field] = addExactDecimals(
        aggregate.decimalTotals[field],
        parseExactDecimal(partial[field])
      );
      aggregate.oracleTotals[field] = addExactDecimals(
        aggregate.oracleTotals[field],
        parseExactDecimal(originalDecimal)
      );
    }
    aggregate.row.approved_part_signal ||= partial.approved_part_signal;
    aggregate.row.received_signal ||= partial.received_signal;
    aggregate.row.source_record_count += partial.source_record_count;
    for (const manufacturer of partial.manufacturer_names) aggregate.manufacturers.add(manufacturer);
    for (const warning of partial.warnings) {
      if (warning && warning !== "manufacturer_context_mixed") aggregate.warnings.add(warning);
    }

    const sourceEntities = buildBusinessOpportunityEntityRows({
      records: [record],
      evaluationAt: fixture.evaluationAt
    }).map(canonicalEntityRow);
    for (const entity of sourceEntities) {
      entities.push(entity);
      const expected = { ...entity } as AuditEntityRow;
      for (const field of ENTITY_DECIMAL_FIELDS) {
        if (expected[field] !== null && ["required_qty", "available_qty", "excess_qty"].includes(field)) {
          expected[field] = canonicalDecimal(originalDecimal);
        }
      }
      oracleEntities.push(expected);
    }
  });

  const summaries: AuditSummaryRow[] = [];
  const oracleSummaries: AuditSummaryRow[] = [];
  for (const aggregate of grouped.values()) {
    const row = { ...aggregate.row, manufacturer_names: [...aggregate.manufacturers] } as AuditSummaryRow;
    const oracle = { ...row } as AuditSummaryRow;
    for (const field of SUMMARY_DECIMAL_FIELDS) {
      row[field] = aggregate.decimalTotals[field] ? formatExactDecimal(aggregate.decimalTotals[field]!) : null;
      oracle[field] = aggregate.oracleTotals[field] ? formatExactDecimal(aggregate.oracleTotals[field]!) : null;
    }
    row.warnings = [...aggregate.warnings];
    if (row.manufacturer_names.length > 1) row.warnings.push("manufacturer_context_mixed");
    oracle.warnings = [...row.warnings];
    summaries.push(row);
    oracleSummaries.push(oracle);
  }
  summaries.sort((left, right) => summaryKey(left).localeCompare(summaryKey(right)));
  oracleSummaries.sort((left, right) => summaryKey(left).localeCompare(summaryKey(right)));
  entities.sort((left, right) => entityKey(left).localeCompare(entityKey(right)));
  oracleEntities.sort((left, right) => entityKey(left).localeCompare(entityKey(right)));
  return { summaries, oracleSummaries, entities, oracleEntities };
}

function omitFields(row: Record<string, unknown>, fields: readonly string[]) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
}

function decimalProjection<T extends Record<string, unknown>>(
  rows: T[],
  key: (row: T) => string,
  fields: readonly string[]
) {
  return rows.flatMap((row) => fields.map((field) => ({ key: key(row), field, value: row[field] })));
}

function compareRows(
  scope: "summary" | "entity",
  beforeRows: Array<Record<string, unknown>>,
  afterRows: Array<Record<string, unknown>>,
  oracleRows: Array<Record<string, unknown>>,
  keyOf: (row: Record<string, unknown>) => string,
  decimalFields: readonly string[]
) {
  const differences: CanonicalDifference[] = [];
  let identical = 0;
  const beforeByKey = new Map(beforeRows.map((row) => [keyOf(row), row]));
  const afterByKey = new Map(afterRows.map((row) => [keyOf(row), row]));
  const oracleByKey = new Map(oracleRows.map((row) => [keyOf(row), row]));
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys(), ...oracleByKey.keys()])].sort();
  for (const key of keys) {
    const before = beforeByKey.get(key);
    const after = afterByKey.get(key);
    const oracle = oracleByKey.get(key);
    if (!before || !after || !oracle) {
      differences.push({
        field: `${scope}:${key}`,
        type: "row",
        before: Boolean(before), after: Boolean(after), expected: Boolean(oracle),
        cause: "ROW_SET_MISMATCH", classification: "UNEXPECTED_DIFFERENCE"
      });
      continue;
    }
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(oracle)])].sort();
    for (const field of fields) {
      const beforeValue = before[field];
      const afterValue = after[field];
      const expectedValue = oracle[field];
      if (decimalFields.includes(field)) {
        const beforeDecimal = canonicalDecimal(beforeValue as DecimalLike);
        const afterDecimal = canonicalDecimal(afterValue as DecimalLike);
        const expectedDecimal = canonicalDecimal(expectedValue as DecimalLike);
        if (afterDecimal !== expectedDecimal) {
          differences.push({
            field: `${scope}:${key}.${field}`, type: "decimal",
            before: beforeDecimal, after: afterDecimal, expected: expectedDecimal,
            cause: "AFTER_DECIMAL_ORACLE_MISMATCH", classification: "UNEXPECTED_DIFFERENCE"
          });
        } else if (beforeDecimal !== afterDecimal) {
          differences.push({
            field: `${scope}:${key}.${field}`, type: "decimal",
            before: beforeDecimal, after: afterDecimal, expected: expectedDecimal,
            cause: "LEGACY_IEEE754_ACCUMULATION", classification: "EXPECTED_DECIMAL_CORRECTION"
          });
        } else {
          identical += 1;
        }
      } else if (canonicalJson(beforeValue) !== canonicalJson(afterValue)
        || canonicalJson(afterValue) !== canonicalJson(expectedValue)) {
        differences.push({
          field: `${scope}:${key}.${field}`,
          type: field === "warnings" ? "warning" : "non_decimal",
          before: beforeValue, after: afterValue, expected: expectedValue,
          cause: "NON_DECIMAL_VALUE_MISMATCH", classification: "UNEXPECTED_DIFFERENCE"
        });
      } else {
        identical += 1;
      }
    }
  }
  return { differences, identical };
}

export function runCanonicalBusinessSummaryAudit(rowCount = 10_000, chunkSize = 500) {
  const fixture = buildCanonicalAuditFixture(rowCount);
  // This full-universe call is the legacy BEFORE behavior recovered from
  // 61b9fcb:lib/performance/business-summaries.ts. It is audit-only.
  const beforeSummaries = buildBusinessMpnSummaryRows({ records: fixture.records })
    .map(canonicalSummaryRow)
    .sort((left, right) => summaryKey(left).localeCompare(summaryKey(right)));
  const beforeEntities = buildBusinessOpportunityEntityRows({
    records: fixture.records,
    evaluationAt: fixture.evaluationAt
  }).map(canonicalEntityRow).sort((left, right) => entityKey(left).localeCompare(entityKey(right)));
  const after = aggregateAfterRows(fixture, chunkSize);
  const summaryComparison = compareRows(
    "summary",
    beforeSummaries as unknown as Array<Record<string, unknown>>,
    after.summaries as unknown as Array<Record<string, unknown>>,
    after.oracleSummaries as unknown as Array<Record<string, unknown>>,
    (row) => String(row.normalized_mpn),
    SUMMARY_DECIMAL_FIELDS
  );
  const entityComparison = compareRows(
    "entity",
    beforeEntities as unknown as Array<Record<string, unknown>>,
    after.entities as unknown as Array<Record<string, unknown>>,
    after.oracleEntities as unknown as Array<Record<string, unknown>>,
    (row) => `${row.source_record_id}\u0000${row.entity_kind}\u0000${row.entity_key}`,
    ENTITY_DECIMAL_FIELDS
  );
  const differences = [...summaryComparison.differences, ...entityComparison.differences];
  const nonDecimalBefore = {
    summaries: beforeSummaries.map((row) => omitFields(row as unknown as Record<string, unknown>, SUMMARY_DECIMAL_FIELDS)),
    entities: beforeEntities.map((row) => omitFields(row as unknown as Record<string, unknown>, ENTITY_DECIMAL_FIELDS))
  };
  const nonDecimalAfter = {
    summaries: after.summaries.map((row) => omitFields(row as unknown as Record<string, unknown>, SUMMARY_DECIMAL_FIELDS)),
    entities: after.entities.map((row) => omitFields(row as unknown as Record<string, unknown>, ENTITY_DECIMAL_FIELDS))
  };
  const decimalBefore = {
    summaries: decimalProjection(beforeSummaries as unknown as Array<Record<string, unknown>>, (row) => String(row.normalized_mpn), SUMMARY_DECIMAL_FIELDS),
    entities: decimalProjection(beforeEntities as unknown as Array<Record<string, unknown>>, (row) => `${row.source_record_id}\u0000${row.entity_kind}\u0000${row.entity_key}`, ENTITY_DECIMAL_FIELDS)
  };
  const decimalAfter = {
    summaries: decimalProjection(after.summaries as unknown as Array<Record<string, unknown>>, (row) => String(row.normalized_mpn), SUMMARY_DECIMAL_FIELDS),
    entities: decimalProjection(after.entities as unknown as Array<Record<string, unknown>>, (row) => `${row.source_record_id}\u0000${row.entity_kind}\u0000${row.entity_key}`, ENTITY_DECIMAL_FIELDS)
  };
  const decimalOracle = {
    summaries: decimalProjection(after.oracleSummaries as unknown as Array<Record<string, unknown>>, (row) => String(row.normalized_mpn), SUMMARY_DECIMAL_FIELDS),
    entities: decimalProjection(after.oracleEntities as unknown as Array<Record<string, unknown>>, (row) => `${row.source_record_id}\u0000${row.entity_kind}\u0000${row.entity_key}`, ENTITY_DECIMAL_FIELDS)
  };
  const warningsBefore = {
    summaries: beforeSummaries.map((row) => ({ key: summaryKey(row), warnings: row.warnings })),
    entities: beforeEntities.map((row) => ({ key: entityKey(row), warnings: row.warnings }))
  };
  const warningsAfter = {
    summaries: after.summaries.map((row) => ({ key: summaryKey(row), warnings: row.warnings })),
    entities: after.entities.map((row) => ({ key: entityKey(row), warnings: row.warnings }))
  };
  const countsBefore = { summaryRows: beforeSummaries.length, entityRows: beforeEntities.length };
  const countsAfter = { summaryRows: after.summaries.length, entityRows: after.entities.length };
  return {
    fixture: {
      seed: fixture.seed,
      evaluationAt: fixture.evaluationAt,
      rows: fixture.records.length,
      uploadId: R7_CANONICAL_UPLOAD_ID,
      dataVersion: 7,
      logicalStatus: "ready"
    },
    businessKeys: {
      summary: ["normalized_mpn"],
      entity: ["source_record_id", "entity_kind", "entity_key"]
    },
    excludedFields: [] as string[],
    countsBefore,
    countsAfter,
    classifications: {
      IDENTICAL: summaryComparison.identical + entityComparison.identical,
      EXPECTED_DECIMAL_CORRECTION: differences.filter((item) => item.classification === "EXPECTED_DECIMAL_CORRECTION").length,
      NONDETERMINISTIC_FIELD_EXCLUDED: 0,
      UNEXPECTED_DIFFERENCE: differences.filter((item) => item.classification === "UNEXPECTED_DIFFERENCE").length
    },
    differences,
    hashes: {
      rawBeforeSummary: createHash("sha256").update(JSON.stringify(beforeSummaries), "utf8").digest("hex"),
      rawBeforeEntity: createHash("sha256").update(JSON.stringify(beforeEntities), "utf8").digest("hex"),
      rawAfterSummary: createHash("sha256").update(JSON.stringify(after.summaries), "utf8").digest("hex"),
      rawAfterEntity: createHash("sha256").update(JSON.stringify(after.entities), "utf8").digest("hex"),
      canonicalNonDecimalBefore: canonicalSha256(nonDecimalBefore),
      canonicalNonDecimalAfter: canonicalSha256(nonDecimalAfter),
      canonicalDecimalBefore: canonicalSha256(decimalBefore),
      canonicalDecimalAfter: canonicalSha256(decimalAfter),
      canonicalDecimalOracle: canonicalSha256(decimalOracle),
      canonicalWarningsBefore: canonicalSha256(warningsBefore),
      canonicalWarningsAfter: canonicalSha256(warningsAfter),
      canonicalCountsBefore: canonicalSha256(countsBefore),
      canonicalCountsAfter: canonicalSha256(countsAfter),
      canonicalSummaryBefore: canonicalSha256(beforeSummaries),
      canonicalSummaryAfter: canonicalSha256(after.summaries),
      canonicalSummaryOracle: canonicalSha256(after.oracleSummaries),
      canonicalEntityBefore: canonicalSha256(beforeEntities),
      canonicalEntityAfter: canonicalSha256(after.entities),
      canonicalEntityOracle: canonicalSha256(after.oracleEntities),
      canonicalFullBefore: canonicalSha256({ summaries: beforeSummaries, entities: beforeEntities }),
      canonicalFullAfter: canonicalSha256({ summaries: after.summaries, entities: after.entities })
    }
  };
}
