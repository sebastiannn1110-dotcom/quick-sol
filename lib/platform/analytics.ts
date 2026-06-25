import type {
  AnalyticsModule,
  MetricItem,
  PlatformAnalyticsSummary,
  PlatformRecord,
  Profile,
  UploadBatch
} from "@/lib/types";

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[%,$]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sum(records: PlatformRecord[], key: keyof PlatformRecord) {
  return Number(records.reduce((total, record) => total + numberValue(record[key]), 0).toFixed(2));
}

function average(records: PlatformRecord[], key: keyof PlatformRecord) {
  const values = records.map((record) => numberValue(record[key])).filter((value) => value !== 0);
  if (!values.length) return 0;
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(4));
}

function groupCount(values: Array<string | null | undefined>, emptyLabel = "Unspecified"): MetricItem[] {
  const counts = values.reduce<Record<string, number>>((acc, value) => {
    const label = value?.trim() || emptyLabel;
    acc[label] = (acc[label] ?? 0) + 1;
    return acc;
  }, {});
  const total = Object.values(counts).reduce((sumValue, value) => sumValue + value, 0) || 1;

  return Object.entries(counts)
    .map(([label, value]) => ({
      label,
      value,
      percent: Math.round((value / total) * 100)
    }))
    .sort((a, b) => b.value - a.value);
}

function hasValue(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

function mpnValue(record: PlatformRecord) {
  return record.mpn?.trim() || record.mpn_quoted?.trim() || null;
}

function groupMpns(records: PlatformRecord[]): MetricItem[] {
  const realMpns = groupCount(records.map(mpnValue).filter(Boolean) as string[]);
  const missingCount = records.filter((record) => !mpnValue(record)).length;
  return missingCount ? [...realMpns, { label: "Missing MPN", value: missingCount }] : realMpns;
}

function moduleFor(records: PlatformRecord[], stats: MetricItem[], groups: AnalyticsModule["groups"]) {
  return {
    stats,
    groups: {
      "Records by customer": groupCount(records.map((record) => record.customer ?? record.client)).slice(0, 8),
      "Records by supplier": groupCount(records.map((record) => record.supplier_name ?? record.supplier)).slice(0, 8),
      "Top MPNs": groupMpns(records).slice(0, 8),
      ...groups
    }
  };
}

export function buildPlatformAnalytics(input: {
  records: PlatformRecord[];
  uploads: UploadBatch[];
  profiles: Profile[];
}): PlatformAnalyticsSummary {
  const { records, uploads, profiles } = input;
  const completedUploads = uploads.filter((upload) => upload.status !== "archived");
  const activeEmployees = profiles.filter((profile) => profile.is_active);
  const categories = new Set(records.map((record) => record.category ?? "Generic"));
  const recordsMissingMpn = records.filter((record) => !mpnValue(record)).length;
  const incompleteRecords = records.filter((record) => {
    const important = [
      record.customer ?? record.client,
      record.supplier ?? record.supplier_name,
      mpnValue(record),
      record.qty ?? record.req_qty,
      record.price ?? record.total_price
    ];
    return important.some((value) => !hasValue(value));
  }).length;

  const recordsByCategory = groupCount(records.map((record) => record.category ?? "Generic"));
  const byCategory = Object.fromEntries(
    Array.from(categories).map((category) => [
      category,
      records.filter((record) => (record.category ?? "Generic") === category)
    ])
  );

  return {
    totals: {
      totalRecords: records.length,
      totalUploads: completedUploads.length,
      totalEmployeesActive: activeEmployees.length,
      categoriesDetected: categories.size,
      lastUpload:
        [...uploads].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )[0]?.created_at ?? null,
      totalQty: sum(records, "qty"),
      totalPotentialAmountUsd: sum(records, "potential_amount_usd"),
      totalPrice: sum(records, "total_price"),
      grossProfitTotal: sum(records, "gp"),
      averageGpRate: average(records, "gp_rate"),
      commissionTotal: sum(records, "commission"),
      recordsWithErrors: records.filter((record) => record.has_errors).length,
      incompleteRecords,
      recordsMissingMpn
    },
    recordsByCategory,
    uploadsByEmployee: groupCount(
      uploads.map((upload) => upload.profiles?.full_name ?? upload.uploaded_by)
    ),
    recordsByCustomer: groupCount(records.map((record) => record.customer ?? record.client)).slice(0, 10),
    recordsBySupplier: groupCount(records.map((record) => record.supplier_name ?? record.supplier)).slice(0, 10),
    topMpns: groupMpns(records).slice(0, 10),
    recordsByDepartment: groupCount(records.map((record) => record.profiles?.department)).slice(0, 10),
    employeesByRole: groupCount(activeEmployees.map((profile) => profile.role)).slice(0, 10),
    employeesByRegion: groupCount(activeEmployees.map((profile) => profile.region)).slice(0, 10),
    employeesByDepartment: groupCount(activeEmployees.map((profile) => profile.department)).slice(0, 10),
    recordsOverTime: groupCount(records.map((record) => record.created_at.slice(0, 10))).slice(0, 30),
    categoryModules: {
      "Sales Margin": moduleFor(byCategory["Sales Margin"] ?? [], [
        { label: "Total Price sum", value: sum(byCategory["Sales Margin"] ?? [], "total_price") },
        { label: "GP sum", value: sum(byCategory["Sales Margin"] ?? [], "gp") },
        { label: "Average GP Rate", value: average(byCategory["Sales Margin"] ?? [], "gp_rate") },
        { label: "Commission sum", value: sum(byCategory["Sales Margin"] ?? [], "commission") }
      ], {
        "Rows with formula errors": groupCount(
          (byCategory["Sales Margin"] ?? []).map((record) =>
            JSON.stringify(record.errors ?? "").includes("formula_error") ? "Formula error" : "Clean"
          )
        )
      }),
      RFQ: moduleFor(byCategory.RFQ ?? [], [
        { label: "Total REQ QTY", value: sum(byCategory.RFQ ?? [], "req_qty") },
        {
          label: "Total Potential Amount USD",
          value: sum(byCategory.RFQ ?? [], "potential_amount_usd")
        },
        { label: "Target to vendor average", value: average(byCategory.RFQ ?? [], "target_to_vendor") }
      ], {
        "Top generic categories": groupCount((byCategory.RFQ ?? []).map((record) => record.generic))
      }),
      "Supplier Offers": moduleFor(byCategory["Supplier Offers"] ?? [], [
        {
          label: "Average best price offered",
          value: average(byCategory["Supplier Offers"] ?? [], "best_price_offered")
        },
        { label: "MPN quoted count", value: groupCount((byCategory["Supplier Offers"] ?? []).map((record) => record.mpn_quoted)).length },
        { label: "MOQ average", value: average(byCategory["Supplier Offers"] ?? [], "moq") },
        { label: "SPQ average", value: average(byCategory["Supplier Offers"] ?? [], "spq") }
      ], {
        "Date code distribution": groupCount((byCategory["Supplier Offers"] ?? []).map((record) => record.date_code))
      }),
      Logistics: moduleFor(byCategory.Logistics ?? [], [
        { label: "Lead time average", value: average(byCategory.Logistics ?? [], "lead_time_weeks") },
        { label: "Transit time average", value: average(byCategory.Logistics ?? [], "transit_time_weeks") },
        { label: "Delivery quantities", value: sum(byCategory.Logistics ?? [], "qty") }
      ], {
        "Shipping point countries": groupCount((byCategory.Logistics ?? []).map((record) => record.shipping_point_country)),
        "Delivery point summary": groupCount((byCategory.Logistics ?? []).map((record) => record.delivery_point))
      }),
      Generic: moduleFor(byCategory.Generic ?? [], [
        { label: "Total rows", value: (byCategory.Generic ?? []).length },
        { label: "Rows with errors", value: (byCategory.Generic ?? []).filter((record) => record.has_errors).length },
        { label: "Data quality score", value: records.length ? Math.round(((records.length - incompleteRecords) / records.length) * 100) : 0 }
      ], {
        "Missing values": groupCount(
          (byCategory.Generic ?? []).map((record) =>
            Object.values(record.normalized_data).some((value) => value === null) ? "Has missing values" : "Complete"
          )
        )
      })
    }
  };
}
