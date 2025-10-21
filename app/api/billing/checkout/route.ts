import { NextRequest, NextResponse } from "next/server";
import mondaySdk from "monday-sdk-js";
import { supabaseAdmin } from "@/lib/supabase";
import { getPlanSku, planFromSku, PLAN_SKU_KEYS, type PlanSkuKey } from "@/lib/plans";

type CheckoutRequest = {
  tenantId?: string;
  planId?: string;
};

export async function POST(req: NextRequest) {
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
