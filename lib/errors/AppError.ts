export type AppErrorSeverity = "low" | "medium" | "high" | "critical";

export class AppError extends Error {
  code: string;
  statusCode: number;
  severity: AppErrorSeverity;
  safeMessage: string;
  internalMessage: string;
  details?: Record<string, unknown>;

  constructor(input: {
    code: string;
    message: string;
    statusCode?: number;
    severity?: AppErrorSeverity;
    safeMessage?: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = this.constructor.name;
    this.code = input.code;
    this.statusCode = input.statusCode ?? 500;
    this.severity = input.severity ?? "medium";
    this.safeMessage = input.safeMessage ?? "Something went wrong. Please try again.";
    this.internalMessage = input.message;
    this.details = input.details;
  }
}

export class AuthError extends AppError {
  constructor(message = "Authentication failed", details?: Record<string, unknown>) {
    super({ code: "AUTH_ERROR", message, statusCode: 401, severity: "high", safeMessage: "Authentication required.", details });
  }
}

export class PermissionError extends AppError {
  constructor(message = "Permission denied", details?: Record<string, unknown>) {
    super({ code: "PERMISSION_ERROR", message, statusCode: 403, severity: "high", safeMessage: "You do not have permission to perform this action.", details });
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: Record<string, unknown>) {
    super({ code: "VALIDATION_ERROR", message, statusCode: 400, severity: "medium", safeMessage: message, details });
  }
}

export class FileValidationError extends ValidationError {
  constructor(message = "File validation failed", details?: Record<string, unknown>) {
    super(message, details);
    this.code = "FILE_VALIDATION_ERROR";
  }
}

export class ExcelParseError extends AppError {
  constructor(message = "Excel parsing failed", details?: Record<string, unknown>) {
    super({ code: "EXCEL_PARSE_ERROR", message, statusCode: 400, severity: "medium", safeMessage: "The spreadsheet could not be processed.", details });
  }
}

export class SupabaseError extends AppError {
  constructor(message = "Supabase operation failed", details?: Record<string, unknown>) {
    super({ code: "SUPABASE_ERROR", message, statusCode: 500, severity: "high", safeMessage: "Database operation failed.", details });
  }
}

export class StorageError extends AppError {
  constructor(message = "Storage operation failed", details?: Record<string, unknown>) {
    super({ code: "STORAGE_ERROR", message, statusCode: 500, severity: "high", safeMessage: "File storage failed.", details });
  }
}
