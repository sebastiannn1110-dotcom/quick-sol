import { createHash } from "node:crypto";

export const DEMO_SEED_MARKER = "QUIKSOL_DEMO_DATA_V1";
export const DEMO_APPLY_CONFIRMATION = "QUIKSOL_DEMO_DATA_ONLY";

export type DemoTechnicalRole = "admin" | "manager" | "employee";
export type DemoProfileBusinessRank =
  | "owner"
  | "manager"
  | "salesperson"
  | "sourcing_manager"
  | "sourcing_specialist";
export type DemoOrganizationRank =
  | "owner"
  | "manager"
  | "salesperson"
  | "sourcing_manager"
  | "sourcing_specialist";

export type DemoPerson = {
  key: "olivia" | "daniel" | "maya" | "jordan" | "lin" | "aya" | "chen";
  idempotencyKey: string;
  email: string;
  fullName: string;
  technicalRole: DemoTechnicalRole;
  profileBusinessRank: DemoProfileBusinessRank;
  title: string;
  organizationRank: DemoOrganizationRank;
  department: string;
  region: string;
  country: string;
  location: string;
  responsibilities: string;
  managerKey: DemoPerson["key"] | null;
};

const people: readonly DemoPerson[] = [
  {
    key: "olivia",
    idempotencyKey: "d1000000-0000-4000-8000-000000000001",
    email: "olivia.mercer@quiksol.demo.invalid",
    fullName: "Olivia Mercer — DEMO",
    technicalRole: "admin",
    profileBusinessRank: "owner",
    title: "Owner — DEMO",
    organizationRank: "owner",
    department: "Executive — DEMO",
    region: "Global — DEMO",
    country: "United States",
    location: "Miami — DEMO",
    responsibilities: `${DEMO_SEED_MARKER}: demo organization oversight.`,
    managerKey: null
  },
  {
    key: "daniel",
    idempotencyKey: "d1000000-0000-4000-8000-000000000002",
    email: "daniel.brooks@quiksol.demo.invalid",
    fullName: "Daniel Brooks — DEMO",
    technicalRole: "manager",
    profileBusinessRank: "manager",
    title: "Sales Manager Americas — DEMO",
    organizationRank: "manager",
    department: "Sales — DEMO",
    region: "Americas — DEMO",
    country: "United States",
    location: "Miami — DEMO",
    responsibilities: `${DEMO_SEED_MARKER}: demo sales team coordination.`,
    managerKey: "olivia"
  },
  {
    key: "maya",
    idempotencyKey: "d1000000-0000-4000-8000-000000000003",
    email: "maya.torres@quiksol.demo.invalid",
    fullName: "Maya Torres — DEMO",
    technicalRole: "employee",
    profileBusinessRank: "salesperson",
    title: "Sales Representative — DEMO",
    organizationRank: "salesperson",
    department: "Sales — DEMO",
    region: "Americas — DEMO",
    country: "Colombia",
    location: "Bogotá — DEMO",
    responsibilities: `${DEMO_SEED_MARKER}: owns the NovaCircuit demo RFQ and quote.`,
    managerKey: "daniel"
  },
  {
    key: "jordan",
    idempotencyKey: "d1000000-0000-4000-8000-000000000004",
    email: "jordan.lee@quiksol.demo.invalid",
    fullName: "Jordan Lee — DEMO",
    technicalRole: "employee",
    profileBusinessRank: "salesperson",
    title: "Sales Representative — DEMO",
    organizationRank: "salesperson",
    department: "Sales — DEMO",
    region: "Americas — DEMO",
    country: "United States",
    location: "Austin — DEMO",
    responsibilities: `${DEMO_SEED_MARKER}: demo commercial coverage.`,
    managerKey: "daniel"
  },
  {
    key: "lin",
    idempotencyKey: "d1000000-0000-4000-8000-000000000005",
    email: "lin.wei@quiksol.demo.invalid",
    fullName: "Lin Wei — DEMO",
    technicalRole: "manager",
    profileBusinessRank: "sourcing_manager",
    title: "Sourcing Manager Asia — DEMO",
    organizationRank: "sourcing_manager",
    department: "Sourcing — DEMO",
    region: "APAC — DEMO",
    country: "Singapore",
    location: "Singapore — DEMO",
    responsibilities: `${DEMO_SEED_MARKER}: approves the fictional supplier offer.`,
    managerKey: "olivia"
  },
  {
    key: "aya",
    idempotencyKey: "d1000000-0000-4000-8000-000000000006",
    email: "aya.nakamura@quiksol.demo.invalid",
    fullName: "Aya Nakamura — DEMO",
    technicalRole: "employee",
    profileBusinessRank: "sourcing_specialist",
    title: "Sourcing Specialist — DEMO",
    organizationRank: "sourcing_specialist",
    department: "Sourcing — DEMO",
    region: "APAC — DEMO",
    country: "Singapore",
    location: "Singapore — DEMO",
    responsibilities: `${DEMO_SEED_MARKER}: demo supplier research.`,
    managerKey: "lin"
  },
  {
    key: "chen",
    idempotencyKey: "d1000000-0000-4000-8000-000000000007",
    email: "chen.rui@quiksol.demo.invalid",
    fullName: "Chen Rui — DEMO",
    technicalRole: "employee",
    profileBusinessRank: "sourcing_specialist",
    title: "Sourcing Specialist — DEMO",
    organizationRank: "sourcing_specialist",
    department: "Sourcing — DEMO",
    region: "APAC — DEMO",
    country: "Singapore",
    location: "Singapore — DEMO",
    responsibilities: `${DEMO_SEED_MARKER}: demo order operations.`,
    managerKey: "lin"
  }
] as const;

const rfqFingerprint = createHash("sha256")
  .update(
    JSON.stringify({
      externalRfqId: "RFQ-DEMO-0001",
      customer: "NovaCircuit Systems S.A.S. — DEMO",
      mpn: "QKS-DEMO-MCU-042",
      quantity: 1200,
      targetPrice: 4.8,
      currency: "USD"
    })
  )
  .digest("hex");

export const DEMO_DATA_MANIFEST = Object.freeze({
  marker: DEMO_SEED_MARKER,
  fixedTimestamp: "2026-08-29T12:00:00.000Z",
  validUntil: "2099-12-31T23:59:59.000Z",
  quoteValidUntil: "2099-12-31",
  people,
  ids: Object.freeze({
    client: "d0000000-0000-4000-8000-000000000001",
    catalogProduct: "d0000000-0000-4000-8000-000000000002",
    rfq: "d0000000-0000-4000-8000-000000000003",
    rfqItem: "d0000000-0000-4000-8000-000000000004",
    sourcingRequest: "d0000000-0000-4000-8000-000000000005",
    sourcingOffer: "d0000000-0000-4000-8000-000000000006",
    priceApproval: "d0000000-0000-4000-8000-000000000007",
    quote: "d0000000-0000-4000-8000-000000000008",
    quoteItem: "d0000000-0000-4000-8000-000000000009"
  }),
  customer: Object.freeze({
    externalId: "DEMO-NOVACIRCUIT",
    name: "NovaCircuit Systems S.A.S. — DEMO",
    description: `${DEMO_SEED_MARKER}: fictional customer for commercial demonstrations.`,
    industry: "Electronics manufacturing — DEMO",
    region: "LATAM — DEMO",
    contactName: "Adrian Vega",
    contactEmail: "adrian.vega@novacircuit.demo.invalid",
    country: "Colombia",
    city: "Bogotá",
    language: "es"
  }),
  product: Object.freeze({
    mpn: "QKS-DEMO-MCU-042",
    normalizedMpn: "QKSDEMO042",
    manufacturer: "Asterion Microdevices — DEMO",
    description: `Industrial control MCU — ${DEMO_SEED_MARKER}`,
    demandQuantity: 1200,
    targetUnitPrice: 4.8,
    authorizedUnitPrice: 4.65,
    currency: "USD",
    availableQuantity: 1500,
    minimumOrderQuantity: 500,
    leadTimeDays: 7
  }),
  supplierOffer: Object.freeze({
    supplierName: "Pacific Demo Components Pte. Ltd. — fictional DEMO",
    reference: "DEMO-OFFER-0001",
    rawUnitCost: 3.1,
    countryOfOrigin: "Singapore",
    condition: "New — DEMO"
  }),
  rfq: Object.freeze({
    externalId: "RFQ-DEMO-0001",
    fingerprint: rfqFingerprint
  }),
  quote: Object.freeze({
    number: "QKS-DEMO-0001",
    quantity: 1200,
    unitPrice: 4.65,
    subtotal: 5580,
    taxRate: 7,
    tax: 390.6,
    total: 5970.6,
    version: 3,
    status: "accepted"
  }),
  expectedMetrics: Object.freeze({
    createdQuotes: 1,
    sentQuotes: 1,
    acceptedQuotes: 1,
    conversionRatePercent: 100,
    acceptedQuoteValueUsd: 5970.6
  })
});

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateDemoManifest() {
  const manifest = DEMO_DATA_MANIFEST;
  const allIds = [...Object.values(manifest.ids), ...manifest.people.map((person) => person.idempotencyKey)];
  if (new Set(allIds).size !== allIds.length || allIds.some((id) => !uuidV4Pattern.test(id))) {
    throw new Error("DEMO_MANIFEST_INVALID_IDS");
  }

  if (manifest.people.some((person) => !person.email.endsWith(".demo.invalid"))) {
    throw new Error("DEMO_MANIFEST_EMAIL_DOMAIN_REQUIRED");
  }
  if (!manifest.customer.contactEmail.endsWith(".demo.invalid")) {
    throw new Error("DEMO_MANIFEST_CUSTOMER_EMAIL_DOMAIN_REQUIRED");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.rfq.fingerprint)) {
    throw new Error("DEMO_MANIFEST_INVALID_RFQ_FINGERPRINT");
  }

  const subtotal = Number((manifest.quote.quantity * manifest.quote.unitPrice).toFixed(2));
  const tax = Number((subtotal * (manifest.quote.taxRate / 100)).toFixed(2));
  const total = Number((subtotal + tax).toFixed(2));
  if (subtotal !== manifest.quote.subtotal || tax !== manifest.quote.tax || total !== manifest.quote.total) {
    throw new Error("DEMO_MANIFEST_INVALID_TOTALS");
  }

  const personKeys = new Set(manifest.people.map((person) => person.key));
  if (manifest.people.some((person) => person.managerKey && !personKeys.has(person.managerKey))) {
    throw new Error("DEMO_MANIFEST_INVALID_MANAGER");
  }
  if (manifest.people.filter((person) => person.organizationRank === "owner").length !== 1) {
    throw new Error("DEMO_MANIFEST_REQUIRES_ONE_OWNER");
  }

  return manifest;
}
