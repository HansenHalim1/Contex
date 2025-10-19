import { supabaseAdmin } from "@/lib/supabase";

async function getRefreshToken(accountId: string) {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("monday_refresh_token")
    .eq("monday_account_id", accountId)
    .single();

  if (error || !data?.monday_refresh_token) {
    console.error("No refresh token found for account", accountId, error);
    return null;
  }

  return data.monday_refresh_token as string;
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
    console.error("Token refresh failed:", tokenData);
    return null;
  }

  return tokenData as { access_token: string; refresh_token?: string };
}

export async function refreshMondayToken(accountId: string) {
  const currentRefreshToken = await getRefreshToken(accountId);
  if (!currentRefreshToken) return null;

  const tokenData = await requestNewTokens(currentRefreshToken);
  if (!tokenData) return null;

  const { error } = await supabaseAdmin
    .from("tenants")
    .update({
      monday_access_token: tokenData.access_token,
      monday_refresh_token: tokenData.refresh_token ?? currentRefreshToken,
      updated_at: new Date().toISOString()
    })
    .eq("monday_account_id", accountId);

  if (error) {
    console.error("Failed to persist refreshed monday token:", error);
    return null;
  }

  console.log("Refreshed monday token for account:", accountId);
  return tokenData.access_token as string;
}
