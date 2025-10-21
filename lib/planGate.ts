import { normalisePlanId } from "./plans";

export function canUseFeature(plan: string, feature: "viewers" | "snapshots") {
  const normalised = normalisePlanId(plan);
  if (feature === "viewers") {
    return ["plus", "premium", "pro", "enterprise"].includes(normalised);
  }
  if (feature === "snapshots") {
    return ["pro", "enterprise"].includes(normalised);
  }
  return true;
}
