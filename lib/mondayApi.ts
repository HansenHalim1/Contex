import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";
import { decryptSecret } from "@/lib/tokenEncryption";

export async function callMondayApi(accountId: string, query: string) {
  const accountKey = normaliseAccountId(accountId);
  if (accountKey == null) {
    throw new Error("Missing monday account id");
  }

  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("access_token")
    .eq("account_id", accountKey)
    .single();

  const accessToken = decryptSecret(data?.access_token ?? null);

  if (error || !accessToken) {
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

  const response = await fetchMonday(accessToken);
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`monday API call failed: ${details}`);
  }

  return response.json();
}
