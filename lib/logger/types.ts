export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal" | "security" | "audit";
export type LogStatus = "success" | "failed" | "started" | "completed";
export type LogModule =
  | "upload"
  | "excel-parser"
  | "header-detector"
  | "normalizer"
  | "category-detector"
  | "auth"
  | "admin"
  | "records"
  | "analytics"
  | "supabase"
  | "api"
  | "frontend"
  | "security";

export interface LogError {
  name?: string;
  message: string;
  stack?: string;
  code?: string;
}

export interface LogContext {
  traceId: string;
  requestId?: string;
  userId?: string;
  userEmail?: string;
  userRole?: string;
  route?: string;
  method?: string;
  uploadBatchId?: string;
  fileName?: string;
  sheetName?: string;
  rowIndex?: number;
  columnName?: string;
  category?: string;
}

export interface LogEvent extends LogContext {
  timestamp?: string;
  level: LogLevel;
  environment?: string;
  service?: "quiksol-data-platform";
  module: LogModule;
  action: string;
  message: string;
  durationMs?: number;
  status?: LogStatus;
  metadata?: Record<string, unknown>;
  error?: Error | LogError | unknown;
}

export interface PersistableLogEvent extends Omit<LogEvent, "error"> {
  timestamp: string;
  environment: string;
  service: "quiksol-data-platform";
  error?: LogError;
}
