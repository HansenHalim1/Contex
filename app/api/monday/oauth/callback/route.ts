import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  try {
    const tokenRes = await fetch("https://auth.monday.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        client_id: process.env.MONDAY_CLIENT_ID,
        client_secret: process.env.MONDAY_CLIENT_SECRET,
        redirect_uri: `${process.env.NEXT_PUBLIC_BASE_URL}/api/monday/oauth/callback`
      })
    });

    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson?.access_token;
    if (!accessToken) {
      console.error("Token exchange failed:", tokenJson);
      return NextResponse.json({ error: "Token exchange failed" }, { status: 500 });
    }

    const meQuery = `
      query {
        me { id name }
        account { id name slug }
      }
    `;
    const infoRes = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: meQuery })
    });
    const infoJson = await infoRes.json();
    const accountIdRaw = infoJson?.data?.account?.id;
    const accountId = typeof accountIdRaw === "number" ? accountIdRaw : Number(accountIdRaw);

    if (!accountId || Number.isNaN(accountId)) {
      console.error("Missing account id in monday profile response:", infoJson);
      return NextResponse.json({ error: "Account lookup failed" }, { status: 500 });
    }

    const accountSlug = infoJson?.data?.account?.slug;
    const userId = infoJson?.data?.me?.id;

    const { error: dbErr } = await supabaseAdmin
      .from("tenants")
      .upsert(
        {
          account_id: accountId,
          account_slug: accountSlug,
          user_id: userId,
          access_token: accessToken,
          updated_at: new Date().toISOString()
        },
        { onConflict: "account_id" }
      );

    if (dbErr) {
      console.error("Supabase upsert error:", dbErr);
      return NextResponse.json({ error: "Database save failed" }, { status: 500 });
    }

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/connected`);
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return NextResponse.json({ error: "OAuth callback failed" }, { status: 500 });
  }
}
