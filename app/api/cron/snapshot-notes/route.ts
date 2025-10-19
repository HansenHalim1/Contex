import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
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
