import { z } from "zod";

const cleanText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().default("");
const currency = z.string().trim().length(3).transform((value) => value.toUpperCase());

export const sourcingRequestSchema = z.object({
  mpn: cleanText(160),
  manufacturer: optionalText(160),
  requestedQuantity: z.number().int().positive().max(100_000_000),
  unitOfMeasure: optionalText(40),
  customerContext: optionalText(240),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
  notes: optionalText(2000)
}).strict();

export const sourcingOfferSchema = z.object({
  supplierName: cleanText(200),
  supplierReference: optionalText(160),
  mpn: cleanText(160),
  manufacturer: optionalText(160),
  availableQuantity: z.number().int().positive().max(100_000_000),
  unitOfMeasure: optionalText(40),
  rawUnitCost: z.number().positive().max(100_000_000),
  currency: currency.default("USD"),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  minimumOrderQuantity: z.number().int().positive().max(100_000_000).default(1),
  standardPackQuantity: z.number().int().positive().max(100_000_000).nullable().optional(),
  dateCode: optionalText(80),
  condition: optionalText(80),
  warehouse: optionalText(160),
  incoterm: optionalText(40),
  countryOfOrigin: optionalText(120),
  expiresAt: z.iso.datetime({ offset: true }),
  notes: optionalText(2000),
  provenance: z.record(z.string(), z.unknown()).optional().default({})
}).strict();

export const sourcingDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    authorizedUnitPrice: z.number().positive().max(100_000_000),
    authorizedCurrency: z.literal("USD").default("USD"),
    coarseAvailability: z.enum(["available", "limited", "unavailable", "contact_us"]),
    reason: optionalText(1000)
  }).strict(),
  z.object({
    decision: z.literal("reject"),
    reason: cleanText(1000)
  }).strict()
]);

export const sourcingPublicationSchema = z.object({
  publishToCatalog: z.boolean()
}).strict();

export const sourcingAutomationSchema = z.object({
  commerceRfqItemId: z.string().uuid()
}).strict();

export type SourcingRequestInput = z.infer<typeof sourcingRequestSchema>;
export type SourcingOfferInput = z.infer<typeof sourcingOfferSchema>;
export type SourcingDecisionInput = z.infer<typeof sourcingDecisionSchema>;
