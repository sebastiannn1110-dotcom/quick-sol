/**
 * Increment this value whenever a parser, classifier, matcher, or export change
 * makes results from an older Opportunity Finder pipeline unsafe to reuse.
 *
 * This is intentionally independent from the Git commit and deployment ID.
 */
export const OPPORTUNITY_FINDER_PIPELINE_VERSION = "2";

const IDEMPOTENCY_SCOPE = "opportunity-finder";

export interface OpportunityFinderIdempotencyFile {
  side: "A" | "B";
  fileName: string;
  fileSize: number;
  fileType?: string | null;
}

function canonicalFile(file: OpportunityFinderIdempotencyFile) {
  return {
    side: file.side,
    fileName: file.fileName.trim().normalize("NFC"),
    fileSize: file.fileSize,
    fileType: (file.fileType ?? "").trim().toLowerCase()
  };
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildOpportunityFinderIdempotencyKey(input: {
  attemptId: string;
  files: OpportunityFinderIdempotencyFile[];
  pipelineVersion?: string;
}) {
  const pipelineVersion = input.pipelineVersion ?? OPPORTUNITY_FINDER_PIPELINE_VERSION;
  const canonicalPayload = JSON.stringify({
    scope: IDEMPOTENCY_SCOPE,
    pipelineVersion,
    attemptId: input.attemptId.trim(),
    files: [...input.files]
      .sort((left, right) => left.side.localeCompare(right.side))
      .map(canonicalFile)
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
