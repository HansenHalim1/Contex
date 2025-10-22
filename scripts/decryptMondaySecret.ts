import { decryptSecret } from "../lib/tokenEncryption";

const encoded = process.argv[2];

if (!encoded) {
  console.error("Usage: ts-node scripts/decryptMondaySecret.ts <enc.v1:...>");
  process.exit(1);
}

const result = decryptSecret(encoded);
console.log(result);
