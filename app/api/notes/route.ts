import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get("accountId");
    const boardId = searchParams.get("boardId");
    if (!accountId || !boardId) return NextResponse.json({ error: "missing ids" }, { status: 400 });

    const { board, tenant } = await resolveTenantBoard({ accountId, boardId });

    const { data: n } = await supabaseAdmin.from("notes").select("*").eq("board_id", board.id).maybeSingle();
    return NextResponse.json({
      html: n?.html ?? "",
      updated_at: n?.updated_at ?? null,
      boardUuid: board.id,
      mondayBoardId: board.monday_board_id,
      tenantId: tenant.id
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { accountId, boardId, html, userId } = await req.json();
    if (!accountId || !boardId) return NextResponse.json({ error: "missing ids" }, { status: 400 });
    const { board, tenant } = await resolveTenantBoard({ accountId, boardId });

    // upsert note
    const { data, error } = await supabaseAdmin
      .from("notes")
      .upsert({ board_id: board.id, html, updated_by: userId || "unknown", updated_at: new Date().toISOString() }, { onConflict: "board_id" })
      .select("*")
      .single();
    if (error) throw error;

    return NextResponse.json({
      updated_at: data.updated_at,
      boardUuid: board.id,
      mondayBoardId: board.monday_board_id,
      tenantId: tenant.id
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
