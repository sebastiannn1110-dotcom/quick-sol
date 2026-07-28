import type {
  OpportunityCompatibility,
  OpportunitySelectedRole
} from "@/lib/opportunity-finder/types";

const SUPPLY_ROLES = new Set<OpportunitySelectedRole>(["stock", "excess", "supplier_offer"]);
const HISTORY_ROLES = new Set<OpportunitySelectedRole>(["received_history", "sales_history"]);

export function evaluateOpportunityCompatibility(
  roleA: OpportunitySelectedRole | null,
  roleB: OpportunitySelectedRole | null
): OpportunityCompatibility {
  if (!roleA || !roleB) {
    return incompatible("unknown_role", null);
  }
  if (roleA === "ignore" || roleB === "ignore") {
    return incompatible("ignored_file", roleA === "ignore" ? "demand" : null);
  }
  if (roleA === "demand" && roleB === "demand") {
    return incompatible("two_demand_files", "stock");
  }
  if (HISTORY_ROLES.has(roleA) && HISTORY_ROLES.has(roleB)) {
    return incompatible("two_history_files", "demand");
  }

  const demandSide = roleA === "demand" ? "A" : roleB === "demand" ? "B" : null;
  if (!demandSide) {
    if (SUPPLY_ROLES.has(roleA) || SUPPLY_ROLES.has(roleB)) {
      return incompatible("requires_demand", "demand");
    }
    return incompatible("unsupported_pair", "demand");
  }

  const otherRole = demandSide === "A" ? roleB : roleA;
  const supplySide = demandSide === "A" ? "B" : "A";
  const kinds = {
    stock: "demand_stock",
    excess: "demand_excess",
    supplier_offer: "demand_supplier_offer",
    received_history: "demand_received_history",
    sales_history: "demand_sales_history"
  } as const;
  const comparisonKind = kinds[otherRole as keyof typeof kinds];
  if (!comparisonKind) return incompatible("unsupported_pair", "stock");

  return {
    compatible: true,
    demandSide,
    supplySide,
    comparisonKind,
    reasonCode: "compatible",
    recommendedRole: null
  };
}

function incompatible(
  reasonCode: Exclude<OpportunityCompatibility["reasonCode"], "compatible">,
  recommendedRole: OpportunitySelectedRole | null
): OpportunityCompatibility {
  return {
    compatible: false,
    demandSide: null,
    supplySide: null,
    comparisonKind: "incompatible",
    reasonCode,
    recommendedRole
  };
}
