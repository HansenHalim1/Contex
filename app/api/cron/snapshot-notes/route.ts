import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";

function verifyCronAuth(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("CRON_SECRET environment variable is not set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const header = req.headers.get("authorization");
  if (!header) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expected = `Bearer ${cronSecret}`;
  const expectedBuffer = Buffer.from(expected, "utf-8");
  const providedBuffer = Buffer.from(header, "utf-8");

  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

export async function GET(req: NextRequest) {
  const authError = verifyCronAuth(req);
  if (authError) return authError;

  try {
    // Ultra tenants only
    const { data: tenants, error: te } = await supabaseAdmin.from("tenants").select("id, plan").eq("plan", "ultra");
    if (te) throw te;
    const today = new Date().toISOString().slice(0, 10);

    for (const t of tenants || []) {
      // Boards of tenant
      const { data: boards, error: be } = await supabaseAdmin.from("boards").select("id").eq("tenant_id", t.id);
      if (be) throw be;

      for (const b of boards || []) {
        const { data: n } = await supabaseAdmin.from("notes").select("html").eq("board_id", b.id).maybeSingle();
        const html = n?.html || "";

        // Upsert snapshot
        await supabaseAdmin.from("note_snapshots").upsert({ board_id: b.id, html, snapshot_date: today });
        // Keep last 7 days
        await supabaseAdmin.rpc("prune_snapshots", { p_board_id: b.id });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
