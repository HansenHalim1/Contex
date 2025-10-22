#!/usr/bin/env node

const { createDecipheriv, createHash } = require("crypto");
const path = require("path");
const { fileURLToPath } = require("url");

function resolveRawKey() {
  const explicit = process.env.MONDAY_TOKEN_ENCRYPTION_KEY;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceRoleKey && serviceRoleKey.trim()) {
    console.warn("MONDAY_TOKEN_ENCRYPTION_KEY not set. Deriving encryption key from SUPABASE_SERVICE_ROLE_KEY hash.");
    return createHash("sha256").update(serviceRoleKey.trim()).digest("hex");
  }

  throw new Error("MONDAY_TOKEN_ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
}

function decodeKey(raw) {
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

  throw new Error("MONDAY_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (hex, base64, or UTF-8).");
}

function decryptSecret(value, key) {
  const PREFIX = "enc.v1:";
  const IV_LENGTH = 12;
  const TAG_LENGTH = 16;

  if (!value.startsWith(PREFIX)) {
    return value;
  }

  const payload = value.slice(PREFIX.length);
  let buffer;
  try {
    buffer = Buffer.from(payload, "base64");
  } catch (error) {
    throw new Error("Failed to base64 decode payload");
  }

  if (buffer.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error("Payload is too short");
  }

  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

const input = process.argv[2];

if (!input) {
  console.error("Usage: node scripts/decryptMondaySecret.js <enc.v1:...>");
  process.exit(1);
}

try {
  const key = decodeKey(resolveRawKey());
  const result = decryptSecret(input, key);
  console.log(result);
} catch (error) {
  console.error("Failed to decrypt secret:", error.message);
  process.exit(1);
}
