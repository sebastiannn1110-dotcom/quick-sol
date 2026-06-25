import type { BusinessCategory, Upload, UploadBatch } from "@/lib/types";
import CategoryBadge from "@/components/CategoryBadge";

type UploadLike = Upload | UploadBatch;

function isBatch(upload: UploadLike): upload is UploadBatch {
  return "original_file_name" in upload;
}

function categoryOf(upload: UploadLike) {
  const category = isBatch(upload) ? upload.detected_category : upload.detectedCategory;
  return (category || "Generic") as BusinessCategory;
}

function fileNameOf(upload: UploadLike) {
  return isBatch(upload) ? upload.original_file_name : upload.originalFileName;
}

function employeeOf(upload: UploadLike) {
  if (isBatch(upload)) return upload.profiles?.full_name ?? upload.uploaded_by;
  return `${upload.employeeName} (${upload.employeeId})`;
}

function rowsOf(upload: UploadLike) {
  return isBatch(upload) ? upload.valid_rows : upload.validRows;
}

function errorsOf(upload: UploadLike) {
  return isBatch(upload) ? upload.error_count : upload.invalidRows;
}

function dateOf(upload: UploadLike) {
  return isBatch(upload) ? upload.created_at : upload.uploadedAt;
}

function statusOf(upload: UploadLike) {
  return isBatch(upload) ? upload.status : "completed";
}

function downloadHref(upload: UploadLike) {
  if (!isBatch(upload) || !upload.stored_file_path) return null;
  return `/api/admin/uploads/${upload.id}/download`;
}

export default function UploadHistory({ uploads, showDownload = false }: { uploads: UploadLike[]; showDownload?: boolean }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-950">Upload History</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">File</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">Uploaded by</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">Category</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">Status</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">Rows</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">Errors</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">Uploaded</th>
              {showDownload ? <th className="px-4 py-3 text-left font-semibold text-slate-600">Excel</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {uploads.map((upload) => {
              const href = downloadHref(upload);
              return (
                <tr key={upload.id}>
                  <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">
                    {fileNameOf(upload)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{employeeOf(upload)}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <CategoryBadge category={categoryOf(upload)} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                      {statusOf(upload)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{rowsOf(upload)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{errorsOf(upload)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {new Date(dateOf(upload)).toLocaleString()}
                  </td>
                  {showDownload ? (
                    <td className="whitespace-nowrap px-4 py-3">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
                        >
                          Open Excel
                        </a>
                      ) : (
                        <span className="text-xs text-slate-400">No file</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {!uploads.length ? (
              <tr>
                <td className="px-4 py-8 text-center text-slate-500" colSpan={showDownload ? 8 : 7}>
                  No uploads yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
