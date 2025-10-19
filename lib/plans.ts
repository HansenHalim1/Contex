export type Plan = "free" | "plus" | "premium" | "ultra";

export const capsByPlan: Record<Plan, { maxBoards: number; maxStorage: number }> = {
  free:    { maxBoards: 3,   maxStorage: 10 * 1024 * 1024 },
  plus:    { maxBoards: 10,  maxStorage: 1 * 1024 * 1024 * 1024 },
  premium: { maxBoards: 30,  maxStorage: 3 * 1024 * 1024 * 1024 },
  ultra:   { maxBoards: 100, maxStorage: 15 * 1024 * 1024 * 1024 }
};
