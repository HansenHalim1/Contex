import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-monday-signature");
  const body = await req.text();
  // Optionally verify with your MONDAY_SIGNING_SECRET
  if (process.env.MONDAY_SIGNING_SECRET && !sig?.includes(process.env.MONDAY_SIGNING_SECRET))
    return NextResponse.json({ error: "Bad signature" }, { status: 403 });

  const event = JSON.parse(body);

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
