import { readDatabase } from "@/lib/jsonDatabase";
import type { PlatformRecord, Profile, UploadBatch } from "@/lib/types";

function normalizeLegacyCategory(category: string) {
  if (category === "Orders" || category === "Finance") return "Sales Margin";
  if (category === "Suppliers") return "Supplier Offers";
  if (category === "Customers") return "Customer Demand";
  if (category === "Quality Inspection") return "Quality";
  return category || "Generic";
}

export async function getDemoPlatformData() {
  const database = await readDatabase();
  const profiles: Profile[] = database.employees.map((employee) => ({
    id: employee.id,
    full_name: employee.name,
    email: employee.email ?? `${employee.id.toLowerCase()}@quiksol.local`,
    role: employee.id === "EMP-1001" ? "admin" : "employee",
    department: employee.department,
    region: employee.region,
    is_active: true,
    created_at: employee.createdAt,
    updated_at: employee.createdAt
  }));

  const uploads: UploadBatch[] = database.uploads.map((upload) => ({
    id: upload.id,
    uploaded_by: upload.employeeId,
    original_file_name: upload.originalFileName,
    stored_file_path: null,
    file_type: upload.originalFileName.split(".").pop() ?? null,
    file_size: null,
    selected_category: upload.selectedCategory,
    detected_category: normalizeLegacyCategory(upload.detectedCategory),
    status: "completed",
    total_sheets: 1,
    total_rows: upload.totalRows,
    valid_rows: upload.validRows,
    invalid_rows: upload.invalidRows,
    error_count: upload.invalidRows,
    data_quality_score: 92,
    notes: upload.notes ?? null,
    created_at: upload.uploadedAt,
    completed_at: upload.uploadedAt,
    archived_at: null,
    profiles: {
      full_name: upload.employeeName,
      email: `${upload.employeeId.toLowerCase()}@quiksol.local`,
      department: upload.department,
      region: upload.region,
      role: upload.employeeId === "EMP-1001" ? "admin" : "employee"
    }
  }));

  const records: PlatformRecord[] = database.records.map((record) => {
    const normalized = record.normalizedData;
    return {
      id: record.id,
      upload_batch_id: record.uploadId,
      upload_sheet_id: null,
      uploaded_by: record.employeeId,
      category: normalizeLegacyCategory(record.category),
      row_index: record.originalRowIndex,
      raw_data: record.rawData,
      normalized_data: normalized,
      searchable_text: record.searchableText,
      has_errors: false,
      errors: null,
      created_at: record.createdAt,
      archived_at: null,
      line_id: String(normalized.lineId ?? normalized.line_id ?? "") || null,
      client: String(normalized.client ?? "") || null,
      customer: String(normalized.customer ?? normalized.companyName ?? "") || null,
      supplier: String(normalized.supplier ?? "") || null,
      supplier_name: String(normalized.supplierName ?? "") || null,
      mpn: String(normalized.partNumber ?? normalized.mpn ?? "") || null,
      mpn_quoted: String(normalized.mpnQuoted ?? "") || null,
      manufacturer: String(normalized.manufacturer ?? "") || null,
      clean_mfg: String(normalized.cleanMfg ?? "") || null,
      description: String(normalized.description ?? "") || null,
      generic: String(normalized.generic ?? normalized.componentCategory ?? "") || null,
      po: String(normalized.po ?? normalized.orderId ?? "") || null,
      qty: Number(normalized.quantityAvailable ?? normalized.quantitySold ?? normalized.quantityRequested ?? 0),
      req_qty: Number(normalized.reqQty ?? 0) || null,
      cost: Number(normalized.cost ?? normalized.productCost ?? normalized.unitCost ?? 0) || null,
      price: Number(normalized.price ?? normalized.sellingPrice ?? normalized.salePrice ?? 0) || null,
      total_price: Number(normalized.totalPrice ?? normalized.totalSale ?? 0) || null,
      gp_rate: Number(normalized.gpRate ?? normalized.grossMargin ?? normalized.margin ?? 0) || null,
      gp: Number(normalized.gp ?? normalized.netProfit ?? 0) || null,
      commission: Number(normalized.commission ?? 0) || null,
      potential_amount_usd: Number(normalized.potentialAmountUsd ?? 0) || null,
      target_to_vendor: Number(normalized.targetToVendor ?? 0) || null,
      best_price_offered: Number(normalized.bestPriceOffered ?? 0) || null,
      date_code: String(normalized.dateCode ?? "") || null,
      moq: Number(normalized.moq ?? 0) || null,
      spq: Number(normalized.spq ?? 0) || null,
      on_hand: Number(normalized.onHand ?? 0) || null,
      lead_time_weeks: Number(normalized.leadTimeWeeks ?? 0) || null,
      transit_time_weeks: Number(normalized.transitTimeWeeks ?? 0) || null,
      earliest_shipping_date: String(normalized.earliestShippingDate ?? "") || null,
      shipping_point_country: String(normalized.shippingPointCountry ?? "") || null,
      delivery_point: String(normalized.deliveryPoint ?? "") || null,
      comments: String(normalized.comments ?? normalized.notes ?? "") || null,
      profiles: {
        full_name: record.employeeName,
        email: `${record.employeeId.toLowerCase()}@quiksol.local`,
        department: record.department,
        region: record.region,
        role: record.employeeId === "EMP-1001" ? "admin" : "employee"
      },
      upload_batches: {
        original_file_name: database.uploads.find((upload) => upload.id === record.uploadId)?.originalFileName ?? "demo.xlsx",
        detected_category: normalizeLegacyCategory(record.category),
        status: "completed"
      }
    };
  });

  return { profiles, uploads, records };
}
