import { supabaseAdmin } from "@/lib/supabase";

export async function callMondayApi(accountId: string, query: string) {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("monday_access_token")
    .eq("monday_account_id", accountId)
    .single();

  if (error || !data?.monday_access_token) {
    throw new Error("No valid monday token for this account");
  }

  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: data.monday_access_token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`monday API call failed: ${details}`);
  }

  return response.json();
}
