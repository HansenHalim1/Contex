import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";
import { normalisePlanId, planFromSku } from "@/lib/plans";
import { verifyMondaySignature } from "@/lib/verifyMondaySignature";

type MondayBillingEvent = {
  type?: string;
  event?: string;
  payload?: any;
};

function extractAccountId(payload: any): string | null {
  if (!payload) return null;

  const candidates = [
    payload.account_id,
    payload.accountId,
    payload.account?.id,
    payload.account?.account_id,
    payload.account?.accountId
  ];

  const match = candidates.find((value) => typeof value === "string" || typeof value === "number");
  if (match == null) return null;
  return String(match);
}

function extractSku(payload: any): string | null {
  if (!payload) return null;
  const candidates = [
    payload.sku,
    payload.plan?.sku,
    payload.planSku,
    payload.billing?.sku
  ];
  const match = candidates.find((value) => typeof value === "string" && value.trim());
  return match ? String(match).trim() : null;
}

function extractPlan(payload: any): string | null {
  if (!payload) return null;
  const candidates = [
    payload.plan,
    payload.plan_id,
    payload.planId,
    payload.plan_type
  ];
  const match = candidates.find((value) => typeof value === "string" && value.trim());
  return match ? String(match).trim().toLowerCase() : null;
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-monday-signature");
  const rawBody = await req.text();

  try {
    if (!verifyMondaySignature({ payload: rawBody, signature, secret: process.env.MONDAY_SIGNING_SECRET })) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
    }
  } catch (error) {
    console.error("billing webhook signature verification failed", error);
    return NextResponse.json({ error: "misconfigured_signature_verification" }, { status: 500 });
  }

  let event: MondayBillingEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const type = String(event.type || event.event || "").toUpperCase();
  const accountIdRaw = extractAccountId(event.payload);
  if (!type || !accountIdRaw) {
    return NextResponse.json({ error: "missing_context" }, { status: 400 });
  }

  const accountKey = normaliseAccountId(accountIdRaw);
  if (accountKey == null) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 });
  }

  let plan = extractPlan(event.payload);
  const sku = extractSku(event.payload);

  if (sku) {
    const skuMeta = planFromSku(sku);
    if (skuMeta?.plan) {
      plan = skuMeta.plan;
    }
  }

  const normalisedPlan = normalisePlanId(plan);

  let update: Record<string, any> = {
    updated_at: new Date().toISOString(),
    pending_plan: null
  };

  switch (type) {
    case "BILLING_PURCHASED":
    case "BILLING_UPGRADED":
      update = {
        ...update,
        plan: normalisedPlan,
        billing_status: "active"
      };
      break;
    case "BILLING_CANCELED":
      update = {
        ...update,
        plan: "free",
        billing_status: "canceled"
      };
      break;
    default:
      console.warn("Unhandled monday billing event type", type);
      return NextResponse.json({ ok: true });
  }

  const { error } = await supabaseAdmin
    .from("tenants")
    .update(update)
    .eq("account_id", accountKey);

  if (error) {
    console.error("Failed to persist billing webhook update", error);
    return NextResponse.json({ error: "persist_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
