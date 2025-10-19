import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const { accountId, boardId, mondayUserId } = await req.json();
    if (!accountId || !boardId || !mondayUserId) return NextResponse.json({ error: "Missing" }, { status: 400 });

    const { board, tenant } = await resolveTenantBoard({ accountId, boardId });

    // Only for premium+
    if (!["premium", "ultra"].includes(tenant.plan)) {
      return NextResponse.json({ error: "Not allowed in current plan" }, { status: 403 });
    }

    const { error } = await supabaseAdmin.from("board_viewers").insert({ board_id: board.id, monday_user_id: mondayUserId });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
