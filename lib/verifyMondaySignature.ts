import { createHmac, timingSafeEqual, type BinaryLike } from "crypto";

type VerifyInput = {
  payload: BinaryLike;
  signature: string | null | undefined;
  secret: string | undefined;
};

function safeEquals(expected: string, provided: string) {
  const expectedBuffer = Buffer.from(expected, "utf-8");
  const providedBuffer = Buffer.from(provided, "utf-8");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function verifyMondaySignature({ payload, signature, secret }: VerifyInput): boolean {
  if (!secret) {
    throw new Error("MONDAY_SIGNING_SECRET is not configured");
  }

  if (!signature) {
    return false;
  }

  const trimmedSignature = signature.trim();
  if (!trimmedSignature) {
    return false;
  }

  const digest = createHmac("sha256", secret).update(payload).digest();
  const digestHex = digest.toString("hex");
  const digestBase64 = digest.toString("base64");

  if (safeEquals(digestHex, trimmedSignature)) {
    return true;
  }

  if (safeEquals(digestBase64, trimmedSignature)) {
    return true;
  }

  // Attempt constant-time comparison on decoded base64 string if header was encoded differently
  try {
    const providedBuffer = Buffer.from(trimmedSignature, "base64");
    if (providedBuffer.length === digest.length && timingSafeEqual(providedBuffer, digest)) {
      return true;
    }
  } catch {
    // ignore decode errors, fall through to failure
  }

  return false;
}
