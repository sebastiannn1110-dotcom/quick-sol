"use client";

import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import UploadHistory from "@/components/UploadHistory";
import type { UploadBatch } from "@/lib/types";

export default function AdminUploadsPage() {
  const [uploads, setUploads] = useState<UploadBatch[]>([]);

  async function loadUploads() {
    const response = await fetch("/api/admin/uploads", { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as { uploads: UploadBatch[] };
      setUploads(payload.uploads ?? []);
    }
  }

  useEffect(() => {
    loadUploads();
  }, []);

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Admin</p>
          <h1 className="text-2xl font-semibold text-slate-950">All Uploads</h1>
        </div>
        <UploadHistory uploads={uploads} showDownload />
      </div>
    </AdminGuard>
  );
}
