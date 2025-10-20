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

    const region = searchParams.get("region")?.trim() || null;
    const mondayApiUrl = region ? `https://api-${region}.monday.com/v2` : "https://api.monday.com/v2";

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
          me { id name email }
          account { id name slug }
        }
      `;
      const infoRes = await fetch(mondayApiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: meQuery })
      });

      const infoText = await infoRes.text();
      try {
        infoJson = infoText ? JSON.parse(infoText) : null;
      } catch (parseErr) {
        console.error("Failed to parse monday profile response", {
          region,
          mondayApiUrl,
          infoText
        });
        infoJson = null;
      }

      if (!infoRes.ok) {
        console.error("monday profile query failed", {
          status: infoRes.status,
          infoJson,
          region,
          mondayApiUrl
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
      const tokenMeta = {
        account_id: tokenJson?.account_id ?? tokenJson?.data?.account_id ?? tokenJson?.scope_data?.account_id ?? null,
        account_slug:
          tokenJson?.account?.slug ?? tokenJson?.data?.account?.slug ?? tokenJson?.scope_data?.account?.slug ?? null,
        user_id: tokenJson?.user_id ?? tokenJson?.data?.user_id ?? tokenJson?.scope_data?.user_id ?? null
      };

      const infoMeta = {
        account_id: infoJson?.data?.account?.id ?? null,
        account_slug: infoJson?.data?.account?.slug ?? null,
        user_id: infoJson?.data?.me?.id ?? null,
        status: infoJson ? "ok" : "not_requested"
      };

      console.error("Missing account id for monday tenant", {
        tokenMeta,
        infoMeta,
        state
      });

      return NextResponse.json(
        {
          error: "Account lookup failed",
          details: {
            tokenMeta,
            infoMeta
          }
        },
        { status: 500 }
      );
    }

    const upsertPayload = {
      account_id: accountId,
      account_slug: accountSlug,
      user_id: userId,
      access_token: accessToken,
      updated_at: new Date().toISOString()
    };

    const { data: existingTenant, error: tenantLookupError } = await supabaseAdmin
      .from("tenants")
      .select("id")
      .eq("account_id", accountId)
      .maybeSingle();

    if (tenantLookupError) {
      console.error("Supabase tenant lookup failed", tenantLookupError);
      return NextResponse.json({ error: "Database save failed", details: tenantLookupError }, { status: 500 });
    }

    let dbErr = null;
    if (existingTenant?.id) {
      const { error } = await supabaseAdmin
        .from("tenants")
        .update(upsertPayload)
        .eq("id", existingTenant.id);
      dbErr = error ?? null;
    } else {
      const { error } = await supabaseAdmin.from("tenants").insert(upsertPayload);
      dbErr = error ?? null;
    }

    if (dbErr) {
      console.error("Supabase save error:", dbErr);
      return NextResponse.json({ error: "Database save failed", details: dbErr }, { status: 500 });
    }

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/connected`);
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return NextResponse.json({ error: "OAuth callback failed" }, { status: 500 });
  }
}
