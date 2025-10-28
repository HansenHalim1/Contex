type BillingCycle = "monthly" | "annual" | "custom";

export type PlanId = "free" | "plus" | "premium" | "pro" | "enterprise";

export type PlanCaps = {
  maxBoards: number | null;
  maxStorage: number | null;
  maxViewers: number | null;
};

export const defaultCapsByPlan: Record<PlanId, PlanCaps> = {
  free: {
    maxBoards: 3,
    maxStorage: 10 * 1024 * 1024,
    maxViewers: 0
  },
  plus: {
    maxBoards: 10,
    maxStorage: 10 * 1024 * 1024 * 1024,
    maxViewers: 5
  },
  premium: {
    maxBoards: 30,
    maxStorage: 25 * 1024 * 1024 * 1024,
    maxViewers: 20
  },
  pro: {
    maxBoards: 100,
    maxStorage: 80 * 1024 * 1024 * 1024,
    maxViewers: 50
  },
  enterprise: {
    maxBoards: null,
    maxStorage: null,
    maxViewers: null
  }
};

export const PLAN_SKU_KEYS = [
  "free",
  "plus_monthly",
  "plus_annual",
  "premium_monthly",
  "premium_annual",
  "pro_monthly",
  "pro_annual",
  "enterprise_custom"
] as const;

export type PlanSkuKey = (typeof PLAN_SKU_KEYS)[number];

type PlanSkuEntry = {
  plan: PlanId;
  billingCycle: BillingCycle;
};

const skuCache: {
  parsed: boolean;
  mapping: Partial<Record<PlanSkuKey, string>>;
  reverse: Map<string, PlanSkuEntry>;
} = {
  parsed: false,
  mapping: {},
  reverse: new Map()
};

function parsePlanSkuEnv() {
  if (skuCache.parsed) return;
  skuCache.parsed = true;

  const raw = process.env.MONDAY_PLAN_SKUS;
  if (!raw) {
    console.warn("MONDAY_PLAN_SKUS env var is missing; billing checkout will be disabled");
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error("Failed to parse MONDAY_PLAN_SKUS JSON", error);
    return;
  }

  if (typeof parsed !== "object" || !parsed) {
    console.error("MONDAY_PLAN_SKUS must be an object mapping plan keys to SKU strings");
    return;
  }

  PLAN_SKU_KEYS.forEach((key) => {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) {
      const sku = value.trim();
      skuCache.mapping[key] = sku;

      const [planName, cycle] = (() => {
        if (key === "free") return ["free", "monthly"] as const;
        if (key === "enterprise_custom") return ["enterprise", "custom"] as const;
        const parts = key.split("_");
        const plan = parts[0] as PlanId;
        const billingCycle = (parts[1] as BillingCycle) || "monthly";
        return [plan, billingCycle] as const;
      })();

      skuCache.reverse.set(sku, {
        plan: planName as PlanId,
        billingCycle: cycle
      });
    }
  });
}

export function getPlanSku(key: PlanSkuKey): string | null {
  parsePlanSkuEnv();
  return skuCache.mapping[key] ?? null;
}

export function planFromSku(sku: string | null | undefined): PlanSkuEntry | null {
  if (!sku) return null;
  parsePlanSkuEnv();
  return skuCache.reverse.get(String(sku).trim()) ?? null;
}

export function normalisePlanId(input: string | null | undefined): PlanId {
  if (!input) return "free";
  const key = String(input).toLowerCase().trim();
  switch (key) {
    case "plus":
    case "premium":
    case "pro":
    case "enterprise":
      return key;
    case "ultra":
      return "pro";
    default:
      return "free";
  }
}
