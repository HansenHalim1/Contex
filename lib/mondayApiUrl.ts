const REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function normaliseMondayRegion(region: string | null | undefined): string | null {
  if (!region) return null;
  const normalised = region.trim().toLowerCase();
  if (!normalised) return null;
  if (!REGION_PATTERN.test(normalised)) return null;
  return normalised;
}

export function resolveMondayApiUrl(region: string | null | undefined): string {
  const safeRegion = normaliseMondayRegion(region);
  return safeRegion ? `https://api-${safeRegion}.monday.com/v2` : "https://api.monday.com/v2";
}
