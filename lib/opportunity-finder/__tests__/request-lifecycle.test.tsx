// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import OpportunityFinder from "@/components/opportunity-finder/OpportunityFinder";

vi.mock("@/lib/opportunity-finder/pipeline", async () => {
  const actual = await vi.importActual<typeof import("@/lib/opportunity-finder/pipeline")>(
    "@/lib/opportunity-finder/pipeline"
  );
  return {
    ...actual,
    sha256OpportunityFileContents: vi.fn(async () => "a".repeat(64))
  };
});

class TestXMLHttpRequest {
  static instances: TestXMLHttpRequest[] = [];
  static autoComplete = true;

  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  status = 0;
  onload: ((event: ProgressEvent) => void) | null = null;
  onerror: ((event: ProgressEvent) => void) | null = null;
  onabort: ((event: ProgressEvent) => void) | null = null;

  open() {}

  send() {
    TestXMLHttpRequest.instances.push(this);
    if (TestXMLHttpRequest.autoComplete) queueMicrotask(() => this.complete());
  }

  abort() {
    this.onabort?.(new ProgressEvent("abort"));
  }

  complete(status = 200) {
    this.status = status;
    this.upload.onprogress?.(new ProgressEvent("progress", {
      lengthComputable: true,
      loaded: 1,
      total: 1
    }));
    this.onload?.(new ProgressEvent("load"));
  }
}

function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: vi.fn(async () => payload)
  } as unknown as Response;
}

function apiFile(id: string, side: "A" | "B", originalFileName: string) {
  return {
    id,
    side,
    originalFileName,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 10,
    detectedType: side === "A" ? "demand" : "stock",
    selectedRole: side === "A" ? "demand" : "stock",
    classificationScore: 1,
    classificationReasons: [],
    sheets: [],
    sheetCount: 1,
    rowCount: 1,
    usefulRowCount: 1,
    hiddenRowCount: 0,
    templateType: null,
    mappingVersion: null,
    columnMappings: [],
    warnings: [],
    errors: [],
    actualSizeBytes: 10,
    contentVerified: true,
    validationStatus: "verified",
    parseStatus: "profiled",
    storageDeletedAt: null,
    sourceKind: "uploaded"
  };
}

function jobPayload(input: {
  jobId: string;
  mode: "single_file" | "two_files";
  files: ReturnType<typeof apiFile>[];
  status?: "profiling" | "awaiting_roles" | "completed" | "completed_with_warnings" | "cancelled";
  currentStage?: "inspecting_sheets" | "confirming_roles" | "finding_matches" | "completed";
  snapshotStatus?: "not_required" | "pending" | "ready" | "failed";
}) {
  const status = input.status ?? "awaiting_roles";
  const currentStage = input.currentStage ?? (
    status === "awaiting_roles"
      ? "confirming_roles"
      : status === "cancelled" || status === "completed" || status === "completed_with_warnings"
        ? "completed"
        : "inspecting_sheets"
  );
  return {
    job: {
      id: input.jobId,
      status,
      currentStage,
      progressPercent: status === "awaiting_roles" ? 40 : status === "cancelled" ? 0 : 20,
      fileARole: null,
      fileBRole: null,
      totalRowsA: 1,
      totalRowsB: input.mode === "two_files" ? 1 : 0,
      processedRows: 0,
      resultCount: 0,
      warningCount: 0,
      clientContext: null,
      summary: {},
      errorCode: null,
      pipelineVersion: "4",
      createdAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-17T00:00:00.000Z",
      comparisonMode: input.mode,
      snapshotStatus: input.snapshotStatus ?? (input.mode === "single_file" ? "pending" : "not_required")
    },
    files: input.files,
    results: [],
    possibleMatches: [],
    rejectedRows: [],
    capabilities: { canViewPricing: false, canViewFinancials: false },
    page: { offset: 0, limit: 48, total: 0 }
  };
}

function selectFiles(view: ReturnType<typeof render>, mode: "single_file" | "two_files", names: string[]) {
  fireEvent.click(screen.getByRole("button", {
    name: mode === "single_file" ? "Usar un archivo" : "Comparar dos archivos"
  }));
  const inputs = Array.from(view.container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  names.forEach((name, index) => {
    fireEvent.change(inputs[index], {
      target: { files: [new File([name], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })] }
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Subir y analizar archivos" }));
}

function trackUnhandled() {
  const handler = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
  window.addEventListener("unhandledrejection", handler);
  return {
    handler,
    stop: () => window.removeEventListener("unhandledrejection", handler)
  };
}

beforeEach(() => {
  TestXMLHttpRequest.instances = [];
  TestXMLHttpRequest.autoComplete = true;
  vi.stubGlobal("XMLHttpRequest", TestXMLHttpRequest);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Opportunity Finder request lifecycle", () => {
  it("prepares a single first file with no unhandled rejection", async () => {
    const unhandled = trackUnhandled();
    const files = [apiFile("file-a", "A", "demand.xlsx")];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/opportunity-finder/jobs" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ jobId: "job-1", files: [{ id: "file-a", side: "A", signedUrl: "https://storage.test/a" }] }));
      }
      if (url === "/api/opportunity-finder/jobs/job-1/profile") return Promise.resolve(jsonResponse({ jobId: "job-1" }));
      if (url.startsWith("/api/opportunity-finder/jobs/job-1?")) return Promise.resolve(jsonResponse(jobPayload({ jobId: "job-1", mode: "single_file", files })));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "single_file", ["demand.xlsx"]);

    expect(await screen.findByText("demand.xlsx")).toBeTruthy();
    expect(TestXMLHttpRequest.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/opportunity-finder/jobs/job-1/profile", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }));
    expect(unhandled.handler).not.toHaveBeenCalled();
    unhandled.stop();
  });

  it("prepares the first and second files in the same controlled upload", async () => {
    const files = [apiFile("file-a", "A", "demand.xlsx"), apiFile("file-b", "B", "stock.xlsx")];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/opportunity-finder/jobs" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ jobId: "job-2", files: [
          { id: "file-a", side: "A", signedUrl: "https://storage.test/a" },
          { id: "file-b", side: "B", signedUrl: "https://storage.test/b" }
        ] }));
      }
      if (url === "/api/opportunity-finder/jobs/job-2/profile") return Promise.resolve(jsonResponse({ jobId: "job-2" }));
      if (url.startsWith("/api/opportunity-finder/jobs/job-2?")) return Promise.resolve(jsonResponse(jobPayload({ jobId: "job-2", mode: "two_files", files })));
      throw new Error(`Unexpected request: ${url}`);
    }));

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "two_files", ["demand.xlsx", "stock.xlsx"]);

    expect(await screen.findByText("demand.xlsx")).toBeTruthy();
    expect(screen.getByText("stock.xlsx")).toBeTruthy();
    expect(TestXMLHttpRequest.instances).toHaveLength(2);
  });

  it("aborts the old profiling request cleanly before starting a replacement", async () => {
    const unhandled = trackUnhandled();
    let jobCounter = 0;
    const firstProfileAborted = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/opportunity-finder/jobs" && init?.method === "POST") {
        jobCounter += 1;
        const jobId = `job-${jobCounter}`;
        return Promise.resolve(jsonResponse({ jobId, files: [{ id: `file-${jobCounter}`, side: "A", signedUrl: `https://storage.test/${jobCounter}` }] }));
      }
      if (url === "/api/opportunity-finder/jobs/job-1/profile") {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => {
            firstProfileAborted();
            reject(signal.reason);
          }, { once: true });
        });
      }
      if (url.startsWith("/api/opportunity-finder/jobs/job-1?")) {
        return Promise.resolve(jsonResponse(jobPayload({ jobId: "job-1", mode: "single_file", files: [apiFile("file-1", "A", "first.xlsx")], status: "profiling" })));
      }
      if (url === "/api/opportunity-finder/jobs/job-2/profile") return Promise.resolve(jsonResponse({ jobId: "job-2" }));
      if (url.startsWith("/api/opportunity-finder/jobs/job-2?")) {
        return Promise.resolve(jsonResponse(jobPayload({ jobId: "job-2", mode: "single_file", files: [apiFile("file-2", "A", "replacement.xlsx")] })));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "single_file", ["first.xlsx"]);
    const startAnother = await screen.findByRole("button", { name: "Empezar otra comparación" });
    fireEvent.click(startAnother);
    await waitFor(() => expect(firstProfileAborted).toHaveBeenCalledTimes(1));

    selectFiles(view, "single_file", ["replacement.xlsx"]);
    expect(await screen.findByText("replacement.xlsx")).toBeTruthy();
    expect(unhandled.handler).not.toHaveBeenCalled();
    unhandled.stop();
  });

  it("treats leaving the Finder during profiling as an expected abort", async () => {
    const unhandled = trackUnhandled();
    const profileAborted = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/opportunity-finder/jobs") return Promise.resolve(jsonResponse({ jobId: "job-exit", files: [{ id: "file-a", side: "A", signedUrl: "https://storage.test/a" }] }));
      if (url === "/api/opportunity-finder/jobs/job-exit/profile") {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => {
            profileAborted();
            reject(signal.reason);
          }, { once: true });
        });
      }
      if (url.startsWith("/api/opportunity-finder/jobs/job-exit?")) return Promise.resolve(jsonResponse(jobPayload({ jobId: "job-exit", mode: "single_file", files: [apiFile("file-a", "A", "exit.xlsx")], status: "profiling" })));
      throw new Error(`Unexpected request: ${url}`);
    }));

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "single_file", ["exit.xlsx"]);
    await screen.findByRole("button", { name: "Empezar otra comparación" });
    view.unmount();
    await waitFor(() => expect(profileAborted).toHaveBeenCalledTimes(1));
    expect(unhandled.handler).not.toHaveBeenCalled();
    unhandled.stop();
  });

  it("keeps at most one slow status poll active", async () => {
    let activePolls = 0;
    let maxActivePolls = 0;
    const pollAborted = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/opportunity-finder/jobs") return Promise.resolve(jsonResponse({ jobId: "job-poll", files: [{ id: "file-a", side: "A", signedUrl: "https://storage.test/a" }] }));
      if (url === "/api/opportunity-finder/jobs/job-poll/profile") return Promise.resolve(jsonResponse({ jobId: "job-poll" }));
      if (url.startsWith("/api/opportunity-finder/jobs/job-poll?")) return Promise.resolve(jsonResponse(jobPayload({ jobId: "job-poll", mode: "single_file", files: [apiFile("file-a", "A", "poll.xlsx")], status: "profiling" })));
      if (url === "/api/opportunity-finder/jobs/job-poll/status") {
        activePolls += 1;
        maxActivePolls = Math.max(maxActivePolls, activePolls);
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => {
            activePolls -= 1;
            pollAborted();
            reject(signal.reason);
          }, { once: true });
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "single_file", ["poll.xlsx"]);
    await screen.findByRole("button", { name: "Empezar otra comparación" });
    await waitFor(() => expect(activePolls).toBe(1), { timeout: 4000 });
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(maxActivePolls).toBe(1);
    view.unmount();
    await waitFor(() => expect(pollAborted).toHaveBeenCalledTimes(1));
  }, 10000);

  it("shows a real HTTP 500 instead of treating it as an abort", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/opportunity-finder/jobs") {
        return Promise.resolve(jsonResponse({ errorCode: "JOB_CREATE_FAILED" }, false));
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }));

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "single_file", ["http-500.xlsx"]);
    expect(await screen.findByText("No se pudo crear la comparación en Supabase. Revisa el esquema y vuelve a intentar.")).toBeTruthy();
  });

  it("shows a real Supabase/network rejection instead of treating it as an abort", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/opportunity-finder/jobs") {
        return Promise.reject(new Error("PGRST_CONNECTION_FAILURE"));
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }));

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "single_file", ["supabase-error.xlsx"]);
    expect(await screen.findByText("No se pudo completar la operación.")).toBeTruthy();
  });

  it("cancels an active profile cleanly when the user presses cancel", async () => {
    const unhandled = trackUnhandled();
    let cancelled = false;
    const profileAborted = vi.fn();
    const cancelCalled = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/opportunity-finder/jobs") return Promise.resolve(jsonResponse({ jobId: "job-cancel", files: [{ id: "file-a", side: "A", signedUrl: "https://storage.test/a" }] }));
      if (url === "/api/opportunity-finder/jobs/job-cancel/profile") {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => {
            profileAborted();
            reject(signal.reason);
          }, { once: true });
        });
      }
      if (url === "/api/opportunity-finder/jobs/job-cancel/cancel") {
        cancelled = true;
        cancelCalled();
        return Promise.resolve(jsonResponse({ jobId: "job-cancel", status: "cancelled" }));
      }
      if (url.startsWith("/api/opportunity-finder/jobs/job-cancel?")) return Promise.resolve(jsonResponse(jobPayload({
        jobId: "job-cancel",
        mode: "single_file",
        files: [apiFile("file-a", "A", "cancel.xlsx")],
        status: cancelled ? "cancelled" : "profiling"
      })));
      throw new Error(`Unexpected request: ${url}`);
    }));

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "single_file", ["cancel.xlsx"]);
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(profileAborted).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cancelCalled).toHaveBeenCalledTimes(1));
    expect(unhandled.handler).not.toHaveBeenCalled();
    unhandled.stop();
  });

  it("hands a reused snapshot job off without requesting a snapshot from stale data", async () => {
    const provisionalJobId = "job-provisional";
    const existingJobId = "job-existing";
    const files = [apiFile("file-a", "A", "handoff.xlsx")];
    let profiled = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/opportunity-finder/jobs" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({
          jobId: provisionalJobId,
          files: [{ id: "file-a", side: "A", signedUrl: "https://storage.test/a" }]
        }));
      }
      if (url === `/api/opportunity-finder/jobs/${provisionalJobId}/profile`) {
        profiled = true;
        return Promise.resolve(jsonResponse({ jobId: provisionalJobId }));
      }
      if (url.startsWith(`/api/opportunity-finder/jobs/${provisionalJobId}?`)) {
        return Promise.resolve(jsonResponse(jobPayload({
          jobId: provisionalJobId,
          mode: "single_file",
          files,
          status: profiled ? "awaiting_roles" : "profiling",
          currentStage: profiled ? "finding_matches" : "inspecting_sheets",
          snapshotStatus: "pending"
        })));
      }
      if (url === `/api/opportunity-finder/jobs/${provisionalJobId}/snapshot`) {
        return Promise.resolve(jsonResponse({
          code: "COMPARISON_ALREADY_EXISTS",
          errorCode: "COMPARISON_ALREADY_EXISTS",
          jobId: existingJobId,
          reusedExistingJob: true
        }, false, 409));
      }
      if (url.startsWith(`/api/opportunity-finder/jobs/${existingJobId}?`)) {
        return Promise.resolve(jsonResponse(jobPayload({
          jobId: existingJobId,
          mode: "single_file",
          files,
          status: "completed",
          currentStage: "completed",
          snapshotStatus: "ready"
        })));
      }
      if (url === `/api/opportunity-finder/jobs/${existingJobId}/snapshot`) {
        throw new Error("stale snapshot request reached the reused job");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "single_file", ["handoff.xlsx"]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/opportunity-finder/jobs/${provisionalJobId}/snapshot`,
      { method: "POST" }
    ));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) =>
      String(input).startsWith(`/api/opportunity-finder/jobs/${existingJobId}?`)
    )).toBe(true));
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input) === `/api/opportunity-finder/jobs/${provisionalJobId}/snapshot`
    )).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input) === `/api/opportunity-finder/jobs/${existingJobId}/snapshot`
    )).toBe(false);
  });

  it("completes the single-file UI lifecycle with a valid XLSX and zero matches", async () => {
    const jobId = "job-zero-matches";
    const files = [apiFile("file-zero", "A", "zero-matches.xlsx")];
    let profiled = false;
    let confirmed = false;
    let snapshotted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/opportunity-finder/jobs" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({
          jobId,
          files: [{ id: "file-zero", side: "A", signedUrl: "https://storage.test/zero" }]
        }));
      }
      if (url === `/api/opportunity-finder/jobs/${jobId}/profile`) {
        profiled = true;
        return Promise.resolve(jsonResponse({ jobId }));
      }
      if (url === `/api/opportunity-finder/jobs/${jobId}/confirm`) {
        confirmed = true;
        return Promise.resolve(jsonResponse({ jobId, status: "awaiting_roles" }));
      }
      if (url === `/api/opportunity-finder/jobs/${jobId}/snapshot`) {
        snapshotted = true;
        return Promise.resolve(jsonResponse({ jobId, status: "queued", snapshotStatus: "ready" }));
      }
      if (url.startsWith(`/api/opportunity-finder/jobs/${jobId}?`)) {
        if (snapshotted) {
          return Promise.resolve(jsonResponse(jobPayload({
            jobId,
            mode: "single_file",
            files,
            status: "completed",
            currentStage: "completed",
            snapshotStatus: "ready"
          })));
        }
        if (confirmed) {
          return Promise.resolve(jsonResponse(jobPayload({
            jobId,
            mode: "single_file",
            files,
            status: "awaiting_roles",
            currentStage: "finding_matches",
            snapshotStatus: "pending"
          })));
        }
        return Promise.resolve(jsonResponse(jobPayload({
          jobId,
          mode: "single_file",
          files,
          status: profiled ? "awaiting_roles" : "profiling",
          currentStage: profiled ? "confirming_roles" : "inspecting_sheets",
          snapshotStatus: "pending"
        })));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<LanguageProvider><OpportunityFinder /></LanguageProvider>);
    selectFiles(view, "single_file", ["zero-matches.xlsx"]);

    const findButton = await screen.findByRole("button", { name: "Buscar oportunidades" });
    await waitFor(() => expect((findButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(findButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/opportunity-finder/jobs/${jobId}/confirm`,
      expect.objectContaining({ method: "POST" })
    ));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/opportunity-finder/jobs/${jobId}/snapshot`,
      { method: "POST" }
    ));
    expect(await screen.findByText("No hay resultados para los filtros actuales.")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input) === `/api/opportunity-finder/jobs/${jobId}/snapshot`
    )).toHaveLength(1);
  });
});
