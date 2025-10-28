import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";
import { encryptSecret, decryptTenantAuthFields } from "@/lib/tokenEncryption";
import { normaliseMondayRegion, resolveMondayApiUrl } from "@/lib/mondayApiUrl";

export const runtime = "nodejs";

const STATE_COOKIE = "monday_oauth_state";

function clearStateCookie(response: NextResponse) {
  response.cookies.set({
    name: STATE_COOKIE,
    value: "",
    path: "/",
    expires: new Date(0)
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state") || undefined;
  const storedState = req.cookies.get(STATE_COOKIE)?.value;

  if (!code) {
    const res = NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
    clearStateCookie(res);
    return res;
  }

  if (!state || !storedState) {
    const res = NextResponse.json({ error: "Invalid OAuth state" }, { status: 400 });
    clearStateCookie(res);
    return res;
  }

  const stateBuffer = Buffer.from(state, "utf-8");
  const storedBuffer = Buffer.from(storedState, "utf-8");
  if (stateBuffer.length !== storedBuffer.length || !timingSafeEqual(stateBuffer, storedBuffer)) {
    const res = NextResponse.json({ error: "Invalid OAuth state" }, { status: 400 });
    clearStateCookie(res);
    return res;
  }

  try {
    const clientId = process.env.MONDAY_CLIENT_ID;
    const clientSecret = process.env.MONDAY_CLIENT_SECRET;
    const redirectUri = `${process.env.NEXT_PUBLIC_BASE_URL}/api/monday/oauth/callback`;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("Missing monday OAuth env vars");
      const res = NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
      clearStateCookie(res);
      return res;
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
    const redactedTokenJson = (() => {
      if (!tokenJson || typeof tokenJson !== "object") return tokenJson;
      const clone: Record<string, any> = Array.isArray(tokenJson) ? [...tokenJson] : { ...tokenJson };
      const redactKeys = (target: Record<string, any>) => {
        ["access_token", "refresh_token", "id_token"].forEach((key) => {
          if (key in target) target[key] = "***redacted***";
        });
      };
      redactKeys(clone);
      if (clone?.data && typeof clone.data === "object") {
        redactKeys(clone.data as Record<string, any>);
      }
      if (clone?.scope_data && typeof clone.scope_data === "object") {
        redactKeys(clone.scope_data as Record<string, any>);
      }
      return clone;
    })();
    if (!tokenRes.ok) {
      console.error("Token exchange HTTP error", {
        status: tokenRes.status,
        payload: redactedTokenJson,
        redirectUri,
        clientId: clientId.slice(0, 6) + "...",
        state
      });
      const res = NextResponse.json(
        { error: "Token exchange failed", details: redactedTokenJson, status: tokenRes.status },
        { status: 500 }
      );
      clearStateCookie(res);
      return res;
    }
    const accessToken = tokenJson?.access_token;
    if (!accessToken) {
      console.error("Token exchange payload missing access token", {
        payload: redactedTokenJson,
        redirectUri,
        state
      });
      const res = NextResponse.json(
        { error: "Token exchange failed", details: redactedTokenJson },
        { status: 500 }
      );
      clearStateCookie(res);
      return res;
    }

    const region = normaliseMondayRegion(searchParams.get("region"));
    const mondayApiUrl = resolveMondayApiUrl(region);

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

      const res = NextResponse.json(
        {
          error: "Account lookup failed",
          details: {
            tokenMeta,
            infoMeta
          }
        },
        { status: 500 }
      );
      clearStateCookie(res);
      return res;
    }

    const upsertPayload = {
      account_id: accountId,
      monday_account_id: accountId,
      account_slug: accountSlug,
      user_id: userId,
      updated_at: new Date().toISOString()
    };

    const { data: existingTenantRaw, error: tenantLookupError } = await supabaseAdmin
      .from("tenants")
      .select("id, access_token, refresh_token")
      .eq("account_id", accountId)
      .maybeSingle();

    if (tenantLookupError) {
      console.error("Supabase tenant lookup failed", tenantLookupError);
      const res = NextResponse.json({ error: "Database save failed" }, { status: 500 });
      clearStateCookie(res);
      return res;
    }

    const existingTenant = decryptTenantAuthFields(existingTenantRaw);

    let dbErr = null;
    if (existingTenant?.id) {
      const { error } = await supabaseAdmin
        .from("tenants")
        .update({
          ...upsertPayload,
          access_token: encryptSecret(accessToken),
          refresh_token: tokenJson?.refresh_token
            ? encryptSecret(tokenJson.refresh_token)
            : existingTenant?.refresh_token
            ? encryptSecret(existingTenant.refresh_token)
            : null
        })
        .eq("id", existingTenant.id);
      dbErr = error ?? null;
    } else {
      const { error } = await supabaseAdmin
        .from("tenants")
        .insert({
          ...upsertPayload,
          access_token: encryptSecret(accessToken),
          refresh_token: tokenJson?.refresh_token ? encryptSecret(tokenJson.refresh_token) : null
        });
      dbErr = error ?? null;
    }

    if (dbErr) {
      console.error("Supabase save error:", dbErr);
      const res = NextResponse.json({ error: "Database save failed" }, { status: 500 });
      clearStateCookie(res);
      return res;
    }

    const redirectResponse = NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/success`);
    clearStateCookie(redirectResponse);
    return redirectResponse;
  } catch (err) {
    console.error("OAuth callback failed:", err);
    const res = NextResponse.json({ error: "OAuth callback failed" }, { status: 500 });
    clearStateCookie(res);
    return res;
  }
}
