type WindowRecord = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, WindowRecord>();

function getClientKey(req: Request, bucketId: string) {
  const forwarded = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "";
  const ip = forwarded.split(",")[0]?.trim() || "unknown";
  return `${bucketId}:${ip}`;
}

export async function enforceRateLimit(req: Request, bucketId: string, limit: number, windowMs: number) {
  if (limit <= 0 || windowMs <= 0) return;

  const key = getClientKey(req, bucketId);
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (existing.count >= limit) {
    const retryAfter = Math.max(0, Math.ceil((existing.resetAt - now) / 1000));
    const err: Error & { status?: number; retryAfter?: number } = new Error("Rate limit exceeded");
    err.status = 429;
    err.retryAfter = retryAfter;
    throw err;
  }

  existing.count += 1;
}
