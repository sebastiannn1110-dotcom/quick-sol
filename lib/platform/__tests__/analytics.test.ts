import { describe, expect, it } from "vitest";
import { buildPlatformAnalytics } from "@/lib/platform/analytics";
import type { PlatformRecord, Profile, UploadBatch } from "@/lib/types";

function record(id: string, mpn: string | null): PlatformRecord {
  return {
    id,
    upload_batch_id: "00000000-0000-4000-8000-000000000001",
    upload_sheet_id: null,
    uploaded_by: "00000000-0000-4000-8000-000000000001",
    category: "Sales Margin",
    row_index: 1,
    raw_data: {},
    normalized_data: {},
    searchable_text: "",
    has_errors: false,
    errors: null,
    created_at: "2026-06-25T00:00:00.000Z",
    archived_at: null,
    customer: "Customer",
    supplier: "Supplier",
    mpn,
    qty: 1,
    price: 1
  };
}

const profile: Profile = {
  id: "00000000-0000-4000-8000-000000000001",
  full_name: "Quiksol Admin",
  email: "admin@quiksol.local",
  role: "admin",
  department: "Operations",
  region: "Global",
  is_active: true,
  created_at: "2026-06-25T00:00:00.000Z",
  updated_at: "2026-06-25T00:00:00.000Z"
};

const upload: UploadBatch = {
  id: "00000000-0000-4000-8000-000000000001",
  uploaded_by: profile.id,
  original_file_name: "test.xlsx",
  stored_file_path: null,
  file_type: "xlsx",
  file_size: 100,
  selected_category: "Sales Margin",
  detected_category: "Sales Margin",
  status: "completed",
  total_sheets: 1,
  total_rows: 4,
  valid_rows: 4,
  invalid_rows: 0,
  error_count: 0,
  data_quality_score: 100,
  notes: null,
  created_at: "2026-06-25T00:00:00.000Z",
  completed_at: "2026-06-25T00:00:00.000Z",
  archived_at: null
};

describe("buildPlatformAnalytics", () => {
  it("keeps Missing MPN after real MPN groups", () => {
    const analytics = buildPlatformAnalytics({
      records: [record("1", "ABC"), record("2", "ABC"), record("3", null), record("4", null), record("5", null)],
      uploads: [upload],
      profiles: [profile]
    });

    expect(analytics.totals.recordsMissingMpn).toBe(3);
    expect(analytics.topMpns[0]).toEqual({ label: "ABC", value: 2, percent: 100 });
    expect(analytics.topMpns.at(-1)).toEqual({ label: "Missing MPN", value: 3 });
  });

  it("does not count archived records", () => {
    const archived = {
      ...record("archived", "ARCHIVED-MPN"),
      archived_at: "2026-07-17T00:00:00.000Z"
    };

    const analytics = buildPlatformAnalytics({
      records: [record("active", "ACTIVE-MPN"), archived],
      uploads: [upload],
      profiles: [profile]
    });

    expect(analytics.totals.totalRecords).toBe(1);
    expect(analytics.topMpns).toEqual([{ label: "ACTIVE-MPN", value: 1, percent: 100 }]);
  });
});
