type WindowRecord = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, WindowRecord>();

const IP_PATTERN = /^[a-fA-F0-9:.]{1,100}$/;

function extractClientIp(req: Request): string {
  const nextReq = req as Request & { ip?: string | null | undefined };
  const direct = typeof nextReq.ip === "string" ? nextReq.ip.trim() : "";
  if (direct && IP_PATTERN.test(direct)) {
    return direct;
  }

  const pickHeader = (header: string) => {
    const value = req.headers.get(header);
    if (!value) return null;
    const first = value.split(",")[0]?.trim() ?? "";
    if (!first || first.length > 100) return null;
    if (IP_PATTERN.test(first)) return first;
    return null;
  };

  return pickHeader("x-forwarded-for") ?? pickHeader("x-real-ip") ?? "unknown";
}

function getClientKey(req: Request, bucketId: string) {
  const ip = extractClientIp(req);
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
