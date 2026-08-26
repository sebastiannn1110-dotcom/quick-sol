import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("client-associated upload UX contract", () => {
  it("binds idempotency to the verified client and assigns before issuing a signed URL", () => {
    const initiate = source("app/api/upload/initiate/route.ts");
    const clientCheck = initiate.indexOf("await loadAssignableUploadClient");
    const createUpload = initiate.indexOf('rpc("create_import_upload_v2"');
    const assignment = initiate.indexOf("await ensureClientUploadAssignment");
    const signedUrl = initiate.indexOf("createSignedUploadUrl");

    expect(initiate).toContain("clientId: z.string().uuid()");
    expect(initiate).toContain("`${uploadClient.id}:${parsed.data.idempotencyKey}`");
    expect(clientCheck).toBeGreaterThan(-1);
    expect(createUpload).toBeGreaterThan(clientCheck);
    expect(assignment).toBeGreaterThan(createUpload);
    expect(signedUrl).toBeGreaterThan(assignment);
  });

  it("carries only the selected internal id through the existing initiate/finalize pipeline", () => {
    const card = source("components/UploadExcelCard.tsx");

    expect(card).toContain("clientId: client.id");
    expect(card).toContain('fetch("/api/upload/initiate"');
    expect(card).toContain('fetch("/api/upload/finalize"');
    expect(card).toContain('disabled={loading || !client}');
    expect(card).toContain('t("upload.uploadingFor")');
    expect(card).toContain('t("upload.completedFor")');
    expect(card).toContain("activeJob.clientName");
    expect(card).not.toMatch(/jobs\/\$\{activeJob\.jobId\}\/retry[\s\S]{0,300}clientId/);
  });

  it("exposes upload actions from both client cards and client detail", () => {
    for (const file of ["components/clients/ClientCard.tsx", "app/clients/[clientId]/page.tsx"]) {
      const code = source(file);
      expect(code).toContain("/upload?clientId=");
      expect(code).toContain('t("clients.uploadFiles")');
    }
  });

  it("keeps the existing table authoritative and never upserts a reassignment", () => {
    const helper = source("lib/upload/client-assignment.ts");
    const adminAssignment = source("app/api/admin/clients/[clientId]/assignments/route.ts");

    expect(helper).toContain('from("client_upload_assignments")');
    expect(helper).toContain("UPLOAD_CLIENT_CONFLICT");
    expect(helper).not.toContain(".upsert(");
    expect(adminAssignment).not.toContain(".upsert(");
  });
});
