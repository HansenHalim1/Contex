export function normaliseAccountId(value: unknown): string | number | null | undefined {
  if (value === null || value === undefined) return value as null | undefined;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value !== "string") {
    return value as string;
  }

  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  // Only convert purely numeric values without leading zeros
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isSafeInteger(numeric) && String(numeric) === trimmed) {
      return numeric;
    }
  }

  return trimmed;
}
