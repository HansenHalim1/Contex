import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state") || undefined;

  if (!code) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  try {
    const clientId = process.env.MONDAY_CLIENT_ID;
    const clientSecret = process.env.MONDAY_CLIENT_SECRET;
    const redirectUri = `${process.env.NEXT_PUBLIC_BASE_URL}/api/monday/oauth/callback`;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("Missing monday OAuth env vars");
      return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
    }

    const tokenBody = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    });

    const tokenRes = await fetch("https://auth.monday.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString()
    });

    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("Token exchange HTTP error", {
        status: tokenRes.status,
        tokenJson,
        redirectUri,
        clientId: clientId.slice(0, 6) + "...",
        state
      });
      return NextResponse.json(
        { error: "Token exchange failed", details: tokenJson, status: tokenRes.status },
        { status: 500 }
      );
    }
    const accessToken = tokenJson?.access_token;
    if (!accessToken) {
      console.error("Token exchange payload missing access token", {
        tokenJson,
        redirectUri,
        state
      });
      return NextResponse.json(
        { error: "Token exchange failed", details: tokenJson },
        { status: 500 }
      );
    }

    const accountIdCandidate = normaliseAccountId(
      (tokenJson?.account_id ?? tokenJson?.data?.account_id ?? tokenJson?.scope_data?.account_id) ?? null
    );
    let accountId =
      typeof accountIdCandidate === "number"
        ? accountIdCandidate
        : accountIdCandidate != null
        ? Number(accountIdCandidate)
        : null;

    let accountSlug =
      tokenJson?.account?.slug ??
      tokenJson?.data?.account?.slug ??
      tokenJson?.scope_data?.account?.slug ??
      null;

    const userIdCandidate = normaliseAccountId(
      (tokenJson?.user_id ?? tokenJson?.data?.user_id ?? tokenJson?.scope_data?.user_id) ?? null
    );
    let userId =
      typeof userIdCandidate === "number"
        ? userIdCandidate
        : userIdCandidate != null
        ? Number(userIdCandidate)
        : null;

    let infoJson: any = null;

    if (!accountId || Number.isNaN(accountId) || !accountSlug || !userId) {
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
      infoJson = await infoRes.json();

      if (!infoRes.ok) {
        console.error("monday profile query failed", {
          status: infoRes.status,
          infoJson
        });
      } else {
        if (!accountId || Number.isNaN(accountId)) {
          const accountIdRaw = infoJson?.data?.account?.id;
          const parsedAccountId = Number(accountIdRaw);
          if (!Number.isNaN(parsedAccountId)) accountId = parsedAccountId;
        }
        if (!accountSlug) {
          accountSlug = infoJson?.data?.account?.slug ?? null;
        }
        if (!userId) {
          const userIdRaw = infoJson?.data?.me?.id;
          const parsedUserId = Number(userIdRaw);
          if (!Number.isNaN(parsedUserId)) userId = parsedUserId;
        }
      }
    }

    if (!accountId || Number.isNaN(accountId)) {
      console.error("Missing account id for monday tenant", {
        tokenJson,
        infoJson,
        state
      });
      return NextResponse.json({ error: "Account lookup failed" }, { status: 500 });
    }

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
