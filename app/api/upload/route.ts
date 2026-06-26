import { NextResponse } from "next/server";
import { parseExcelWorkbook } from "@/lib/excel/parser";
import { safeStoragePath, sanitizeFileName, uploadFormSchema, validateUploadFile } from "@/lib/excel/validators";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { handleRouteError } from "@/lib/errors/errorHandler";
import { FileValidationError, StorageError, SupabaseError, ValidationError } from "@/lib/errors/AppError";
import { logger } from "@/lib/logger/logger";
import { safeStorageUpload } from "@/lib/supabase/supabase-safe";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { SECURITY_LIMITS } from "@/lib/security/env";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";
import { evaluateEmailAlertRules } from "@/lib/email/evaluate-alert-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function normalizeSelectedCategory(category: string, detectedCategory: string) {
  if (!category || category === "Auto Detect") return detectedCategory;
  if (category === "Supplier Offer") return "Supplier Offers";
  if (category === "Quotation") return "RFQ";
  return category;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const logContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: request.method
  };

  if (context.isDemoMode) {
    await logger.info({
      ...logContext,
      module: "upload",
      action: "uploads_loaded_demo",
      message: "Upload history loaded from demo data.",
      status: "completed"
    });
    const { uploads } = await getDemoPlatformData();
    return NextResponse.json({ uploads });
  }

  const query = context.supabase!
    .from("upload_batches")
    .select("*, profiles(full_name,email,department,region,role)")
    .order("created_at", { ascending: false })
    .limit(100);

  const { data, error } = await query;
  if (error) {
    return handleRouteError(new SupabaseError("Unable to load uploads.", { table: "upload_batches" }), logContext, {
      module: "upload",
      action: "uploads_load_failed"
    });
  }

  return NextResponse.json({ uploads: data ?? [] });
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const requestStartedAt = performance.now();
  const logContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: request.method
  };

  await logger.info({
    ...logContext,
    module: "upload",
    action: "upload_form_submitted",
    message: "Excel upload request started.",
    status: "started"
  });

  const rate = checkRateLimit({
    key: `upload:${context.profile.id}`,
    limit: 10,
    windowMs: 15 * 60 * 1000
  });
  if (!rate.allowed) {
    await logger.security({
      ...logContext,
      module: "upload",
      action: "rate_limit_triggered",
      message: "Upload rate limit triggered.",
      status: "failed",
      metadata: { resetAt: rate.resetAt }
    });
    return rateLimitResponse(rate.resetAt);
  }

  try {
    await logger.info({
      ...logContext,
      module: "upload",
      action: "upload_validation_started",
      message: "Upload validation started.",
      status: "started"
    });

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new FileValidationError("File is required.");
    }

    const parsedForm = uploadFormSchema.safeParse({
      selectedCategory: formString(formData, "selectedCategory") || "Auto Detect",
      department: formString(formData, "department"),
      region: formString(formData, "region"),
      notes: formString(formData, "notes")
    });

    if (!parsedForm.success) {
      throw new ValidationError("Upload form validation failed.", {
        issues: parsedForm.error.issues
      });
    }

    const fileErrors = validateUploadFile(file);
    if (fileErrors.length) {
      await logger.warn({
        ...logContext,
        module: "upload",
        action: "upload_validation_failed",
        message: "Upload file validation failed.",
        status: "failed",
        fileName: file.name,
        metadata: { errors: fileErrors, fileSize: file.size, fileType: file.type }
      });
      await logAuditEvent(context, "file_validation_failed", "upload_batch", null, {
        fileName: file.name,
        errors: fileErrors
      });
      throw new FileValidationError(fileErrors.join(" "), { fileName: file.name, fileSize: file.size });
    }

    await logger.info({
      ...logContext,
      module: "upload",
      action: "upload_validation_passed",
      message: "Upload validation passed.",
      status: "completed",
      fileName: file.name,
      metadata: { fileSize: file.size, fileType: file.type }
    });

    const parsedWorkbook = await parseExcelWorkbook(file, {
      ...logContext,
      fileName: file.name
    });
    if (!parsedWorkbook.records.length) {
      throw new ValidationError("No readable data rows were found.");
    }

    const originalFileName = sanitizeFileName(file.name);
    await logger.info({
      ...logContext,
      module: "upload",
      action: "file_sanitized_name_created",
      message: "Sanitized file name created.",
      status: "completed",
      fileName: originalFileName,
      metadata: { originalName: file.name }
    });
    const selectedCategory = normalizeSelectedCategory(
      parsedForm.data.selectedCategory,
      parsedWorkbook.detectedCategory
    );

    if (context.isDemoMode) {
      await logger.audit({
        ...logContext,
        module: "upload",
        action: "upload_batch_completed",
        message: "Upload completed in demo mode.",
        status: "completed",
        durationMs: Math.round(performance.now() - requestStartedAt),
        fileName: originalFileName,
        category: parsedWorkbook.detectedCategory,
        metadata: {
          demoMode: true,
          totalRows: parsedWorkbook.totalRows,
          validRows: parsedWorkbook.validRows,
          invalidRows: parsedWorkbook.invalidRows,
          errorCount: parsedWorkbook.errorCount
        }
      });
      return NextResponse.json({
        message: "Records Uploaded Successfully (demo mode, configure Supabase to persist).",
        upload: {
          id: crypto.randomUUID(),
          original_file_name: originalFileName,
          selected_category: selectedCategory,
          detected_category: parsedWorkbook.detectedCategory,
          total_rows: parsedWorkbook.totalRows,
          valid_rows: parsedWorkbook.validRows,
          invalid_rows: parsedWorkbook.invalidRows,
          error_count: parsedWorkbook.errorCount,
          data_quality_score: parsedWorkbook.dataQualityScore
        },
        recordsUploaded: parsedWorkbook.validRows,
        detectedCategory: parsedWorkbook.detectedCategory,
        dataQualityScore: parsedWorkbook.dataQualityScore
      });
    }

    const supabase = context.supabase!;
    const uploadBatchId = crypto.randomUUID();
    const storedFilePath = safeStoragePath(context.profile.id, uploadBatchId, originalFileName);
    const uploadLogContext = {
      ...logContext,
      uploadBatchId,
      fileName: originalFileName
    };

    await logger.info({
      ...uploadLogContext,
      module: "upload",
      action: "upload_batch_created",
      message: "Creating upload batch.",
      status: "started",
      category: parsedWorkbook.detectedCategory
    });
    const { error: batchCreateError } = await supabase.from("upload_batches").insert({
      id: uploadBatchId,
      uploaded_by: context.profile.id,
      original_file_name: originalFileName,
      stored_file_path: storedFilePath,
      file_type: file.type || originalFileName.split(".").pop(),
      file_size: file.size,
      selected_category: parsedForm.data.selectedCategory,
      detected_category: parsedWorkbook.detectedCategory,
      status: "uploading",
      total_sheets: parsedWorkbook.sheets.length,
      total_rows: parsedWorkbook.totalRows,
      valid_rows: 0,
      invalid_rows: 0,
      error_count: 0,
      notes: parsedForm.data.notes || null
    });

    if (batchCreateError) {
      throw new SupabaseError("Unable to create upload batch.", {
        table: "upload_batches",
        supabaseError: batchCreateError
      });
    }

    const { error: storageError } = await safeStorageUpload(
      supabase,
      "excel-uploads",
      storedFilePath,
      file,
      uploadLogContext,
      {
        cacheControl: "3600",
        contentType: file.type || "application/octet-stream",
        upsert: false
      }
    );

    if (storageError) {
      await supabase
        .from("upload_batches")
        .update({ status: "failed", error_count: 1, completed_at: new Date().toISOString() })
        .eq("id", uploadBatchId);
      await logAuditEvent(context, "upload_failed", "upload_batch", uploadBatchId, {
        reason: "storage_upload_failed"
      });
      throw new StorageError("Unable to save original file to storage.", {
        bucket: "excel-uploads",
        storedFilePath,
        storageError
      });
    }

    await supabase.from("upload_batches").update({ status: "processing" }).eq("id", uploadBatchId);

    const sheetRows = parsedWorkbook.sheets.map((sheet) => ({
      id: crypto.randomUUID(),
      upload_batch_id: uploadBatchId,
      sheet_name: sheet.sheetName,
      detected_header_row: sheet.detectedHeaderRow,
      total_rows: sheet.totalRows,
      valid_rows: sheet.validRows,
      invalid_rows: sheet.invalidRows,
      detected_category: sheet.detectedCategory
    }));

    const { error: sheetsError } = await supabase.from("upload_sheets").insert(sheetRows);
    if (sheetsError) throw new SupabaseError("Unable to save upload sheets.", { table: "upload_sheets", sheetsError });

    const sheetIdByIndex = new Map(sheetRows.map((sheet, index) => [index, sheet.id]));
    const recordRows = parsedWorkbook.records.map((record) => {
      const category = parsedForm.data.selectedCategory === "Auto Detect" ? record.category : selectedCategory;
      const businessRecordId = crypto.randomUUID();
      return {
        id: businessRecordId,
        upload_batch_id: uploadBatchId,
        upload_sheet_id: sheetIdByIndex.get(record.sheetIndex) ?? null,
        uploaded_by: context.profile.id,
        category,
        row_index: record.rowIndex,
        raw_data: record.rawData,
        normalized_data: {
          ...record.normalizedData,
          department: parsedForm.data.department,
          region: parsedForm.data.region
        },
        searchable_text: `${record.searchableText} ${context.profile.full_name} ${context.profile.email}`.slice(
          0,
          8000
        ),
        has_errors: record.hasErrors,
        errors: record.errors,
        ...record.columns
      };
    });

    for (const [chunkIndex, rows] of chunk(recordRows, SECURITY_LIMITS.uploadChunkSize).entries()) {
      await logger.info({
        ...uploadLogContext,
        module: "upload",
        action: "chunk_insert_started",
        message: "Business record chunk insert started.",
        status: "started",
        metadata: { chunkIndex, rowCount: rows.length }
      });
      const { error } = await supabase.from("business_records").insert(rows);
      if (error) {
        await logger.error({
          ...uploadLogContext,
          module: "upload",
          action: "chunk_insert_failed",
          message: "Business record chunk insert failed.",
          status: "failed",
          metadata: { chunkIndex, rowCount: rows.length },
          error
        });
        throw new SupabaseError("Unable to save business records.", { table: "business_records", chunkIndex, error });
      }
      await logger.info({
        ...uploadLogContext,
        module: "upload",
        action: "chunk_insert_completed",
        message: "Business record chunk insert completed.",
        status: "completed",
        metadata: { chunkIndex, rowCount: rows.length }
      });
    }

    const importErrors = parsedWorkbook.records.flatMap((record, recordIndex) =>
      record.errors.map((issue) => ({
        trace_id: context.requestMeta.traceId,
        upload_batch_id: uploadBatchId,
        upload_sheet_id: sheetIdByIndex.get(record.sheetIndex) ?? null,
        business_record_id: recordRows[recordIndex]?.id ?? null,
        row_index: record.rowIndex,
        column_name: issue.columnName ?? null,
        error_type: issue.errorType,
        message: issue.message,
        raw_value: issue.rawValue ?? null,
        severity: issue.severity
      }))
    );

    for (const rows of chunk(importErrors, SECURITY_LIMITS.uploadChunkSize)) {
      if (!rows.length) continue;
      const { error } = await supabase.from("import_errors").insert(rows);
      if (error) throw new SupabaseError("Unable to save import errors.", { table: "import_errors", error });
    }
    if (importErrors.length) {
      await logger.warn({
        ...uploadLogContext,
        module: "upload",
        action: "import_errors_saved",
        message: "Import errors saved.",
        status: "completed",
        metadata: { errorCount: importErrors.length }
      });
    }

    const completedAt = new Date().toISOString();
    const { data: upload, error: completeError } = await supabase
      .from("upload_batches")
      .update({
        status: "completed",
        detected_category: parsedWorkbook.detectedCategory,
        total_sheets: parsedWorkbook.sheets.length,
        total_rows: parsedWorkbook.totalRows,
        valid_rows: parsedWorkbook.validRows,
        invalid_rows: parsedWorkbook.invalidRows,
        error_count: parsedWorkbook.errorCount,
        data_quality_score: parsedWorkbook.dataQualityScore,
        completed_at: completedAt
      })
      .eq("id", uploadBatchId)
      .select("*")
      .single();

    if (completeError) throw new SupabaseError("Unable to complete upload batch.", { table: "upload_batches", completeError });

    await logAuditEvent(context, "upload_completed", "upload_batch", uploadBatchId, {
      totalRows: parsedWorkbook.totalRows,
      validRows: parsedWorkbook.validRows,
      invalidRows: parsedWorkbook.invalidRows,
      errorCount: parsedWorkbook.errorCount,
      detectedCategory: parsedWorkbook.detectedCategory
    });

    await logger.audit({
      ...uploadLogContext,
      module: "upload",
      action: "upload_batch_completed",
      message: "Upload batch completed.",
      status: "completed",
      durationMs: Math.round(performance.now() - requestStartedAt),
      category: parsedWorkbook.detectedCategory,
      metadata: {
        totalRows: parsedWorkbook.totalRows,
        validRows: parsedWorkbook.validRows,
        invalidRows: parsedWorkbook.invalidRows,
        errorCount: parsedWorkbook.errorCount,
        dataQualityScore: parsedWorkbook.dataQualityScore
      }
    });

    const missingMpnCount = parsedWorkbook.records.filter((record) => !record.columns.mpn).length;
    const gpRates = parsedWorkbook.records
      .map((record) => Number(record.columns.gp_rate))
      .filter((value) => Number.isFinite(value));
    const lowGpRate = gpRates.length ? Math.min(...gpRates) : null;
    const alertBase = {
      actorName: context.profile.full_name,
      actorEmail: context.profile.email,
      fileName: originalFileName,
      uploadBatchId,
      errorCount: parsedWorkbook.errorCount,
      dataQualityScore: parsedWorkbook.dataQualityScore,
      missingMpnCount,
      lowGpRate,
      totalRows: parsedWorkbook.totalRows,
      validRows: parsedWorkbook.validRows,
      dashboardUrl: process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/admin/uploads` : null,
      metadata: {
        detectedCategory: parsedWorkbook.detectedCategory,
        invalidRows: parsedWorkbook.invalidRows
      }
    };
    await Promise.all([
      evaluateEmailAlertRules({ ...alertBase, eventType: "upload_completed" }),
      evaluateEmailAlertRules({ ...alertBase, eventType: "upload_has_many_errors" }),
      evaluateEmailAlertRules({ ...alertBase, eventType: "import_quality_below_threshold" }),
      evaluateEmailAlertRules({ ...alertBase, eventType: "missing_mpn_threshold" }),
      evaluateEmailAlertRules({ ...alertBase, eventType: "low_gp_rate" })
    ]);

    return NextResponse.json({
      message: "Records Uploaded Successfully",
      upload,
      recordsUploaded: parsedWorkbook.validRows,
      detectedCategory: parsedWorkbook.detectedCategory,
      dataQualityScore: parsedWorkbook.dataQualityScore
    });
  } catch (error) {
    await logAuditEvent(context, "upload_failed", "upload_batch", null, {
      message: error instanceof Error ? error.message : "Unknown upload error"
    });
    await evaluateEmailAlertRules({
      eventType: "upload_failed",
      actorName: context.profile.full_name,
      actorEmail: context.profile.email,
      errorCount: 1,
      metadata: {
        message: error instanceof Error ? error.message : "Unknown upload error"
      }
    });
    return handleRouteError(error, logContext, {
      module: "upload",
      action: "upload_batch_failed",
      fallbackMessage: "Failed to upload file. Please verify the file and try again."
    });
  }
}
