import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";
import { decryptSecret, encryptSecret } from "@/lib/tokenEncryption";

async function getRefreshToken(accountId: string) {
  const accountKey = normaliseAccountId(accountId);
  if (accountKey == null) {
    console.error("Cannot resolve refresh token without account id");
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("refresh_token")
    .eq("account_id", accountKey)
    .maybeSingle();

  const decryptedRefreshToken = decryptSecret(data?.refresh_token ?? null);

  if (error || !decryptedRefreshToken) {
    console.error("No refresh token found for account", accountId, error);
    return null;
  }

  return decryptedRefreshToken;
}

async function requestNewTokens(refreshToken: string) {
  const clientId = process.env.MONDAY_CLIENT_ID;
  const clientSecret = process.env.MONDAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Missing monday OAuth credentials for refresh");
    return null;
  }

  const res = await fetch("https://auth.monday.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  const tokenData = await res.json();
  if (!res.ok || !tokenData?.access_token) {
    console.error("Token refresh failed:", { status: res.status });
    return null;
  }

  return tokenData as { access_token: string; refresh_token?: string };
}

export async function refreshMondayToken(accountId: string) {
  const currentRefreshToken = await getRefreshToken(accountId);
  if (!currentRefreshToken) return null;

  const tokenData = await requestNewTokens(currentRefreshToken);
  if (!tokenData) return null;

  const accountKey = normaliseAccountId(accountId);
  if (accountKey == null) {
    console.error("Cannot persist refreshed token without account id");
    return null;
  }

  const encryptedAccessToken = encryptSecret(tokenData.access_token);
  const refreshTokenToPersist = tokenData.refresh_token ?? currentRefreshToken;
  const encryptedRefreshToken = encryptSecret(refreshTokenToPersist);

  const { error } = await supabaseAdmin
    .from("tenants")
    .update({
      access_token: encryptedAccessToken,
      refresh_token: encryptedRefreshToken,
      updated_at: new Date().toISOString()
    })
    .eq("account_id", accountKey);

  if (error) {
    console.error("Failed to persist refreshed monday token:", error);
    return null;
  }

  console.log("Refreshed monday token for account:", accountId);
  return tokenData.access_token as string;
}
