import { NextResponse } from "next/server";
import { randomBytes, createHmac } from "crypto";

export const runtime = "nodejs";

const RAW_STATE_SECRET = process.env.MONDAY_OAUTH_STATE_SECRET || process.env.MONDAY_CLIENT_SECRET;

if (!RAW_STATE_SECRET) {
  throw new Error("MONDAY_OAUTH_STATE_SECRET or MONDAY_CLIENT_SECRET must be configured");
}

const STATE_SECRET = RAW_STATE_SECRET;

function signState(nonce: string): string {
  const ts = Date.now().toString();
  const data = `${nonce}.${ts}`;
  const sig = createHmac("sha256", STATE_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export async function GET() {
  const clientId = process.env.MONDAY_CLIENT_ID;
  const redirectUri = process.env.MONDAY_REDIRECT_URI;

  if (!clientId) {
    throw new Error("MONDAY_CLIENT_ID environment variable is not configured");
  }

  if (!redirectUri) {
    throw new Error("MONDAY_REDIRECT_URI environment variable is not configured");
  }

  const nonce = randomBytes(16).toString("hex");
  const state = signState(nonce);

  const url = new URL("https://auth.monday.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "boards:read users:read account:read me:read teams:read");
  url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString());
}
