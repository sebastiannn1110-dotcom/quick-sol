import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { ensureClientUploadAssignment, loadAssignableUploadClient } from "@/lib/upload/client-assignment";

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const GOOGLE_ID = "20000000-0000-4000-8000-000000000001";
const AMAZON_ID = "20000000-0000-4000-8000-000000000002";
const UPLOAD_ID = "30000000-0000-4000-8000-000000000001";

function queryResult(result: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "maybeSingle", "insert"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject);
  return builder;
}

function client(sequence: Array<{ data?: unknown; error?: unknown }>) {
  const builders = sequence.map(queryResult);
  const from = vi.fn(() => {
    const next = builders.shift();
    if (!next) throw new Error("Unexpected Supabase query");
    return next;
  });
  return { supabase: { from } as unknown as SupabaseClient, from };
}

describe("client upload assignment", () => {
  it("loads only an active accessible company", async () => {
    const test = client([{ data: { id: GOOGLE_ID, name: "Google" } }]);

    await expect(loadAssignableUploadClient(test.supabase, GOOGLE_ID)).resolves.toEqual({ id: GOOGLE_ID, name: "Google" });
    expect(test.from).toHaveBeenCalledWith("clients");
  });

  it("returns 404 when the company is absent from the actor RLS scope", async () => {
    const test = client([{ data: null }]);

    await expect(loadAssignableUploadClient(test.supabase, GOOGLE_ID)).rejects.toMatchObject({
      code: "UPLOAD_CLIENT_NOT_FOUND",
      statusCode: 404
    });
  });

  it.each([
    ["Google", GOOGLE_ID],
    ["Amazon", AMAZON_ID]
  ])("associates a new upload with %s through client_upload_assignments", async (_name, clientId) => {
    const test = client([
      { data: { id: UPLOAD_ID, uploaded_by: ACTOR_ID } },
      { data: null },
      { data: null }
    ]);

    await expect(ensureClientUploadAssignment(test.supabase, {
      actorId: ACTOR_ID,
      clientId,
      uploadBatchId: UPLOAD_ID
    })).resolves.toEqual({ created: true });

    const insertBuilder = (test.from.mock.results[2]?.value ?? {}) as { insert?: ReturnType<typeof vi.fn> };
    expect(insertBuilder.insert).toHaveBeenCalledWith({
      client_id: clientId,
      upload_batch_id: UPLOAD_ID,
      assigned_by: ACTOR_ID
    });
  });

  it("keeps retry idempotent without creating a duplicate assignment", async () => {
    const test = client([
      { data: { id: UPLOAD_ID, uploaded_by: ACTOR_ID } },
      { data: { client_id: GOOGLE_ID, upload_batch_id: UPLOAD_ID } }
    ]);

    await expect(ensureClientUploadAssignment(test.supabase, {
      actorId: ACTOR_ID,
      clientId: GOOGLE_ID,
      uploadBatchId: UPLOAD_ID
    })).resolves.toEqual({ created: false });
    expect(test.from).toHaveBeenCalledTimes(2);
  });

  it("rejects a retry that attempts to move the upload to another company", async () => {
    const test = client([
      { data: { id: UPLOAD_ID, uploaded_by: ACTOR_ID } },
      { data: { client_id: GOOGLE_ID, upload_batch_id: UPLOAD_ID } }
    ]);

    await expect(ensureClientUploadAssignment(test.supabase, {
      actorId: ACTOR_ID,
      clientId: AMAZON_ID,
      uploadBatchId: UPLOAD_ID
    })).rejects.toMatchObject({ code: "UPLOAD_CLIENT_CONFLICT", statusCode: 409 });
  });

  it("rejects an upload outside the actor RLS scope", async () => {
    const test = client([{ data: null }]);

    await expect(ensureClientUploadAssignment(test.supabase, {
      actorId: ACTOR_ID,
      clientId: GOOGLE_ID,
      uploadBatchId: UPLOAD_ID
    })).rejects.toMatchObject({ code: "PERMISSION_ERROR", statusCode: 403 });
  });

  it("resolves a unique-key race idempotently without duplicating the row", async () => {
    const test = client([
      { data: { id: UPLOAD_ID, uploaded_by: ACTOR_ID } },
      { data: null },
      { error: { code: "23505" } },
      { data: { client_id: GOOGLE_ID, upload_batch_id: UPLOAD_ID } }
    ]);

    await expect(ensureClientUploadAssignment(test.supabase, {
      actorId: ACTOR_ID,
      clientId: GOOGLE_ID,
      uploadBatchId: UPLOAD_ID
    })).resolves.toEqual({ created: false });
    expect(test.from).toHaveBeenCalledTimes(4);
  });
});
