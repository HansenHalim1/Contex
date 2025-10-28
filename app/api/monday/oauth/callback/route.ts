import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual, createHmac } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";
import { encryptSecret, decryptTenantAuthFields } from "@/lib/tokenEncryption";
import { normaliseMondayRegion, resolveMondayApiUrl } from "@/lib/mondayApiUrl";

export const runtime = "nodejs";

const RAW_STATE_SECRET = process.env.MONDAY_OAUTH_STATE_SECRET || process.env.MONDAY_CLIENT_SECRET;

if (!RAW_STATE_SECRET) {
  throw new Error("MONDAY_OAUTH_STATE_SECRET or MONDAY_CLIENT_SECRET must be configured");
}

const STATE_SECRET = RAW_STATE_SECRET;

function signStateComponents(nonce: string, ts: string): string {
  return createHmac("sha256", STATE_SECRET).update(`${nonce}.${ts}`).digest("base64url");
}

function verifyState(state: string | null, maxAgeMs = 10 * 60 * 1000): boolean {
  if (!state) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  if (!nonce || !ts || !sig) return false;
  const expected = signStateComponents(nonce, ts);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }
  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp)) return false;
  if (Date.now() - timestamp > maxAgeMs) return false;
  return true;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  if (!state || !verifyState(state)) {
    return NextResponse.json({ error: "Invalid or missing state" }, { status: 400 });
  }

  try {
    const clientId = process.env.MONDAY_CLIENT_ID;
    const clientSecret = process.env.MONDAY_CLIENT_SECRET;
    const redirectUri = process.env.MONDAY_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("Missing monday OAuth env vars");
      const res = NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
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
        state: state
      });
      const res = NextResponse.json(
        { error: "Token exchange failed", details: redactedTokenJson, status: tokenRes.status },
        { status: 500 }
      );
      return res;
    }
    const accessToken = tokenJson?.access_token;
    if (!accessToken) {
      console.error("Token exchange payload missing access token", {
        payload: redactedTokenJson,
        redirectUri,
        state: state
      });
      const res = NextResponse.json(
        { error: "Token exchange failed", details: redactedTokenJson },
        { status: 500 }
      );
      return res;
    }

    const region = normaliseMondayRegion(searchParams.get("region"));
    const mondayApiUrl = resolveMondayApiUrl(region);

    const accountIdCandidate = normaliseAccountId(
      (tokenJson?.account_id ?? tokenJson?.data?.account_id ?? tokenJson?.scope_data?.account_id) ?? null
    );
    let accountId: number | null;
    if (typeof accountIdCandidate === "number") {
      accountId = Number.isFinite(accountIdCandidate) ? accountIdCandidate : null;
    } else if (typeof accountIdCandidate === "string") {
      const parsedAccountId = Number(accountIdCandidate);
      accountId = Number.isFinite(parsedAccountId) ? parsedAccountId : null;
    } else {
      accountId = null;
    }

    let accountSlug =
      tokenJson?.account?.slug ?? tokenJson?.data?.account?.slug ?? tokenJson?.scope_data?.account?.slug ?? null;

    const userIdCandidate =
      tokenJson?.user_id ?? tokenJson?.data?.user_id ?? tokenJson?.scope_data?.user_id ?? tokenJson?.data?.me?.id ?? null;
    let userId: number | null = null;
    if (userIdCandidate != null) {
      const parsedUserId = Number(userIdCandidate);
      userId = Number.isFinite(parsedUserId) ? parsedUserId : null;
    }

    let infoJson: any = null;

    if (accountId == null || userId == null) {
      const infoRes = await fetch(mondayApiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: `
            query {
              me { id }
              account { id slug }
            }
          `
        })
      });

      try {
        infoJson = await infoRes.json();
      } catch (err) {
        console.error("Failed to parse monday profile response", err);
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
        if (accountId == null) {
          const accountIdRaw = infoJson?.data?.account?.id;
          const parsedAccountId = Number(accountIdRaw);
          if (Number.isFinite(parsedAccountId)) accountId = parsedAccountId;
        }
        if (!accountSlug) {
          accountSlug = infoJson?.data?.account?.slug ?? null;
        }
        if (userId == null) {
          const userIdRaw = infoJson?.data?.me?.id;
          const parsedUserId = Number(userIdRaw);
          if (Number.isFinite(parsedUserId)) userId = parsedUserId;
        }
      }
    }

    if (accountId == null) {
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
        state: state
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
      return res;
    }

    const upsertPayload = {
      account_id: accountId,
      monday_account_id: accountId,
      account_slug: accountSlug,
        user_id: userId ?? null,
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
      return res;
    }

    const postAuthTarget = process.env.MONDAY_POST_AUTH_REDIRECT ?? "/success";
    const regionParam = region;
    let redirectUrl: URL;
    try {
      redirectUrl = postAuthTarget.startsWith("http")
        ? new URL(postAuthTarget)
        : new URL(postAuthTarget, req.nextUrl.origin);
    } catch {
      redirectUrl = new URL("/success", req.nextUrl.origin);
    }
    if (regionParam) {
      redirectUrl.searchParams.set("region", regionParam);
    }
    const redirectResponse = NextResponse.redirect(redirectUrl.toString());
    return redirectResponse;
  } catch (err) {
    console.error("OAuth callback failed:", err);
    const res = NextResponse.json({ error: "OAuth callback failed" }, { status: 500 });
    return res;
  }
}
