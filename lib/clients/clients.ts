import type { UserRole } from "@/lib/types";
import { canManageClients, canViewPrivateClientIdentification } from "@/lib/security/permissions";

export type ClientStatus = "active" | "archived";

export type AccountClient = {
  id: string;
  name: string;
  description: string | null;
  industry: string | null;
  region: string | null;
  website: string | null;
  logoUrl: string | null;
  status: ClientStatus;
  fileCount: number;
  mpnCount: number;
  opportunityCount: number;
  immediateSaleCount: number;
  partialSaleCount: number;
  sourcingNeededCount: number;
  stockWithoutDemandCount: number;
  highConfidenceCount: number;
  highConfidenceTruncated: boolean;
  createdAt: string;
  updatedAt: string;
  canManage: boolean;
};

export type ClientPrivateDetails = {
  identificationImageUrl: string | null;
  internalNotes: string | null;
};

export type ClientDetail = AccountClient & {
  privateDetails: ClientPrivateDetails | null;
};

export type ClientUpload = {
  id: string;
  originalFileName: string;
  detectedCategory: string | null;
  status: string;
  totalRows: number;
  warningCount: number;
  createdAt: string;
  assignedAt: string;
};

export type ClientWriteInput = {
  name: string;
  description: string | null;
  industry: string | null;
  region: string | null;
  website: string | null;
};

export function cleanClientText(value: unknown, max = 240) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

export function isUuid(value: string | null | undefined) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

export function parseClientWriteInput(value: unknown): ClientWriteInput | null {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const name = cleanClientText(input.name, 160);
  if (!name) return null;

  const website = cleanClientText(input.website, 320);
  if (website && !/^https?:\/\/[^\s]+$/i.test(website)) return null;

  return {
    name,
    description: cleanClientText(input.description, 1200),
    industry: cleanClientText(input.industry, 160),
    region: cleanClientText(input.region, 160),
    website
  };
}

export function clientCapabilities(role: UserRole) {
  return {
    canManage: canManageClients(role),
    canAssignUploads: canManageClients(role),
    canArchive: canManageClients(role),
    canViewPrivateIdentification: canViewPrivateClientIdentification(role)
  };
}
