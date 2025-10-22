"use client";

import { useCallback, useMemo, useState, useEffect } from "react";

type BillingCycle = "monthly" | "annual";

type PlanCard = {
  id: "free" | "plus" | "premium" | "pro" | "enterprise";
  name: string;
  price: number | null; // monthly price in USD
  description: string;
  bullets: string[];
  highlighted?: boolean;
};

const plans: PlanCard[] = [
  {
    id: "free",
    name: "Free",
    price: 0,
    description: "Capture notes and files on your first boards.",
    bullets: ["5 boards", "10 MB storage", "No guest viewers"]
  },
  {
    id: "plus",
    name: "Plus",
    price: 9.99,
    description: "Unlock more boards and storage for small teams.",
    bullets: ["10 boards", "1 GB storage", "Up to 5 viewers"]
  },
  {
    id: "premium",
    name: "Premium",
    price: 19.99,
    description: "Best for teams that collaborate across many boards.",
    bullets: ["30 boards", "3 GB storage", "Up to 20 viewers"]
  },
  {
    id: "pro",
    name: "Pro",
    price: 49.99,
    description: "Advanced controls, extra storage, and support.",
    bullets: ["100 boards", "15 GB storage", "Up to 50 viewers", "Priority support"]
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: null,
    description: "Tailor Context to the scale of your organization.",
    bullets: ["Custom limits", "Dedicated success manager", "Security reviews"],
    highlighted: true
  }
];

function planTypeFor(id: PlanCard["id"], cycle: BillingCycle): string {
  if (id === "free") return "free";
  if (id === "enterprise") return "enterprise_custom";
  return `${id}_${cycle}`;
}

export default function Pricing() {
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const queryTenant = params.get("tenantId");
    const queryPlan = params.get("plan") || params.get("planId");
    if (queryTenant) setTenantId(queryTenant);
    if (queryPlan) setPendingPlan(queryPlan);
  }, []);

  useEffect(() => {
    if (!pendingPlan) return;
    if (!plans.some((plan) => planTypeFor(plan.id, cycle) === pendingPlan || planTypeFor(plan.id, cycle === "monthly" ? "annual" : "monthly") === pendingPlan)) {
      return;
    }
    // switch billing cycle to match pending plan request
    if (pendingPlan.endsWith("_annual")) setCycle("annual");
    if (pendingPlan.endsWith("_monthly")) setCycle("monthly");
  }, [pendingPlan, cycle]);

  const formatPrice = useCallback(
    (monthly: number | null) => {
      if (monthly === null) return "Custom";
      if (monthly === 0) return "Free";
      if (cycle === "monthly") return `$${monthly.toFixed(2)}/mo`;
      return `$${(monthly * 10).toFixed(2)}/yr`;
    },
    [cycle]
  );

  const subline = useMemo(() => (cycle === "annual" ? "2 months free" : "Billed monthly"), [cycle]);

  const handleCheckout = useCallback(
    async (planType: string) => {
      if (planType === "free") {
        window.open("/connect", "_blank", "noopener,noreferrer");
        return;
      }

      if (!tenantId) {
        window.alert("Open Context inside monday.com to start a billing checkout.");
        return;
      }

      setIsLaunching(true);
      setPendingPlan(planType);
      try {
        const res = await fetch("/api/billing/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId, planId: planType })
        });

        if (!res.ok) {
          const message = await res.json().catch(() => null);
          console.error("Checkout failed", message || res.statusText);
          window.alert("Unable to start checkout. Please try again from the app.");
          return;
        }

        const data = await res.json();
        if (data?.url) {
          window.open(String(data.url), "_blank", "noopener,noreferrer");
        }
      } catch (error) {
        console.error("Checkout launch error", error);
        window.alert("Something went wrong starting the checkout. Please try again.");
      } finally {
        setIsLaunching(false);
      }
    },
    [tenantId]
  );

  return (
    <div className="text-gray-800">
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="text-center">
          <h1 className="text-4xl font-semibold text-[#1C1C1C] mb-3">Choose the Plan That Fits You</h1>
          <p className="text-gray-500 mb-10 text-lg">Simple pricing for every team. Upgrade anytime.</p>
          <div className="inline-flex items-center rounded-full border border-gray-200 bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={() => setCycle("monthly")}
              className={`px-4 py-2 text-sm font-medium rounded-full transition ${
                cycle === "monthly" ? "bg-[#0073EA] text-white shadow" : "text-gray-500"
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setCycle("annual")}
              className={`px-4 py-2 text-sm font-medium rounded-full transition ${
                cycle === "annual" ? "bg-[#00CA72] text-white shadow" : "text-gray-500"
              }`}
            >
              Annual
            </button>
          </div>
          <p className="mt-3 text-xs text-gray-400">{subline}</p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan) => {
            const planType = planTypeFor(plan.id, cycle);
            const priceLabel = formatPrice(plan.price);
            const isFree = plan.price === 0;
            const isPopular = plan.highlighted && plan.id !== "enterprise";

            return (
              <div
                key={plan.id}
                className={`relative flex h-full flex-col rounded-2xl border border-gray-200 bg-white p-6 shadow-sm transition hover:shadow-lg ${
                  plan.highlighted ? "border-[#0073EA]" : ""
                }`}
              >
                {isPopular && (
                  <span className="absolute -top-3 right-4 rounded-full bg-[#0073EA] px-3 py-1 text-xs font-semibold text-white shadow">
                    Most popular
                  </span>
                )}
                <h2 className="text-xl font-semibold text-[#1C1C1C]">{plan.name}</h2>
                <p className="mt-2 text-sm text-gray-500">{plan.description}</p>
                <div className="mt-6 text-3xl font-semibold text-[#1C1C1C]">{priceLabel}</div>
                <p className="text-xs text-gray-400">{plan.price === null ? "Let's talk" : cycle === "monthly" ? "per month" : "per year"}</p>

                <ul className="mt-6 flex flex-col gap-2 text-sm text-gray-600">
                  {plan.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-center gap-2">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#E3F2FD] text-[#0073EA] text-xs">
                        ✓
                      </span>
                      {bullet}
                    </li>
                  ))}
                </ul>

                <div className="mt-auto pt-6">
                  <button
                    type="button"
                    data-plan-type={planType}
                    onClick={() => void handleCheckout(planType)}
                    className={`w-full rounded-md px-4 py-2 text-sm font-medium transition ${
                      isFree
                        ? "border border-gray-300 text-gray-600 bg-white hover:border-gray-400"
                        : "text-white bg-gradient-to-r from-[#0073EA] to-[#00CA72] hover:opacity-95"
                    } ${isLaunching ? "opacity-70" : ""}`}
                    disabled={isLaunching}
                  >
                    {isFree ? "Included" : "Select plan"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
