export function canUseFeature(plan: string, feature: "viewers" | "snapshots") {
  if (feature === "viewers") return ["premium", "ultra"].includes(plan);
  if (feature === "snapshots") return plan === "ultra";
  return true;
}
