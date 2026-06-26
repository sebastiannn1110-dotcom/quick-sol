export interface MpnOffer {
  id: string;
  mpn: string | null;
  mpn_quoted?: string | null;
  supplier?: string | null;
  supplier_name?: string | null;
  customer?: string | null;
  client?: string | null;
  manufacturer?: string | null;
  description?: string | null;
  price?: number | null;
  cost?: number | null;
  qty?: number | null;
  on_hand?: number | null;
  moq?: number | null;
  spq?: number | null;
  lead_time_weeks?: number | null;
  transit_time_weeks?: number | null;
  shipping_point_country?: string | null;
  earliest_shipping_date?: string | null;
  gp?: number | null;
  gp_rate?: number | null;
  commission?: number | null;
  has_errors?: boolean | null;
  created_at?: string | null;
}

export interface SupplierRankingItem {
  supplier: string;
  offers: number;
  bestPrice: number | null;
  highestQuantity: number | null;
  fastestLeadTimeWeeks: number | null;
  averageGpRate: number | null;
  score: number;
}

export interface MpnComparisonSummary {
  totalOffers: number;
  bestPrice: number | null;
  worstPrice: number | null;
  fastestLeadTime: number | null;
  highestQuantity: number | null;
  recommendedSupplier: string | null;
  recommendationReason: string;
}

function numeric(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function supplierName(offer: MpnOffer) {
  return offer.supplier_name || offer.supplier || "Unknown supplier";
}

function quantity(offer: MpnOffer) {
  return numeric(offer.on_hand) ?? numeric(offer.qty) ?? 0;
}

function leadTimeWeeks(offer: MpnOffer) {
  return numeric(offer.lead_time_weeks);
}

function validPriceOffers(offers: MpnOffer[]) {
  return offers.filter((offer) => numeric(offer.price) !== null);
}

export function buildSupplierRanking(offers: MpnOffer[]): SupplierRankingItem[] {
  const grouped = new Map<string, MpnOffer[]>();
  for (const offer of offers) {
    const supplier = supplierName(offer);
    grouped.set(supplier, [...(grouped.get(supplier) ?? []), offer]);
  }

  const bestGlobalPrice = Math.min(...validPriceOffers(offers).map((offer) => numeric(offer.price) ?? Infinity));
  const bestLeadTime = Math.min(...offers.map((offer) => leadTimeWeeks(offer) ?? Infinity));
  const bestQty = Math.max(...offers.map(quantity));

  return Array.from(grouped.entries())
    .map(([supplier, supplierOffers]) => {
      const prices = supplierOffers.map((offer) => numeric(offer.price)).filter((value): value is number => value !== null);
      const leadTimes = supplierOffers.map(leadTimeWeeks).filter((value): value is number => value !== null);
      const gpRates = supplierOffers.map((offer) => numeric(offer.gp_rate)).filter((value): value is number => value !== null);
      const quantities = supplierOffers.map(quantity);
      const bestPrice = prices.length ? Math.min(...prices) : null;
      const fastestLeadTimeWeeks = leadTimes.length ? Math.min(...leadTimes) : null;
      const highestQuantity = quantities.length ? Math.max(...quantities) : null;
      const averageGpRate = gpRates.length ? gpRates.reduce((sum, value) => sum + value, 0) / gpRates.length : null;
      const hasCleanData = supplierOffers.some((offer) => !offer.has_errors);
      let score = 0;

      if (bestPrice !== null && Number.isFinite(bestGlobalPrice)) score += bestPrice === bestGlobalPrice ? 45 : Math.max(0, 35 - ((bestPrice - bestGlobalPrice) / Math.max(bestGlobalPrice, 1)) * 35);
      if (fastestLeadTimeWeeks !== null && Number.isFinite(bestLeadTime)) score += fastestLeadTimeWeeks === bestLeadTime ? 20 : Math.max(0, 15 - (fastestLeadTimeWeeks - bestLeadTime));
      if (highestQuantity !== null && bestQty > 0) score += Math.min(20, (highestQuantity / bestQty) * 20);
      if (averageGpRate !== null) score += Math.min(10, Math.max(0, averageGpRate * 20));
      if (hasCleanData) score += 5;

      return {
        supplier,
        offers: supplierOffers.length,
        bestPrice,
        highestQuantity,
        fastestLeadTimeWeeks,
        averageGpRate: averageGpRate === null ? null : Number(averageGpRate.toFixed(4)),
        score: Number(score.toFixed(2))
      };
    })
    .sort((a, b) => b.score - a.score || (a.bestPrice ?? Infinity) - (b.bestPrice ?? Infinity));
}

export function summarizeMpnOffers(offers: MpnOffer[]): MpnComparisonSummary {
  const prices = validPriceOffers(offers).map((offer) => numeric(offer.price) as number);
  const leadTimes = offers.map(leadTimeWeeks).filter((value): value is number => value !== null);
  const quantities = offers.map(quantity);
  const ranking = buildSupplierRanking(offers);
  const recommended = ranking[0] ?? null;
  const bestPrice = prices.length ? Math.min(...prices) : null;
  const worstPrice = prices.length ? Math.max(...prices) : null;
  const fastestLeadTime = leadTimes.length ? Math.min(...leadTimes) : null;
  const highestQuantity = quantities.length ? Math.max(...quantities) : null;
  const bestPriceSupplier = offers.find((offer) => numeric(offer.price) === bestPrice);
  const fastestSupplier = offers.find((offer) => leadTimeWeeks(offer) === fastestLeadTime);

  let recommendationReason = "No hay suficiente informacion para recomendar un proveedor.";
  if (recommended) {
    const parts = [`${recommended.supplier} tiene el mejor balance general`];
    if (bestPriceSupplier && supplierName(bestPriceSupplier) === recommended.supplier) parts.push("mejor precio");
    if (fastestSupplier && supplierName(fastestSupplier) === recommended.supplier) parts.push("entrega mas rapida");
    if ((recommended.highestQuantity ?? 0) === highestQuantity && highestQuantity) parts.push("mayor disponibilidad");
    recommendationReason = `${parts[0]}: ${parts.slice(1).join(", ") || "score superior por precio, disponibilidad, lead time y calidad del dato"}.`;
  }

  return {
    totalOffers: offers.length,
    bestPrice,
    worstPrice,
    fastestLeadTime,
    highestQuantity,
    recommendedSupplier: recommended?.supplier ?? null,
    recommendationReason
  };
}
