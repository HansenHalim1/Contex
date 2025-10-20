import { supabaseAdmin } from "@/lib/supabase";

export async function callMondayApi(accountId: string, query: string) {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("access_token")
    .eq("account_id", accountId)
    .single();

  if (error || !data?.access_token) {
    throw new Error("Missing monday access token");
  }

  async function fetchMonday(accessToken: string) {
    return fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });
  }

  const response = await fetchMonday(data.access_token);
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`monday API call failed: ${details}`);
  }

  return response.json();
}
