import { NextRequest, NextResponse } from "next/server";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";
import { decryptSecret } from "@/lib/tokenEncryption";
import { assertAccountAdmin } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "board-admin-delete-toggle", 10, 60_000);

    const body = await req.json().catch(() => null);
    const allow = body?.allow;
    if (typeof allow !== "boolean") {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }

    if (!auth.userId) {
      return NextResponse.json({ error: "Missing monday user context" }, { status: 403 });
    }

    const accountKey = normaliseAccountId(auth.accountId);
    if (accountKey == null) {
      return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
    }

    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from("tenants")
      .select("id, account_id, access_token, board_admin_delete_enabled")
      .eq("account_id", accountKey)
      .maybeSingle();

    if (tenantError) {
      console.error("Tenant lookup failed when toggling board admin delete permission:", tenantError);
      return NextResponse.json({ error: "tenant_lookup_failed" }, { status: 500 });
    }

    if (!tenant?.id) {
      return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
    }

    const accessToken = decryptSecret(tenant.access_token ?? null);
    if (!accessToken) {
      return NextResponse.json({ error: "Missing monday access token" }, { status: 500 });
    }

    try {
      await assertAccountAdmin({
        accessToken,
        mondayUserId: auth.userId
      });
    } catch (error: any) {
      const status = error?.status === 403 ? 403 : error?.status === 502 ? 502 : 500;
      if (status >= 500) {
        console.error("Account admin verification failed when toggling board admin delete permission:", error);
      }
      return NextResponse.json({ error: "admin_required" }, { status });
    }

    const { error: updateError } = await supabaseAdmin
      .from("tenants")
      .update({
        board_admin_delete_enabled: allow,
        updated_at: new Date().toISOString()
      })
      .eq("id", tenant.id);

    if (updateError) {
      console.error("Failed to persist board admin delete permission toggle:", updateError);
      return NextResponse.json({ error: "persist_failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, boardAdminDeleteEnabled: allow });
  } catch (error: any) {
    console.error("Board admin delete permission toggle failed:", error);
    return NextResponse.json({ error: "unexpected_error" }, { status: 500 });
  }
}
