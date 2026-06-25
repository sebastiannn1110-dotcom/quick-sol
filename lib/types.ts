export const BUSINESS_CATEGORIES = [
  "Sales Margin",
  "Customer Demand",
  "Supplier Offers",
  "Generic",
  "Inventory",
  "Customers",
  "Suppliers",
  "RFQ",
  "Orders",
  "Logistics",
  "Quality",
  "Quality Inspection",
  "Market Insights",
  "Finance",
  "Employees",
  "Unknown"
] as const;

export const SELECTABLE_UPLOAD_CATEGORIES = [
  "Auto Detect",
  "Quotation",
  "Supplier Offer",
  "Customer Demand",
  "Sales Margin",
  "Generic",
  "Inventory",
  "Customers",
  "Suppliers",
  "RFQ",
  "Orders",
  "Logistics",
  "Quality Inspection",
  "Market Insights",
  "Finance",
  "Employees"
] as const;

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];
export type UploadCategory = (typeof SELECTABLE_UPLOAD_CATEGORIES)[number];
export type UserRole = "admin" | "manager" | "employee";
export type UploadStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "completed"
  | "failed"
  | "archived";
export type ImportSeverity = "low" | "medium" | "high" | "critical";

export type JsonPrimitive = string | number | boolean | null;
export type JsonRecord = Record<string, JsonPrimitive | JsonPrimitive[]>;

export interface Employee {
  id: string;
  name: string;
  department: string;
  region: string;
  role: string;
  email?: string;
  createdAt: string;
}

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  department: string | null;
  region: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UploadBatch {
  id: string;
  uploaded_by: string;
  original_file_name: string;
  stored_file_path: string | null;
  file_type: string | null;
  file_size: number | null;
  selected_category: string | null;
  detected_category: string | null;
  status: UploadStatus;
  total_sheets: number;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  error_count: number;
  data_quality_score: number | null;
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  archived_at: string | null;
  profiles?: Pick<Profile, "full_name" | "email" | "department" | "region" | "role"> | null;
}

export interface UploadSheet {
  id: string;
  upload_batch_id: string;
  sheet_name: string | null;
  detected_header_row: number | null;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  detected_category: string | null;
  created_at: string;
}

export interface PlatformRecordColumns {
  line_id?: string | null;
  client?: string | null;
  customer?: string | null;
  supplier?: string | null;
  supplier_name?: string | null;
  mpn?: string | null;
  mpn_quoted?: string | null;
  manufacturer?: string | null;
  clean_mfg?: string | null;
  description?: string | null;
  generic?: string | null;
  po?: string | null;
  qty?: number | null;
  req_qty?: number | null;
  cost?: number | null;
  price?: number | null;
  total_price?: number | null;
  gp_rate?: number | null;
  gp?: number | null;
  commission?: number | null;
  potential_amount_usd?: number | null;
  target_to_vendor?: number | null;
  best_price_offered?: number | null;
  date_code?: string | null;
  moq?: number | null;
  spq?: number | null;
  on_hand?: number | null;
  lead_time_weeks?: number | null;
  transit_time_weeks?: number | null;
  earliest_shipping_date?: string | null;
  shipping_point_country?: string | null;
  delivery_point?: string | null;
  comments?: string | null;
}

export interface PlatformRecord extends PlatformRecordColumns {
  id: string;
  upload_batch_id: string;
  upload_sheet_id: string | null;
  uploaded_by: string;
  category: string | null;
  row_index: number | null;
  raw_data: JsonRecord;
  normalized_data: JsonRecord;
  searchable_text: string | null;
  has_errors: boolean;
  errors: JsonRecord[] | JsonRecord | null;
  created_at: string;
  archived_at: string | null;
  profiles?: Pick<Profile, "full_name" | "email" | "department" | "region" | "role"> | null;
  upload_batches?: Pick<UploadBatch, "original_file_name" | "detected_category" | "status"> | null;
}

export interface ImportErrorLog {
  id: string;
  trace_id?: string | null;
  upload_batch_id: string;
  upload_sheet_id: string | null;
  business_record_id: string | null;
  row_index: number | null;
  column_name: string | null;
  error_type: string | null;
  message: string | null;
  raw_value: string | null;
  severity: ImportSeverity | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: JsonRecord | null;
  created_at: string;
}

export interface SecurityEvent {
  id: string;
  trace_id?: string | null;
  actor_id: string | null;
  actor_email?: string | null;
  event_type: string;
  severity: ImportSeverity | null;
  route: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: JsonRecord | null;
  created_at: string;
}

export interface Upload {
  id: string;
  employeeId: string;
  employeeName: string;
  department: string;
  region: string;
  originalFileName: string;
  detectedCategory: BusinessCategory;
  selectedCategory: UploadCategory;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  uploadedAt: string;
  notes?: string;
}

export interface BusinessRecord {
  id: string;
  uploadId: string;
  employeeId: string;
  employeeName: string;
  department: string;
  region: string;
  category: BusinessCategory;
  sourceSheet: string;
  originalRowIndex: number;
  normalizedData: JsonRecord;
  rawData: JsonRecord;
  createdAt: string;
  searchableText: string;
}

export interface DatabaseShape {
  employees: Employee[];
  uploads: Upload[];
  records: BusinessRecord[];
}

export interface RecordFilters {
  query?: string;
  category?: string;
  employeeId?: string;
  department?: string;
  region?: string;
  uploadDateFrom?: string;
  uploadDateTo?: string;
}

export interface MetricItem {
  label: string;
  value: number;
  percent?: number;
}

export interface AnalyticsModule {
  stats: MetricItem[];
  groups: Record<string, MetricItem[]>;
}

export interface AnalyticsSummary {
  totals: {
    totalRecords: number;
    totalUploads: number;
    totalEmployees: number;
    categoriesDetected: number;
    lastUpload: string | null;
    recordsUploadedToday: number;
  };
  recordsByCategory: MetricItem[];
  uploadsByEmployee: MetricItem[];
  recordsByDepartment: MetricItem[];
  inventory: AnalyticsModule;
  customers: AnalyticsModule;
  suppliers: AnalyticsModule;
  rfq: AnalyticsModule;
  orders: AnalyticsModule;
  logistics: AnalyticsModule;
  quality: AnalyticsModule;
  marketInsights: AnalyticsModule;
  finance: AnalyticsModule;
}

export interface PlatformAnalyticsSummary {
  totals: {
    totalRecords: number;
    totalUploads: number;
    totalEmployeesActive: number;
    categoriesDetected: number;
    lastUpload: string | null;
    totalQty: number;
    totalPotentialAmountUsd: number;
    totalPrice: number;
    grossProfitTotal: number;
    averageGpRate: number;
    commissionTotal: number;
    recordsWithErrors: number;
    incompleteRecords: number;
    recordsMissingMpn: number;
  };
  recordsByCategory: MetricItem[];
  uploadsByEmployee: MetricItem[];
  recordsByCustomer: MetricItem[];
  recordsBySupplier: MetricItem[];
  topMpns: MetricItem[];
  recordsByDepartment: MetricItem[];
  employeesByRole: MetricItem[];
  employeesByRegion: MetricItem[];
  employeesByDepartment: MetricItem[];
  recordsOverTime: MetricItem[];
  categoryModules: Record<string, AnalyticsModule>;
}

export interface DatabaseRepository {
  readDatabase(): Promise<DatabaseShape>;
  writeDatabase(database: DatabaseShape): Promise<void>;
  addUpload(upload: Upload): Promise<Upload>;
  addRecords(records: BusinessRecord[]): Promise<BusinessRecord[]>;
  upsertEmployee(employee: Employee): Promise<Employee>;
  getRecords(filters?: RecordFilters): Promise<BusinessRecord[]>;
  getEmployeeById(employeeId: string): Promise<Employee | null>;
  getRecordsByEmployeeId(employeeId: string): Promise<BusinessRecord[]>;
  getUploadsByEmployeeId(employeeId: string): Promise<Upload[]>;
  searchRecords(query: string): Promise<BusinessRecord[]>;
  getAnalytics(): Promise<AnalyticsSummary>;
}

export interface ParsedSheetRow {
  sourceSheet: string;
  originalRowIndex: number;
  rawData: JsonRecord;
}

export interface CategoryDetectionResult {
  category: BusinessCategory;
  confidence: number;
  scores: Partial<Record<BusinessCategory, number>>;
}
