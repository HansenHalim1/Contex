import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { refreshMondayToken } from "@/lib/mondayRefresh";

export async function GET() {
  const { data, error } = await supabaseAdmin.from("tenants").select("monday_account_id");
  if (error) {
    console.error("Failed to load tenants for refresh:", error);
    return NextResponse.json({ message: "Failed to load tenants" }, { status: 500 });
  }

  if (!data?.length) {
    return NextResponse.json({ message: "No accounts found" });
  }

  for (const row of data) {
    if (!row.monday_account_id) continue;
    try {
      await refreshMondayToken(row.monday_account_id as string);
    } catch (err) {
      console.error("Failed to refresh monday token for", row.monday_account_id, err);
    }
  }

  return NextResponse.json({ message: `Refreshed tokens for ${data.length} accounts` });
}
