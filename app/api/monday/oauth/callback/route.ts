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

  const accessToken = tokenData.access_token as string | undefined;

  if (!accessToken) {
    console.error("Token payload missing access token:", tokenData);
    return NextResponse.json({ error: "Invalid token payload", details: tokenData }, { status: 400 });
  }

  let mondayAccountId: string | null =
    (tokenData.account_id && String(tokenData.account_id)) ||
    (tokenData.account?.id && String(tokenData.account.id)) ||
    null;

  if (!mondayAccountId) {
    try {
      const accountRes = await fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: "query { me { account { id } } }" })
      });

      const accountData = await accountRes.json();
      if (accountRes.ok) {
        mondayAccountId = accountData?.data?.me?.account?.id
          ? String(accountData.data.me.account.id)
          : null;
      } else {
        console.error("Failed to fetch monday account info:", accountData);
      }
    } catch (err) {
      console.error("Error fetching monday account info:", err);
    }
  }

  if (!mondayAccountId) {
    try {
      const parts = accessToken.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (payload?.aai) {
          mondayAccountId = String(payload.aai);
        } else if (payload?.accountId) {
          mondayAccountId = String(payload.accountId);
        }
      }
    } catch (err) {
      console.error("Failed to decode monday access token payload:", err);
    }
  }

  if (!mondayAccountId) {
    console.error("Unable to determine monday account id from token payload:", tokenData);
    return NextResponse.json({ error: "Invalid token payload", details: tokenData }, { status: 400 });
  }

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
