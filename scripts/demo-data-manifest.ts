import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEMO_COMPANY_MEDIA,
  DEMO_MEDIA_ASSETS,
  DEMO_PERSON_MEDIA,
  type DemoMediaAsset
} from "./demo-media-manifest";

export const DEMO_SEED_MARKER = "QUIKSOL_DEMO_DATA_V1";
export const DEMO_APPLY_CONFIRMATION = "QUIKSOL_DEMO_DATA_ONLY";

export type DemoTechnicalRole = "admin" | "manager" | "employee";
export type DemoProfileBusinessRank =
  | "owner"
  | "executive"
  | "manager"
  | "salesperson"
  | "sourcing_manager"
  | "sourcing_specialist"
  | "individual_contributor";
export type DemoOrganizationRank = DemoProfileBusinessRank;
export type DemoPersonKey =
  | "olivia" | "demoOwner" | "daniel" | "maya" | "jordan" | "sofia" | "lucas" | "emma"
  | "priya" | "ethan" | "liNa" | "haruto" | "minJun" | "chloe" | "lukas" | "hannah"
  | "camille" | "oliver" | "lucia" | "lin" | "aya" | "chen" | "weiMing" | "zhaoLian"
  | "meiChen" | "yuki" | "noah" | "isabella";

export type DemoPerson = {
  key: DemoPersonKey;
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
  managerKey: DemoPersonKey | null;
  compensationAnnualUsd: number;
  media: DemoMediaAsset | null;
  avatarPath: string | null;
};

export type DemoClient = {
  key: string;
  id: string;
  externalId: string;
  name: string;
  description: string;
  industry: string;
  region: string;
  contactName: string;
  contactEmail: string;
  country: string;
  city: string;
  language: "es" | "en" | "zh";
  sellerKey: DemoPersonKey;
  media: DemoMediaAsset;
};

export type DemoRfq = {
  key: string;
  id: string;
  itemId: string;
  externalId: string;
  fingerprint: string;
  clientKey: string;
  sellerKey: DemoPersonKey;
  mpn: string;
  manufacturer: string;
  description: string;
  quantity: number;
  targetPrice: number;
};

export type DemoQuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";
export type DemoQuote = {
  key: string;
  id: string;
  itemId: string;
  number: string;
  clientKey: string;
  rfqKey: string;
  sellerKey: DemoPersonKey;
  status: DemoQuoteStatus;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
  version: number;
  createdAt: string;
  sentAt: string | null;
  validUntil: string;
};

const suffix = " \u2014 DEMO";

function demoPerson(
  key: DemoPersonKey,
  idempotencyIndex: number,
  email: string,
  name: string,
  technicalRole: DemoTechnicalRole,
  rank: DemoProfileBusinessRank,
  title: string,
  department: string,
  region: string,
  country: string,
  location: string,
  managerKey: DemoPersonKey | null,
  compensationAnnualUsd: number
): DemoPerson {
  const media = key === "demoOwner" ? null : DEMO_PERSON_MEDIA[key];
  // Preserve the 27 established Auth identities; UI helpers mask this legacy
  // technical domain so the rebranded application never presents it.
  const authEmail = key === "demoOwner"
    ? email
    : email.replace(/@demo\.invalid$/i, "@quiksol.demo.invalid");
  return Object.freeze({
    key,
    idempotencyKey: `d1000000-0000-4000-8000-${String(idempotencyIndex).padStart(12, "0")}`,
    email: authEmail,
    fullName: key === "demoOwner" ? name : `${name}${suffix}`,
    technicalRole,
    profileBusinessRank: rank,
    title: key === "demoOwner" ? title : `${title}${suffix}`,
    organizationRank: rank,
    department,
    region,
    country,
    location: key === "demoOwner" ? location : `${location}${suffix}`,
    responsibilities: `${title} responsibilities in the fictional demo organization.`,
    managerKey,
    compensationAnnualUsd,
    media,
    avatarPath: media?.localPath ?? null
  });
}

// Olivia intentionally remains first: she is the sole CLI bootstrap identity.
// Hierarchy order is independent; the presentation account is the only root and owner.
const people = [
  demoPerson("olivia", 1, "olivia.mercer@demo.invalid", "Olivia Mercer", "admin", "executive", "Chief Operating Officer / Executive Director", "Executive", "Global", "United States", "Miami", "demoOwner", 180000),
  demoPerson("demoOwner", 8, "user.test.demo.com@demo.invalid", "user.test.demo.com", "admin", "owner", "Owner / Administrator", "Executive", "Global", "Singapore", "Demo Environment", null, 220000),
  demoPerson("daniel", 2, "daniel.brooks@demo.invalid", "Daniel Brooks", "manager", "manager", "Sales Manager Americas", "Sales", "Americas", "United States", "Miami", "olivia", 142000),
  demoPerson("maya", 3, "maya.torres@demo.invalid", "Maya Torres", "employee", "salesperson", "Sales Representative", "Sales", "Americas", "Colombia", "Bogot\u00e1", "daniel", 88000),
  demoPerson("jordan", 4, "jordan.lee@demo.invalid", "Jordan Lee", "employee", "salesperson", "Account Executive", "Sales", "Americas", "United States", "Austin", "daniel", 82000),
  demoPerson("sofia", 9, "sofia.ramirez@demo.invalid", "Sofia Ramirez", "employee", "salesperson", "Sales Representative Mexico", "Sales", "Americas", "Mexico", "Monterrey", "daniel", 76000),
  demoPerson("lucas", 10, "lucas.almeida@demo.invalid", "Lucas Almeida", "employee", "salesperson", "Sales Representative Brazil", "Sales", "Americas", "Brazil", "S\u00e3o Paulo", "daniel", 74000),
  demoPerson("emma", 11, "emma.clarke@demo.invalid", "Emma Clarke", "employee", "salesperson", "Account Executive Canada", "Sales", "Americas", "Canada", "Toronto", "daniel", 90000),
  demoPerson("priya", 12, "priya.nair@demo.invalid", "Priya Nair", "manager", "manager", "Sales Manager APAC", "Sales", "APAC", "Singapore", "Singapore", "olivia", 138000),
  demoPerson("ethan", 13, "ethan.tan@demo.invalid", "Ethan Tan", "employee", "salesperson", "Account Executive Singapore", "Sales", "APAC", "Singapore", "Singapore", "priya", 93000),
  demoPerson("liNa", 14, "li.na@demo.invalid", "Li Na", "employee", "salesperson", "Sales Representative China", "Sales", "APAC", "China", "Shenzhen", "priya", 81000),
  demoPerson("haruto", 15, "haruto.sato@demo.invalid", "Haruto Sato", "employee", "salesperson", "Account Executive Japan", "Sales", "APAC", "Japan", "Tokyo", "priya", 87000),
  demoPerson("minJun", 16, "minjun.park@demo.invalid", "Min-jun Park", "employee", "salesperson", "Sales Representative South Korea", "Sales", "APAC", "South Korea", "Seoul", "priya", 79000),
  demoPerson("chloe", 17, "chloe.wilson@demo.invalid", "Chloe Wilson", "employee", "salesperson", "Account Executive Australia", "Sales", "APAC", "Australia", "Sydney", "priya", 95000),
  demoPerson("lukas", 18, "lukas.weber@demo.invalid", "Lukas Weber", "manager", "manager", "Sales Manager Europe", "Sales", "Europe", "Germany", "Munich", "olivia", 135000),
  demoPerson("hannah", 19, "hannah.fischer@demo.invalid", "Hannah Fischer", "employee", "salesperson", "Account Executive Germany", "Sales", "Europe", "Germany", "Berlin", "lukas", 92000),
  demoPerson("camille", 20, "camille.laurent@demo.invalid", "Camille Laurent", "employee", "salesperson", "Sales Representative France", "Sales", "Europe", "France", "Paris", "lukas", 78000),
  demoPerson("oliver", 21, "oliver.bennett@demo.invalid", "Oliver Bennett", "employee", "salesperson", "Account Executive United Kingdom", "Sales", "Europe", "United Kingdom", "London", "lukas", 96000),
  demoPerson("lucia", 22, "lucia.garcia@demo.invalid", "Lucia Garcia", "employee", "salesperson", "Sales Representative Spain", "Sales", "Europe", "Spain", "Madrid", "lukas", 77000),
  demoPerson("lin", 5, "lin.wei@demo.invalid", "Lin Wei", "manager", "sourcing_manager", "Sourcing Manager Asia", "Sourcing", "APAC", "Singapore", "Singapore", "olivia", 132000),
  demoPerson("aya", 6, "aya.nakamura@demo.invalid", "Aya Nakamura", "employee", "sourcing_specialist", "Sourcing Specialist Singapore", "Sourcing", "APAC", "Singapore", "Singapore", "lin", 82000),
  demoPerson("chen", 7, "chen.rui@demo.invalid", "Chen Rui", "employee", "sourcing_specialist", "Sourcing Specialist Singapore", "Sourcing", "APAC", "Singapore", "Singapore", "lin", 76000),
  demoPerson("weiMing", 23, "wei.ming@demo.invalid", "Wei Ming", "employee", "sourcing_specialist", "Sourcing Specialist Singapore", "Sourcing", "APAC", "Singapore", "Singapore", "lin", 84000),
  demoPerson("zhaoLian", 24, "zhao.lian@demo.invalid", "Zhao Lian", "employee", "sourcing_specialist", "Sourcing Specialist China", "Sourcing", "APAC", "China", "Shanghai", "lin", 79000),
  demoPerson("meiChen", 25, "mei.chen@demo.invalid", "Mei Chen", "employee", "sourcing_specialist", "Sourcing Specialist Taiwan", "Sourcing", "APAC", "Taiwan", "Taipei", "lin", 81000),
  demoPerson("yuki", 26, "yuki.tanaka@demo.invalid", "Yuki Tanaka", "employee", "sourcing_specialist", "Sourcing Specialist Japan", "Sourcing", "APAC", "Japan", "Osaka", "lin", 86000),
  demoPerson("noah", 27, "noah.williams@demo.invalid", "Noah Williams", "employee", "individual_contributor", "Operations Lead", "Operations", "Global", "Netherlands", "Rotterdam", "olivia", 98000),
  demoPerson("isabella", 28, "isabella.rossi@demo.invalid", "Isabella Rossi", "employee", "individual_contributor", "Customer Success Lead", "Customer Success", "Global", "Italy", "Milan", "olivia", 102000)
] as const satisfies readonly DemoPerson[];

const originalIds = Object.freeze({
  client: "d0000000-0000-4000-8000-000000000001",
  catalogProduct: "d0000000-0000-4000-8000-000000000002",
  rfq: "d0000000-0000-4000-8000-000000000003",
  rfqItem: "d0000000-0000-4000-8000-000000000004",
  sourcingRequest: "d0000000-0000-4000-8000-000000000005",
  sourcingOffer: "d0000000-0000-4000-8000-000000000006",
  priceApproval: "d0000000-0000-4000-8000-000000000007",
  quote: "d0000000-0000-4000-8000-000000000008",
  quoteItem: "d0000000-0000-4000-8000-000000000009"
});

function deterministicUuid(prefix: string, index: number) {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function demoClient(
  index: number,
  key: keyof typeof DEMO_COMPANY_MEDIA,
  externalId: string,
  name: string,
  industry: string,
  region: string,
  contactName: string,
  contactEmail: string,
  country: string,
  city: string,
  language: DemoClient["language"],
  sellerKey: DemoPersonKey
): DemoClient {
  return Object.freeze({
    key,
    id: index === 1 ? originalIds.client : deterministicUuid("d3000000", index),
    externalId,
    name,
    description: `Fictitious demo account \u2014 no commercial affiliation implied.`,
    industry: `${industry}${suffix}`,
    region,
    contactName,
    contactEmail,
    country,
    city,
    language,
    sellerKey,
    media: DEMO_COMPANY_MEDIA[key]
  });
}

const clients = [
  demoClient(1, "novaCircuit", "DEMO-AMAZON", "Amazon-demo", "Logistics technology", "LATAM", "Adrian Vega", "adrian.vega@amazon-demo.demo.invalid", "Colombia", "Bogot\u00e1", "es", "maya"),
  demoClient(2, "atlasRobotics", "DEMO-GOOGLE", "Google-demo", "Data center technology", "North America", "Nora Hayes", "nora.hayes@google-demo.demo.invalid", "United States", "Boston", "en", "maya"),
  demoClient(3, "andinaControls", "DEMO-MICROSOFT", "Microsoft-demo", "Enterprise technology", "LATAM", "Diego Pardo", "diego.pardo@microsoft-demo.demo.invalid", "Colombia", "Medell\u00edn", "es", "maya"),
  demoClient(4, "northStarDevices", "DEMO-APPLE", "Apple-demo", "Consumer electronics", "North America", "Avery Reed", "avery.reed@apple-demo.demo.invalid", "United States", "Denver", "en", "maya"),
  demoClient(5, "pacificaEnergy", "DEMO-NVIDIA", "Nvidia-demo", "Computing hardware", "North America", "Megan Cole", "megan.cole@nvidia-demo.demo.invalid", "United States", "San Diego", "en", "maya"),
  demoClient(6, "mapleGrid", "DEMO-INTEL", "Intel-demo", "Semiconductor manufacturing", "North America", "Evan Scott", "evan.scott@intel-demo.demo.invalid", "Canada", "Toronto", "en", "jordan"),
  demoClient(7, "blueMesa", "DEMO-SAMSUNG", "Samsung-demo", "Electronics manufacturing", "North America", "Taylor Morgan", "taylor.morgan@samsung-demo.demo.invalid", "United States", "Phoenix", "en", "jordan"),
  demoClient(8, "libertyMotion", "DEMO-SONY", "Sony-demo", "Consumer electronics", "North America", "Casey Brooks", "casey.brooks@sony-demo.demo.invalid", "United States", "Chicago", "en", "jordan"),
  demoClient(9, "lionCity", "DEMO-DELL", "Dell-demo", "Enterprise computing", "APAC", "Amelia Lim", "amelia.lim@dell-demo.demo.invalid", "Singapore", "Singapore", "en", "ethan"),
  demoClient(10, "pearlRiver", "DEMO-HP", "HP-demo", "Computing hardware", "APAC", "Tao Xu", "tao.xu@hp-demo.demo.invalid", "China", "Shenzhen", "zh", "ethan"),
  demoClient(11, "meridianSemi", "DEMO-IBM", "IBM-demo", "Enterprise technology", "APAC", "Grace Ong", "grace.ong@ibm-demo.demo.invalid", "Singapore", "Singapore", "en", "ethan"),
  demoClient(12, "rheinWerk", "DEMO-CISCO", "Cisco-demo", "Network infrastructure", "Europe", "Jonas Keller", "jonas.keller@cisco-demo.demo.invalid", "Germany", "Munich", "en", "hannah"),
  demoClient(13, "hexagon", "DEMO-ORACLE", "Oracle-demo", "Enterprise infrastructure", "Europe", "Claire Martin", "claire.martin@oracle-demo.demo.invalid", "France", "Lyon", "en", "hannah"),
  demoClient(14, "euroNova", "DEMO-QUALCOMM", "Qualcomm-demo", "Semiconductors", "Europe", "Marco Bianchi", "marco.bianchi@qualcomm-demo.demo.invalid", "Italy", "Turin", "en", "hannah"),
  demoClient(15, "azteca", "DEMO-SIEMENS", "Siemens-demo", "Industrial automation", "LATAM", "Valeria Cruz", "valeria.cruz@siemens-demo.demo.invalid", "Mexico", "Monterrey", "es", "sofia"),
  demoClient(16, "sakura", "DEMO-BOSCH", "Bosch-demo", "Industrial electronics", "APAC", "Ren Ito", "ren.ito@bosch-demo.demo.invalid", "Japan", "Tokyo", "en", "haruto"),
  demoClient(17, "britannia", "DEMO-PANASONIC", "Panasonic-demo", "Electronics manufacturing", "Europe", "Emily Ward", "emily.ward@panasonic-demo.demo.invalid", "United Kingdom", "Manchester", "en", "oliver"),
  demoClient(18, "iberia", "DEMO-META", "Meta-demo", "Digital infrastructure", "Europe", "Pablo Sanz", "pablo.sanz@meta-demo.demo.invalid", "Spain", "Madrid", "es", "lucia"),
  demoClient(19, "southernCross", "DEMO-TESLA", "Tesla-demo", "Automotive electronics", "APAC", "Ruby Evans", "ruby.evans@tesla-demo.demo.invalid", "Australia", "Perth", "en", "chloe")
] as const satisfies readonly DemoClient[];

const product = Object.freeze({
  mpn: "EPD-DEMO-MCU-042",
  normalizedMpn: "EPD-DEMO-MCU-042",
  manufacturer: `Asterion Microdevices${suffix}`,
  description: `Industrial control MCU${suffix}`,
  demandQuantity: 1200,
  targetUnitPrice: 4.8,
  authorizedUnitPrice: 4.65,
  currency: "USD" as const,
  availableQuantity: 1500,
  minimumOrderQuantity: 500,
  leadTimeDays: 7
});

const rfqs = clients.map((target, zeroIndex): DemoRfq => {
  const index = zeroIndex + 1;
  const mpn = index === 1 ? product.mpn : `EPD-DEMO-PART-${String(index).padStart(3, "0")}`;
  const quantity = index === 1 ? product.demandQuantity : 500 + index * 75;
  const targetPrice = index === 1 ? product.targetUnitPrice : Number((3.25 + index * 0.37).toFixed(2));
  const externalId = `RFQ-DEMO-${String(index).padStart(4, "0")}`;
  return Object.freeze({
    key: `rfq${index}`,
    id: index === 1 ? originalIds.rfq : deterministicUuid("d4000000", index),
    itemId: index === 1 ? originalIds.rfqItem : deterministicUuid("d4100000", index),
    externalId,
    fingerprint: createHash("sha256").update(JSON.stringify({ externalRfqId: externalId, customer: target.name, mpn, quantity, targetPrice, currency: "USD" })).digest("hex"),
    clientKey: target.key,
    sellerKey: target.sellerKey,
    mpn,
    manufacturer: index === 1 ? product.manufacturer : `Electronic Parts Demo Components${suffix}`,
    description: index === 1 ? product.description : `Fictional requested component ${index}${suffix}.`,
    quantity,
    targetPrice
  });
});

type RawQuote = readonly [DemoPersonKey, string, DemoQuoteStatus, number];
const rawQuotes: readonly RawQuote[] = [
  ["maya", "novaCircuit", "accepted", 5580], ["maya", "atlasRobotics", "accepted", 12400],
  ["maya", "andinaControls", "accepted", 28750], ["maya", "northStarDevices", "accepted", 9500],
  ["maya", "pacificaEnergy", "accepted", 44200], ["maya", "novaCircuit", "accepted", 18500],
  ["maya", "atlasRobotics", "accepted", 62400], ["maya", "andinaControls", "rejected", 22000],
  ["maya", "northStarDevices", "rejected", 7800], ["maya", "pacificaEnergy", "sent", 15800],
  ["maya", "novaCircuit", "draft", 3900], ["maya", "atlasRobotics", "draft", 51200],
  ["jordan", "mapleGrid", "accepted", 7200], ["jordan", "blueMesa", "accepted", 16800],
  ["jordan", "libertyMotion", "accepted", 35500], ["jordan", "mapleGrid", "accepted", 7900],
  ["jordan", "blueMesa", "rejected", 12800], ["jordan", "libertyMotion", "rejected", 48200],
  ["jordan", "mapleGrid", "rejected", 6700], ["jordan", "blueMesa", "sent", 24600],
  ["jordan", "libertyMotion", "draft", 4200], ["ethan", "lionCity", "accepted", 8400],
  ["ethan", "pearlRiver", "accepted", 19600], ["ethan", "meridianSemi", "accepted", 33100],
  ["ethan", "lionCity", "accepted", 47000], ["ethan", "pearlRiver", "accepted", 7600],
  ["ethan", "meridianSemi", "accepted", 25800], ["ethan", "lionCity", "rejected", 14800],
  ["ethan", "pearlRiver", "expired", 39200], ["ethan", "meridianSemi", "sent", 9100],
  ["ethan", "lionCity", "draft", 3100], ["hannah", "rheinWerk", "accepted", 15600],
  ["hannah", "hexagon", "accepted", 27400], ["hannah", "euroNova", "accepted", 9200],
  ["hannah", "rheinWerk", "rejected", 18600], ["hannah", "hexagon", "expired", 55000],
  ["hannah", "euroNova", "sent", 11200], ["hannah", "rheinWerk", "draft", 5300],
  ["sofia", "azteca", "accepted", 13400], ["sofia", "azteca", "rejected", 8700],
  ["haruto", "sakura", "accepted", 6900], ["haruto", "sakura", "expired", 31600],
  ["oliver", "britannia", "sent", 17800], ["lucia", "iberia", "sent", 12800],
  ["chloe", "southernCross", "draft", 4800]
];

function addMinutes(iso: string, minutes: number) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

const quotes = rawQuotes.map(([sellerKey, clientKey, status, subtotal], zeroIndex): DemoQuote => {
  const index = zeroIndex + 1;
  const targetRfq = rfqs.find((candidate) => candidate.clientKey === clientKey)!;
  const tax = Number((subtotal * 0.07).toFixed(2));
  const createdAt = index === 1 ? "2026-08-29T12:00:00.000Z" : new Date(Date.UTC(2026, 5, index, 12)).toISOString();
  return Object.freeze({
    key: `quote${index}`,
    id: index === 1 ? originalIds.quote : deterministicUuid("d5000000", index),
    itemId: index === 1 ? originalIds.quoteItem : deterministicUuid("d5100000", index),
    number: `EPD-DEMO-${String(index).padStart(4, "0")}`,
    clientKey,
    rfqKey: targetRfq.key,
    sellerKey,
    status,
    quantity: index === 1 ? 1200 : 100,
    unitPrice: index === 1 ? 4.65 : Number((subtotal / 100).toFixed(4)),
    subtotal,
    taxRate: 7,
    tax,
    total: Number((subtotal + tax).toFixed(2)),
    version: status === "draft" ? 1 : status === "sent" ? 2 : 3,
    createdAt,
    sentAt: status === "draft" ? null : addMinutes(createdAt, 5),
    validUntil: index === 1 ? "2099-12-31" : status === "expired" ? "2026-08-01" : "2026-12-31"
  });
});

const expectedMetrics = Object.freeze({
  employees: 28,
  countries: 17,
  departments: 5,
  clients: 19,
  rfqs: 19,
  createdQuotes: 45,
  quoteItems: 45,
  quoteEvents: 117,
  sentQuotes: 39,
  acceptedQuotes: 22,
  rejectedQuotes: 8,
  expiredQuotes: 3,
  draftQuotes: 6,
  openSentQuotes: 6,
  activeSellers: 9,
  conversionRatePercent: 56.41,
  quotedValueUsd: 954365.1,
  acceptedQuoteValueUsd: 495121.1,
  customersServed: 19,
  newCustomers: 19,
  compensationRows: 28
});

export const DEMO_DATA_MANIFEST = Object.freeze({
  marker: DEMO_SEED_MARKER,
  fixedTimestamp: "2026-08-29T12:00:00.000Z",
  validUntil: "2099-12-31T23:59:59.000Z",
  quoteValidUntil: "2099-12-31",
  people,
  clients,
  customer: clients[0],
  rfqs,
  rfq: rfqs[0],
  quotes,
  quote: quotes[0],
  compensations: people.map((person) => Object.freeze({ personKey: person.key, amount: person.compensationAnnualUsd, currency: "USD" as const, periodicity: "annual" as const })),
  ids: originalIds,
  product,
  supplierOffer: Object.freeze({
    supplierName: `Pacific Demo Components Pte. Ltd.${suffix}`,
    reference: "DEMO-OFFER-0001",
    rawUnitCost: 3.1,
    countryOfOrigin: "Singapore",
    condition: `New${suffix}`
  }),
  expectedMetrics
});

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function validateDemoMediaAssets() {
  const publicRoot = path.resolve(process.cwd(), "public");
  const expectedPaths = new Set([
    ...Object.values(DEMO_PERSON_MEDIA).map((asset) => asset.localPath),
    ...Object.values(DEMO_COMPANY_MEDIA).map((asset) => asset.localPath)
  ]);
  if (
    Object.keys(DEMO_PERSON_MEDIA).length !== 27 ||
    Object.keys(DEMO_COMPANY_MEDIA).length !== 19 ||
    DEMO_MEDIA_ASSETS.length !== 46 ||
    expectedPaths.size !== 46 ||
    new Set(DEMO_MEDIA_ASSETS.map((asset) => asset.sha256)).size !== 46 ||
    new Set(DEMO_MEDIA_ASSETS.map((asset) => asset.sourcePageUrl)).size !== 46
  ) {
    throw new Error("DEMO_MANIFEST_MEDIA_CARDINALITY_INVALID");
  }

  for (const asset of DEMO_MEDIA_ASSETS) {
    const expectedDimensions = asset.localPath.startsWith("demo/people/")
      ? [512, 512]
      : [1200, 700];
    if (
      !/^demo\/(?:people|companies)\/[a-z0-9-]+\.webp$/.test(asset.localPath) ||
      !/^https:\/\//.test(asset.imageUrl) ||
      !/^https:\/\//.test(asset.sourcePageUrl) ||
      !/^https:\/\//.test(asset.licenseUrl) ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !asset.credit.trim() ||
      asset.assetType !== "conventional-stock-photo" ||
      asset.aiGenerated !== false ||
      asset.width !== expectedDimensions[0] ||
      asset.height !== expectedDimensions[1]
    ) {
      throw new Error(`DEMO_MANIFEST_MEDIA_METADATA_INVALID: ${asset.localPath}`);
    }

    const filePath = path.resolve(publicRoot, asset.localPath);
    if (!filePath.startsWith(publicRoot + path.sep) || !fs.existsSync(filePath)) {
      throw new Error(`DEMO_MANIFEST_MEDIA_FILE_MISSING: ${asset.localPath}`);
    }
    const actualHash = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (actualHash !== asset.sha256) {
      throw new Error(`DEMO_MANIFEST_MEDIA_HASH_MISMATCH: ${asset.localPath}`);
    }
  }
}

export function validateDemoManifest() {
  const manifest = DEMO_DATA_MANIFEST;
  validateDemoMediaAssets();
  const allIds = [
    manifest.ids.catalogProduct, manifest.ids.sourcingRequest, manifest.ids.sourcingOffer, manifest.ids.priceApproval,
    ...manifest.people.map((person) => person.idempotencyKey),
    ...manifest.clients.map((target) => target.id),
    ...manifest.rfqs.flatMap((rfq) => [rfq.id, rfq.itemId]),
    ...manifest.quotes.flatMap((quote) => [quote.id, quote.itemId])
  ];
  if (new Set(allIds).size !== allIds.length || allIds.some((id) => !uuidV4Pattern.test(id))) {
    throw new Error("DEMO_MANIFEST_INVALID_IDS");
  }

  const personKeys = new Set(manifest.people.map((person) => person.key));
  const emails = manifest.people.map((person) => person.email.trim().toLowerCase());
  if (manifest.people.length !== 28 || personKeys.size !== manifest.people.length || new Set(emails).size !== emails.length) {
    throw new Error("DEMO_MANIFEST_DUPLICATE_PERSON");
  }
  if (manifest.people.some((person) => person.key === "demoOwner"
    ? person.email.trim().toLowerCase() !== "user.test.demo.com@demo.invalid"
    : !person.email.endsWith("@quiksol.demo.invalid"))) {
    throw new Error("DEMO_MANIFEST_EMAIL_DOMAIN_REQUIRED");
  }
  if (manifest.people.some((person) => !["admin", "manager", "employee"].includes(person.technicalRole))) {
    throw new Error("DEMO_MANIFEST_TECHNICAL_ROLE_INVALID");
  }
  if (manifest.people.some((person) => person.managerKey && !personKeys.has(person.managerKey))) {
    throw new Error("DEMO_MANIFEST_INVALID_MANAGER");
  }

  const byPersonKey = new Map(manifest.people.map((person) => [person.key, person]));
  const roots = manifest.people.filter((person) => person.managerKey === null);
  const owners = manifest.people.filter((person) => person.organizationRank === "owner");
  if (roots.length !== 1 || roots[0]?.key !== "demoOwner" || owners.length !== 1 || owners[0]?.key !== "demoOwner") {
    throw new Error("DEMO_MANIFEST_REQUIRES_PRESENTATION_ROOT_OWNER");
  }
  const demoOwner = byPersonKey.get("demoOwner");
  if (
    !demoOwner ||
    demoOwner.fullName !== "user.test.demo.com" ||
    demoOwner.avatarPath !== null ||
    demoOwner.media !== null
  ) {
    throw new Error("DEMO_MANIFEST_REQUIRES_PRESENTATION_INITIAL_AVATAR");
  }
  if (manifest.people.some((person) => person.key !== "demoOwner" && person.avatarPath !== person.media?.localPath)) {
    throw new Error("DEMO_MANIFEST_EMPLOYEE_AVATAR_INVALID");
  }
  const olivia = byPersonKey.get("olivia");
  if (!olivia || olivia.managerKey !== "demoOwner" || olivia.technicalRole !== "admin" || olivia.organizationRank !== "executive") {
    throw new Error("DEMO_MANIFEST_OLIVIA_EXECUTIVE_INVALID");
  }
  for (const person of manifest.people) {
    const visited = new Set<DemoPersonKey>();
    let current: DemoPerson | undefined = person;
    while (current?.managerKey) {
      if (visited.has(current.key)) throw new Error("DEMO_MANIFEST_ORGANIZATION_CYCLE");
      visited.add(current.key);
      current = byPersonKey.get(current.managerKey);
    }
    if (current?.key !== "demoOwner") throw new Error("DEMO_MANIFEST_ORGANIZATION_DISCONNECTED");
  }

  if (manifest.compensations.length !== 28 || new Set(manifest.compensations.map((row) => row.personKey)).size !== 28 ||
      manifest.compensations.some((row) => row.currency !== "USD" || row.periodicity !== "annual" || row.amount < 60000 || row.amount > 220000)) {
    throw new Error("DEMO_MANIFEST_COMPENSATION_INVALID");
  }

  const clientKeys = new Set(manifest.clients.map((target) => target.key));
  const expectedClientNames = [
    "Amazon-demo", "Google-demo", "Microsoft-demo", "Apple-demo", "Nvidia-demo",
    "Intel-demo", "Samsung-demo", "Sony-demo", "Dell-demo", "HP-demo", "IBM-demo",
    "Cisco-demo", "Oracle-demo", "Qualcomm-demo", "Siemens-demo", "Bosch-demo",
    "Panasonic-demo", "Meta-demo", "Tesla-demo"
  ];
  if (manifest.clients.length !== 19 || clientKeys.size !== 19 || new Set(manifest.clients.map((target) => target.externalId)).size !== 19 ||
      manifest.clients.some((target, index) => target.name !== expectedClientNames[index] || !target.name.endsWith("-demo") ||
        !target.contactEmail.endsWith(".demo.invalid") || !personKeys.has(target.sellerKey))) {
    throw new Error("DEMO_MANIFEST_CLIENTS_INVALID");
  }
  const rfqKeys = new Set(manifest.rfqs.map((rfq) => rfq.key));
  if (manifest.rfqs.length !== 19 || rfqKeys.size !== 19 || new Set(manifest.rfqs.map((rfq) => rfq.externalId)).size !== 19 ||
      manifest.rfqs.some((rfq) => !clientKeys.has(rfq.clientKey) || !/^[a-f0-9]{64}$/.test(rfq.fingerprint))) {
    throw new Error("DEMO_MANIFEST_RFQS_INVALID");
  }
  if (manifest.quotes.length !== 45 || new Set(manifest.quotes.map((quote) => quote.number)).size !== 45 ||
      manifest.quotes.some((quote) => !clientKeys.has(quote.clientKey) || !rfqKeys.has(quote.rfqKey))) {
    throw new Error("DEMO_MANIFEST_QUOTES_INVALID");
  }
  for (const quote of manifest.quotes) {
    const targetClient = manifest.clients.find((target) => target.key === quote.clientKey);
    const targetRfq = manifest.rfqs.find((rfq) => rfq.key === quote.rfqKey);
    if (!targetClient || !targetRfq || targetClient.sellerKey !== quote.sellerKey || targetRfq.clientKey !== quote.clientKey ||
        round(quote.subtotal * quote.taxRate / 100) !== quote.tax || round(quote.subtotal + quote.tax) !== quote.total ||
        (quote.status === "draft") !== (quote.sentAt === null)) {
      throw new Error("DEMO_MANIFEST_QUOTE_RELATION_INVALID");
    }
  }

  const statusCount = (status: DemoQuoteStatus) => manifest.quotes.filter((quote) => quote.status === status).length;
  const sentQuotes = manifest.quotes.filter((quote) => quote.status !== "draft").length;
  const acceptedQuotes = statusCount("accepted");
  const activeSellers = new Set(manifest.quotes.map((quote) => quote.sellerKey)).size;
  const quotedValueUsd = round(manifest.quotes.reduce((sum, quote) => sum + quote.total, 0));
  const acceptedQuoteValueUsd = round(manifest.quotes.filter((quote) => quote.status === "accepted").reduce((sum, quote) => sum + quote.total, 0));
  const eventCount = manifest.quotes.reduce((count, quote) => count + 1 + (quote.status === "draft" ? 0 : 1) + (["accepted", "rejected", "expired"].includes(quote.status) ? 1 : 0), 0);
  if (statusCount("accepted") !== 22 || statusCount("rejected") !== 8 || statusCount("expired") !== 3 ||
      statusCount("sent") !== 6 || statusCount("draft") !== 6 || sentQuotes !== 39 || activeSellers !== 9 ||
      round(acceptedQuotes / sentQuotes * 100) !== 56.41 || quotedValueUsd !== 954365.1 ||
      acceptedQuoteValueUsd !== 495121.1 || eventCount !== 117) {
    throw new Error("DEMO_MANIFEST_METRICS_INVALID");
  }
  if (manifest.quote.number !== "EPD-DEMO-0001" || manifest.quote.total !== 5970.6 || manifest.quote.status !== "accepted") {
    throw new Error("DEMO_MANIFEST_ORIGINAL_QUOTE_INVALID");
  }
  return manifest;
}
