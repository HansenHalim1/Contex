import { supabaseAdmin } from "@/lib/supabase";
import { refreshMondayToken } from "@/lib/mondayRefresh";

export async function callMondayApi(accountId: string, query: string) {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("monday_access_token")
    .eq("monday_account_id", accountId)
    .single();

  if (error || !data?.monday_access_token) {
    throw new Error("Missing monday access token");
  }

  async function fetchMonday(accessToken: string) {
    return fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });
  }

  let response = await fetchMonday(data.monday_access_token);
  if (response.status === 401) {
    console.warn("Monday access token expired, attempting refresh…");
    const newToken = await refreshMondayToken(accountId);
    if (!newToken) {
      throw new Error("Token refresh failed");
    }
    response = await fetchMonday(newToken);
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`monday API call failed: ${details}`);
  }

  return response.json();
}
