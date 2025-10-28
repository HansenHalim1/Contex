import { type PlanId } from "@/lib/plans";

export type ViewerRole = "viewer" | "restricted" | "editor";
export type ViewerStatusStored = "allowed" | "restricted" | "editor";

export function toStoredStatus(role: ViewerRole): ViewerStatusStored {
  if (role === "viewer") return "allowed";
  return role;
}

export function fromStoredStatus(status: string | null | undefined): ViewerRole {
  switch (status) {
    case "editor":
      return "editor";
    case "restricted":
      return "restricted";
    case "allowed":
    default:
      return "viewer";
  }
}

export function allowedRolesForPlan(plan: PlanId): ViewerRole[] {
  switch (plan) {
    case "premium":
    case "pro":
    case "enterprise":
      return ["viewer", "restricted", "editor"];
    default:
      return ["viewer", "restricted"];
  }
}

export function normaliseRoleInput(value: unknown): ViewerRole | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "viewer":
    case "viewers":
    case "allowed":
      return "viewer";
    case "restricted":
      return "restricted";
    case "editor":
    case "editors":
      return "editor";
    default:
      return null;
  }
}

export function isPrivilegedRole(role: ViewerRole): boolean {
  return role === "viewer" || role === "editor";
}
