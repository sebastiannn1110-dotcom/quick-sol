import type {
  AnalyticsModule,
  AnalyticsSummary,
  BusinessRecord,
  DatabaseShape,
  MetricItem,
  Upload
} from "@/lib/types";

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[%,$]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function groupCount(items: string[], emptyLabel = "Unspecified"): MetricItem[] {
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    const key = item?.trim() || emptyLabel;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0) || 1;

  return Object.entries(counts)
    .map(([label, value]) => ({
      label,
      value,
      percent: Math.round((value / total) * 100)
    }))
    .sort((a, b) => b.value - a.value);
}

function topValues(records: BusinessRecord[], key: string, limit = 5) {
  return groupCount(records.map((record) => String(record.normalizedData[key] ?? ""))).slice(0, limit);
}

function categoryRecords(records: BusinessRecord[], category: string) {
  return records.filter((record) => record.category === category);
}

function average(records: BusinessRecord[], key: string) {
  const values = records
    .map((record) => toNumber(record.normalizedData[key]))
    .filter((value) => value !== 0);

  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function sum(records: BusinessRecord[], key: string) {
  return Number(
    records.reduce((total, record) => total + toNumber(record.normalizedData[key]), 0).toFixed(2)
  );
}

function module(stats: MetricItem[], groups: AnalyticsModule["groups"]): AnalyticsModule {
  return { stats, groups };
}

function recordsCreatedToday(records: BusinessRecord[]) {
  const today = new Date().toISOString().slice(0, 10);
  return records.filter((record) => record.createdAt.slice(0, 10) === today).length;
}

function lastUploadDate(uploads: Upload[]) {
  return (
    [...uploads].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    )[0]?.uploadedAt ?? null
  );
}

export function buildAnalytics(database: DatabaseShape): AnalyticsSummary {
  const { records, uploads, employees } = database;
  const inventory = categoryRecords(records, "Inventory");
  const customers = categoryRecords(records, "Customers");
  const suppliers = categoryRecords(records, "Suppliers");
  const rfq = categoryRecords(records, "RFQ");
  const orders = categoryRecords(records, "Orders");
  const logistics = categoryRecords(records, "Logistics");
  const quality = categoryRecords(records, "Quality Inspection");
  const market = categoryRecords(records, "Market Insights");
  const finance = categoryRecords(records, "Finance");

  return {
    totals: {
      totalRecords: records.length,
      totalUploads: uploads.length,
      totalEmployees: employees.length,
      categoriesDetected: new Set(records.map((record) => record.category)).size,
      lastUpload: lastUploadDate(uploads),
      recordsUploadedToday: recordsCreatedToday(records)
    },
    recordsByCategory: groupCount(records.map((record) => record.category)),
    uploadsByEmployee: groupCount(uploads.map((upload) => `${upload.employeeName} (${upload.employeeId})`)),
    recordsByDepartment: groupCount(records.map((record) => record.department)),
    inventory: module(
      [
        { label: "Total parts", value: inventory.length },
        { label: "Total quantity", value: sum(inventory, "quantityAvailable") },
        { label: "Average unit cost", value: average(inventory, "unitCost") }
      ],
      {
        "Top manufacturers": topValues(inventory, "manufacturer"),
        "Stock by status": topValues(inventory, "status"),
        "Warehouses with most inventory": topValues(inventory, "warehouseLocation")
      }
    ),
    customers: module(
      [{ label: "Total customers", value: customers.length }],
      {
        "Customers by country": topValues(customers, "country"),
        "Customers by priority": topValues(customers, "customerPriority"),
        "Assigned salesperson summary": topValues(customers, "assignedSalesperson")
      }
    ),
    suppliers: module(
      [
        { label: "Total suppliers", value: suppliers.length },
        { label: "Average reliability score", value: average(suppliers, "reliabilityScore") }
      ],
      {
        "Suppliers by country": topValues(suppliers, "country"),
        "Risk level distribution": topValues(suppliers, "riskLevel")
      }
    ),
    rfq: module(
      [
        { label: "Total RFQs", value: rfq.length },
        { label: "Average margin", value: average(rfq, "margin") }
      ],
      {
        "Won / Lost / Pending": topValues(rfq, "status"),
        "RFQs by salesperson": topValues(rfq, "salesperson")
      }
    ),
    orders: module(
      [
        { label: "Total orders", value: orders.length },
        { label: "Total sales amount", value: sum(orders, "totalSale") },
        { label: "Average gross margin", value: average(orders, "grossMargin") }
      ],
      {
        "Payment status summary": topValues(orders, "paymentStatus"),
        "Shipping status summary": topValues(orders, "shippingStatus")
      }
    ),
    logistics: module(
      [
        { label: "Total shipments", value: logistics.length },
        {
          label: "Customs pending count",
          value: logistics.filter((record) =>
            String(record.normalizedData.customsStatus ?? "").toLowerCase().includes("pending")
          ).length
        }
      ],
      {
        "Shipments by carrier": topValues(logistics, "carrier"),
        "Shipments by status": topValues(logistics, "currentStatus")
      }
    ),
    quality: module(
      [
        { label: "Total inspections", value: quality.length },
        {
          label: "Suspicious authenticity count",
          value: quality.filter((record) =>
            /suspicious|fail|counterfeit/i.test(String(record.normalizedData.authenticityResult ?? ""))
          ).length
        }
      ],
      {
        "Passed / Failed": topValues(quality, "finalStatus"),
        "Failure rate by supplier": topValues(
          quality.filter((record) => /fail|rejected/i.test(String(record.normalizedData.finalStatus ?? ""))),
          "supplier"
        )
      }
    ),
    marketInsights: module(
      [{ label: "Total insights", value: market.length }],
      {
        "Trends rising/stable/falling": topValues(market, "marketTrend"),
        "Shortage risk by category": topValues(market, "shortageRisk"),
        "Demand level summary": topValues(market, "demandLevel")
      }
    ),
    finance: module(
      [
        { label: "Average gross margin", value: average(finance, "grossMargin") },
        { label: "Net profit summary", value: sum(finance, "netProfit") }
      ],
      {
        "Revenue by currency": topValues(finance, "currency"),
        "Commission summary": [
          { label: "Total commission", value: sum(finance, "commission"), percent: 100 }
        ]
      }
    )
  };
}
