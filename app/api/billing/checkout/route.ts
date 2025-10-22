import { NextRequest, NextResponse } from "next/server";
import mondaySdk from "monday-sdk-js";
import { supabaseAdmin } from "@/lib/supabase";
import { getPlanSku, planFromSku, PLAN_SKU_KEYS, type PlanSkuKey } from "@/lib/plans";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertAccountAdmin } from "@/lib/viewerAccess";
import { normaliseAccountId } from "@/lib/normaliseAccountId";

type CheckoutRequest = {
  tenantId?: string;
  planId?: string;
};

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: CheckoutRequest;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const tenantId = payload.tenantId?.trim();
  const planIdRaw = payload.planId?.trim() as PlanSkuKey | undefined;

  if (!tenantId || !planIdRaw) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  if (!PLAN_SKU_KEYS.includes(planIdRaw)) {
    return NextResponse.json({ error: "unsupported_plan" }, { status: 400 });
  }

  const sku = getPlanSku(planIdRaw);
  if (!sku) {
    return NextResponse.json({ error: "sku_not_configured" }, { status: 500 });
  }

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("id, account_id, access_token")
    .eq("id", tenantId)
    .maybeSingle();

  if (tenantError) {
    console.error("Failed to load tenant for billing checkout", tenantError);
    return NextResponse.json({ error: "tenant_lookup_failed" }, { status: 500 });
  }

  if (!tenant?.id || !tenant.account_id) {
    return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
  }

  const authAccount = normaliseAccountId(auth.accountId);
  if (authAccount == null || String(authAccount) !== String(tenant.account_id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!auth.userId) {
    return NextResponse.json({ error: "Missing monday user context" }, { status: 403 });
  }

  if (!tenant.access_token) {
    return NextResponse.json({ error: "Missing monday access token" }, { status: 500 });
  }

  try {
    await assertAccountAdmin({
      accessToken: tenant.access_token,
      mondayUserId: auth.userId
    });
  } catch (error: any) {
    const status = error?.status === 403 ? 403 : error?.status === 502 ? 502 : 500;
    const message = error?.message || "Failed to confirm admin access";
    return NextResponse.json({ error: message }, { status });
  }

  const mondayToken = process.env.MONDAY_API_TOKEN;
  if (!mondayToken) {
    console.error("MONDAY_API_TOKEN env var is not configured");
    return NextResponse.json({ error: "billing_disabled" }, { status: 500 });
  }

  const sdk = mondaySdk();
  sdk.setToken(mondayToken);

  try {
    const result = await sdk.api(
      `
        mutation ($sku: String!) {
          billing_create_checkout (sku: $sku) {
            url
          }
        }
      `,
      { variables: { sku } }
    );

    const checkoutUrl = result?.data?.billing_create_checkout?.url;
    if (!checkoutUrl) {
      console.error("monday.billing.create_checkout did not return a url", result);
      return NextResponse.json({ error: "checkout_failed" }, { status: 502 });
    }

    const skuMeta = planFromSku(sku);
    const pendingPlan = skuMeta?.plan ?? planIdRaw;

    const { error } = await supabaseAdmin
      .from("tenants")
      .update({
        pending_plan: planIdRaw,
        billing_status: "pending",
        updated_at: new Date().toISOString()
      })
      .eq("id", tenantId);

    if (error) {
      console.error("Failed to persist billing checkout state", error);
      return NextResponse.json({ error: "persist_failed" }, { status: 500 });
    }

    return NextResponse.json({
      url: checkoutUrl,
      plan: pendingPlan
    });
  } catch (error: any) {
    console.error("monday.billing.create_checkout failed", error);
    return NextResponse.json({ error: "checkout_error" }, { status: 502 });
  }
}
