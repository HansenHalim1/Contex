import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

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

  const accountId = String(event.payload.account_id);
  const plan = String(event.payload.plan).toLowerCase();

  const { error } = await supabaseAdmin
    .from("tenants")
    .update({ plan, updated_at: new Date().toISOString() })
    .eq("monday_account_id", accountId);

  if (error) throw error;
  return NextResponse.json({ ok: true });
}
