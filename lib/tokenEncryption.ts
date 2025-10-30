import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

function resolveRawKey(): string {
  const explicit = process.env.MONDAY_TOKEN_ENCRYPTION_KEY;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceRoleKey) {
    console.warn("MONDAY_TOKEN_ENCRYPTION_KEY not set. Deriving encryption key from SUPABASE_SERVICE_ROLE_KEY hash.");
    return createHash("sha256").update(serviceRoleKey).digest("hex");
  }

  throw new Error("MONDAY_TOKEN_ENCRYPTION_KEY environment variable is not configured");
}

const RAW_KEY = resolveRawKey();

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const base64Match = /^[A-Za-z0-9+/=]+$/.test(trimmed);
  if (base64Match) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  }

  const hexMatch = /^[0-9a-fA-F]+$/.test(trimmed);
  if (hexMatch) {
    const decoded = Buffer.from(trimmed, "hex");
    if (decoded.length === 32) return decoded;
  }

  const utf8 = Buffer.from(trimmed, "utf8");
  if (utf8.length === 32) return utf8;

  throw new Error("MONDAY_TOKEN_ENCRYPTION_KEY must be 32 bytes (provide as base64, hex, or UTF-8)");
}

const KEY = decodeKey(RAW_KEY);

const PREFIX = "enc.v1:";
const IV_LENGTH = 12; // AES-GCM recommended IV size
const TAG_LENGTH = 16;

export function encryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  return `${PREFIX}${payload}`;
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) {
    return value;
  }

  const payload = value.slice(PREFIX.length);
  let buffer: Buffer;
  try {
    buffer = Buffer.from(payload, "base64");
  } catch (error) {
    console.error("Failed to base64 decode encrypted secret payload", error);
    return null;
  }

  if (buffer.length <= IV_LENGTH + TAG_LENGTH) {
    console.error("Encrypted secret payload is too short");
    return null;
  }

  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH);

  try {
    const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (error) {
    console.error("Failed to decrypt monday secret", error);
    return null;
  }
}

export function decryptTenantAuthFields<T extends { access_token?: string | null; refresh_token?: string | null }>(
  tenant: T | null | undefined
): T | null | undefined {
  if (!tenant) return tenant;
  const decrypted: T = { ...tenant };

  if ("access_token" in decrypted) {
    decrypted.access_token = decryptSecret(decrypted.access_token ?? null) ?? decrypted.access_token ?? null;
  }

  if ("refresh_token" in decrypted) {
    decrypted.refresh_token = decryptSecret(decrypted.refresh_token ?? null) ?? decrypted.refresh_token ?? null;
  }

  return decrypted;
}
