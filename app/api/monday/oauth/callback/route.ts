import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

const MONDAY_TOKEN_URL = "https://auth.monday.com/oauth2/token";
const SUCCESS_REDIRECT = process.env.MONDAY_REDIRECT_SUCCESS_URL || "https://contex-akxn.vercel.app/success";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  const clientId = process.env.MONDAY_CLIENT_ID;
  const clientSecret = process.env.MONDAY_CLIENT_SECRET;
  const redirectUri = process.env.MONDAY_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error("Missing monday OAuth environment variables");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const tokenRes = await fetch(MONDAY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    })
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    console.error("OAuth token exchange failed:", tokenData);
    return NextResponse.json({ error: "OAuth token exchange failed", details: tokenData }, { status: 400 });
  }

  if (!tokenData.account_id || !tokenData.access_token) {
    console.error("Unexpected token payload:", tokenData);
    return NextResponse.json({ error: "Invalid token payload", details: tokenData }, { status: 400 });
  }

  const mondayAccountId = String(tokenData.account_id);

  const { error } = await supabaseAdmin
    .from("tenants")
    .upsert(
      {
        monday_account_id: mondayAccountId,
        monday_access_token: tokenData.access_token,
        monday_refresh_token: tokenData.refresh_token || null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "monday_account_id" }
    );

  if (error) {
    console.error("Failed to store monday tokens:", error);
    return NextResponse.json({ error: "Failed to store tokens" }, { status: 500 });
  }

  return NextResponse.redirect(SUCCESS_REDIRECT);
}
