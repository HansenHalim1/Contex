import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const boardId = searchParams.get("boardId");
    if (!boardId) return NextResponse.json({ error: "missing boardId" }, { status: 400 });

    const { board, tenant } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

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
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { boardId, html } = await req.json();
    if (!boardId) return NextResponse.json({ error: "missing boardId" }, { status: 400 });

    const { board, tenant } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    // upsert note
    const { data, error } = await supabaseAdmin
      .from("notes")
      .upsert(
        {
          board_id: board.id,
          html,
          updated_by: auth.userId || "unknown",
          updated_at: new Date().toISOString()
        },
        { onConflict: "board_id" }
      )
      .select("*")
      .single();
    if (error) throw error;

    const responsePayload = {
      updated_at: data.updated_at,
      boardUuid: board.id,
      mondayBoardId: board.monday_board_id,
      tenantId: tenant.id
    };

    try {
      await supabaseAdmin
        .from("board_viewers")
        .upsert(
          {
            board_id: board.id,
            monday_user_id: auth.userId || "unknown",
            created_at: new Date().toISOString()
          },
          { onConflict: "board_id,monday_user_id" }
        );
    } catch (viewerError) {
      console.error("Failed to upsert default viewer", viewerError);
    }

    return NextResponse.json(responsePayload);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
