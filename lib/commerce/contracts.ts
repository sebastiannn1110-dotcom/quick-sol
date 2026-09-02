import { z } from "zod";
import type { UserRole } from "@/lib/types";

export const COMMERCE_ROLES = ["employee", "manager", "admin", "super_admin_dev"] as const;
export const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired"] as const;
export const RFQ_STATUSES = ["unassigned", "assigned", "in_review", "quoted", "cancelled"] as const;

export type CommerceTechnicalRole = (typeof COMMERCE_ROLES)[number];
export type CommerceSessionRole = "employee" | "manager" | "admin";
export type CommerceQuoteStatus = (typeof QUOTE_STATUSES)[number];
export type CommerceRfqStatus = (typeof RFQ_STATUSES)[number];

const cleanText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

export const commerceLoginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(1024),
  remember: z.boolean().optional().default(false)
}).strict();

export const commerceRefreshSchema = z.object({
  refreshToken: z.string().min(20).max(4096)
}).strict();

export const commerceLogoutSchema = z.object({
  refreshToken: z.string().min(20).max(4096).optional()
}).strict();

export const commerceCustomerSchema = z.object({
  companyOrName: cleanText(160),
  legalCompanyName: optionalText(200),
  contact: cleanText(160),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone: optionalText(60),
  country: optionalText(100),
  city: optionalText(120),
  address: optionalText(320),
  addressLine2: optionalText(160),
  stateOrProvince: optionalText(120),
  postalCode: optionalText(40),
  deliveryRecipient: optionalText(160),
  deliveryPhone: optionalText(60),
  deliveryEmail: z.union([z.literal(""), z.string().trim().email().max(254)]).optional().default(""),
  taxId: optionalText(80),
  purchaseOrderReference: optionalText(120),
  preferredLanguage: z.enum(["es", "en", "zh"]).default("en"),
  commercialNotes: optionalText(1500)
}).strict();

export const commerceQuoteItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1_000_000),
  discountPercent: z.number().min(0).max(100).multipleOf(0.01).optional().default(0)
}).strict();

const commerceQuoteWriteFields = {
  customerId: z.string().uuid(),
  rfqId: z.string().uuid().nullable().optional(),
  validUntil: z.iso.date(),
  notes: optionalText(2000),
  commercialTerms: optionalText(3000),
  taxRate: z.number().min(0).max(100).multipleOf(0.01).optional().default(7)
};

export const commerceQuoteWriteSchema = z.object({
  ...commerceQuoteWriteFields,
  items: z.array(commerceQuoteItemSchema).min(1).max(100)
}).strict();

const commerceQuotePatchItemSchema = commerceQuoteItemSchema.extend({
  productId: z.string().uuid().nullable()
}).strict();

export const commerceQuotePatchSchema = z.object({
  ...commerceQuoteWriteFields,
  items: z.array(commerceQuotePatchItemSchema).min(1).max(100),
  version: z.number().int().min(1)
}).strict().superRefine((value, context) => {
  if (value.rfqId == null && value.items.some((item) => item.productId === null)) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "Only an RFQ-backed draft may preserve unresolved catalog lines."
    });
  }
});

export const commerceQuoteTransitionSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(["accepted", "rejected", "expired"]),
  reason: z.string().trim().max(500).optional()
}).strict();

export const commerceQuoteSendSchema = z.object({
  version: z.number().int().min(1)
}).strict();

export const commerceQuoteShareSchema = z.object({
  expiresInHours: z.number().int().min(1).max(168).optional().default(72)
}).strict();

export const commerceRfqActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_in_review") }).strict(),
  z.object({
    action: z.literal("assign_seller"),
    sellerId: z.string().uuid()
  }).strict(),
  z.object({ action: z.literal("create_client") }).strict()
]);

export const commerceRfqQuoteSchema = z.object({
  validUntil: z.iso.date(),
  notes: optionalText(2000),
  commercialTerms: optionalText(3000),
  taxRate: z.number().min(0).max(100).multipleOf(0.01).optional().default(7)
}).strict();

const rfqContactSchema = z.object({
  companyOrName: cleanText(160),
  contact: cleanText(160),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone: optionalText(60),
  country: optionalText(100),
  city: optionalText(120),
  preferredLanguage: z.enum(["es", "en", "zh", "fr", "de", "ja", "ko"]).default("en"),
  notes: optionalText(1500)
}).strict();

const rfqItemSchema = z.object({
  mpn: cleanText(160),
  manufacturer: optionalText(160),
  description: optionalText(500),
  quantity: z.number().int().min(1).max(1_000_000),
  targetPrice: z.number().positive().max(100_000_000).nullable().optional()
}).strict();

export const commerceRfqIntakeSchema = z.object({
  externalRfqId: cleanText(160),
  externalClientId: z.string().trim().max(160).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  source: z.literal("quiksol-web").default("quiksol-web"),
  contact: rfqContactSchema,
  items: z.array(rfqItemSchema).min(1).max(100)
}).strict();

export type CommerceCustomerInput = z.infer<typeof commerceCustomerSchema>;
export type CommerceQuoteWriteInput = z.infer<typeof commerceQuoteWriteSchema>;
export type CommerceQuotePatchInput = z.infer<typeof commerceQuotePatchSchema>;
export type CommerceRfqIntakeInput = z.infer<typeof commerceRfqIntakeSchema>;
export type CommerceRfqActionInput = z.infer<typeof commerceRfqActionSchema>;
export type CommerceRfqQuoteInput = z.infer<typeof commerceRfqQuoteSchema>;

export type QuoteCalculationItem = {
  productId: string;
  quantity: number;
  authorizedUnitPrice: number;
  discountPercent: number;
};

export function calculateQuoteTotals(items: QuoteCalculationItem[], taxRate: number) {
  const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const roundUnit = (value: number) => Math.round((value + Number.EPSILON) * 10_000) / 10_000;
  const lines = items.map((item) => {
    const sellerUnitPrice = roundUnit(item.authorizedUnitPrice * (1 - item.discountPercent / 100));
    return { ...item, sellerUnitPrice, lineTotal: roundMoney(sellerUnitPrice * item.quantity) };
  });
  const subtotal = roundMoney(lines.reduce((sum, item) => sum + item.lineTotal, 0));
  const tax = roundMoney(subtotal * taxRate / 100);
  return { lines, subtotal, taxRate, tax, total: roundMoney(subtotal + tax) };
}

export function sessionRole(role: UserRole): CommerceSessionRole {
  return role === "super_admin_dev" ? "admin" : role;
}

export function commerceScopes(role: UserRole) {
  return {
    ownOperations: true,
    teamOperations: role === "manager" || role === "admin" || role === "super_admin_dev",
    allOperations: role === "admin" || role === "super_admin_dev",
    approveExtendedDiscount: role === "manager" || role === "admin" || role === "super_admin_dev"
  };
}

export function canTransitionQuote(from: CommerceQuoteStatus, to: CommerceQuoteStatus) {
  return (
    (from === "draft" && (to === "sent" || to === "expired")) ||
    (from === "sent" && (to === "accepted" || to === "rejected" || to === "expired"))
  );
}
