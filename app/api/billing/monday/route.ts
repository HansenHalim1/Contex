import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";
import { verifyMondaySignature } from "@/lib/verifyMondaySignature";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-monday-signature");
  const body = await req.text();

  try {
    if (!verifyMondaySignature({ payload: body, signature: sig, secret: process.env.MONDAY_SIGNING_SECRET })) {
      return NextResponse.json({ error: "Bad signature" }, { status: 403 });
    }
  } catch (error) {
    console.error("monday billing signature verification failed", error);
    return NextResponse.json({ error: "misconfigured_signature_verification" }, { status: 500 });
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (!event.payload?.account_id || !event.payload?.plan) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const accountKey = normaliseAccountId(event.payload.account_id);
  if (accountKey == null) {
    return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
  }
  const plan = String(event.payload.plan).toLowerCase();

  const { error } = await supabaseAdmin
    .from("tenants")
    .update({ plan, updated_at: new Date().toISOString() })
    .eq("account_id", accountKey);

  if (error) throw error;
  return NextResponse.json({ ok: true });
}
