import pkg from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const { loadEnvConfig } = pkg;

loadEnvConfig(process.cwd());

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be defined to run this script.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false }
});

const RAW_KEY = resolveRawKey();
const KEY = decodeKey(RAW_KEY);
const PREV_RAW_KEY = process.env.PREVIOUS_MONDAY_TOKEN_ENCRYPTION_KEY || process.env.OLD_MONDAY_TOKEN_ENCRYPTION_KEY || null;
const PREV_KEY = PREV_RAW_KEY ? decodeKey(PREV_RAW_KEY) : null;
const PREFIX = "enc.v1:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function resolveRawKey() {
  const explicit = process.env.MONDAY_TOKEN_ENCRYPTION_KEY;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  console.warn("MONDAY_TOKEN_ENCRYPTION_KEY not set. Deriving encryption key from SUPABASE_SERVICE_ROLE_KEY hash.");
  return createHash("sha256").update(serviceRoleKey).digest("hex");
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

  throw new Error("MONDAY_TOKEN_ENCRYPTION_KEY must be 32 bytes (hex, base64, or UTF-8).");
}

function encryptSecret(value) {
  if (!value) return null;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  return `${PREFIX}${payload}`;
}

function decryptWithKey(value, key) {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) {
    return value;
  }

  const payload = value.slice(PREFIX.length);
  let buffer;
  try {
    buffer = Buffer.from(payload, "base64");
  } catch (error) {
    return null;
  }

  if (buffer.length <= IV_LENGTH + TAG_LENGTH) {
    return null;
  }

  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (error) {
    return null;
  }
}

function decryptSecret(value) {
  const primary = decryptWithKey(value, KEY);
  if (primary != null) return primary;
  if (PREV_KEY) {
    const fallback = decryptWithKey(value, PREV_KEY);
    if (fallback != null) {
      console.warn("Decrypted secret using previous encryption key.");
      return fallback;
    }
  }
  console.error("Failed to decrypt monday secret with available keys.");
  return null;
}

async function reEncryptTenantTokens() {
  const { data, error } = await supabase
    .from("tenants")
    .select("id, access_token, refresh_token");

  if (error) {
    throw error;
  }

  if (!data?.length) {
    console.log("No tenant rows found.");
    return;
  }

  let updated = 0;

  for (const tenant of data) {
    const updates = {};

    if (tenant.access_token) {
      const decrypted = decryptSecret(tenant.access_token);
      if (decrypted != null) {
        updates.access_token = encryptSecret(decrypted);
      } else {
        console.warn(`Unable to decrypt access token for tenant ${tenant.id}; skipping.`);
      }
    }

    if (tenant.refresh_token) {
      const decrypted = decryptSecret(tenant.refresh_token);
      if (decrypted != null) {
        updates.refresh_token = encryptSecret(decrypted);
      } else {
        console.warn(`Unable to decrypt refresh token for tenant ${tenant.id}; skipping.`);
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabase
        .from("tenants")
        .update(updates)
        .eq("id", tenant.id);

      if (updateError) {
        console.error(`Failed to update tenant ${tenant.id}:`, updateError);
      } else {
        updated += 1;
        console.log(`Re-encrypted tenant ${tenant.id}`);
      }
    }
  }

  console.log(`Finished. Updated ${updated} tenant record(s).`);
}

reEncryptTenantTokens().catch((err) => {
  console.error("Re-encryption failed:", err);
  process.exit(1);
});
