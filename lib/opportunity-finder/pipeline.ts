/**
 * Increment this value whenever a parser, classifier, matcher, or export change
 * makes results from an older Opportunity Finder pipeline unsafe to reuse.
 *
 * This is intentionally independent from the Git commit and deployment ID.
 */
export const OPPORTUNITY_FINDER_PIPELINE_VERSION = "4";

const IDEMPOTENCY_SCOPE = "opportunity-finder";
export const OPPORTUNITY_FINDER_CONTENT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface OpportunityFinderIdempotencyFile {
  side: "A" | "B";
  contentSha256: string;
  /** Metadata is accepted for caller compatibility, but never affects identity. */
  fileName?: string;
  fileSize?: number;
  fileType?: string | null;
}

function canonicalContentHashes(
  files: OpportunityFinderIdempotencyFile[],
  comparisonMode: "single_file" | "two_files"
) {
  const expectedCount = comparisonMode === "single_file" ? 1 : 2;
  if (files.length !== expectedCount || new Set(files.map((file) => file.side)).size !== expectedCount) {
    throw new Error(comparisonMode === "single_file"
      ? "OPPORTUNITY_REQUIRES_EXACTLY_ONE_FILE_HASH"
      : "OPPORTUNITY_REQUIRES_EXACTLY_TWO_FILE_HASHES");
  }
  return [...files]
    .sort((left, right) => left.side.localeCompare(right.side))
    .map((file) => {
      if (!OPPORTUNITY_FINDER_CONTENT_SHA256_PATTERN.test(file.contentSha256)) {
        throw new Error("OPPORTUNITY_FILE_HASH_INVALID");
      }
      return { side: file.side, contentSha256: file.contentSha256 };
    });
}

function canonicalClientContext(value: string | null | undefined) {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  return normalized || null;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256OpportunityFileContents(
  file: { arrayBuffer(): Promise<ArrayBuffer> }
) {
  if (!globalThis.crypto?.subtle) throw new Error("OPPORTUNITY_FILE_HASH_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return bytesToHex(new Uint8Array(digest));
}

export async function buildOpportunityFinderIdempotencyKey(input: {
  files: OpportunityFinderIdempotencyFile[];
  pipelineVersion?: string;
  clientContext?: string | null;
  comparisonMode?: "single_file" | "two_files";
  uploadedRole?: string | null;
  datasetVersion?: string | null;
  tenantScope?: string | null;
}) {
  const pipelineVersion = input.pipelineVersion ?? OPPORTUNITY_FINDER_PIPELINE_VERSION;
  const comparisonMode = input.comparisonMode ?? "two_files";
  const canonicalPayload = JSON.stringify({
    scope: IDEMPOTENCY_SCOPE,
    pipelineVersion,
    comparisonMode,
    clientContext: canonicalClientContext(input.clientContext),
    files: canonicalContentHashes(input.files, comparisonMode),
    ...(comparisonMode === "single_file" ? {
      uploadedRole: input.uploadedRole ?? null,
      datasetVersion: input.datasetVersion ?? null,
      tenantScope: input.tenantScope ?? null
    } : {})
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalPayload)
  );
  return `${IDEMPOTENCY_SCOPE}:v${pipelineVersion}:${bytesToHex(new Uint8Array(digest))}`;
}

export function opportunityFinderPipelineVersionFromKey(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^opportunity-finder:v([^:]+):[0-9a-f]{64}$/i.exec(value);
  return match?.[1] ?? null;
}
