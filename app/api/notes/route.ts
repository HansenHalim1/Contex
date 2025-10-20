import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";

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

    const boardRowId = String(board.id);

    const { data: n, error } = await supabaseAdmin
      .from("notes")
      .select("html, updated_at, updated_by, board_id")
      .eq("board_id", boardRowId)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      console.error("Supabase select error:", error);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    return NextResponse.json({
      html: n?.html ?? "",
      updated_at: n?.updated_at ?? null,
      updated_by: n?.updated_by ?? null,
      boardUuid: board.id,
      mondayBoardId: board.monday_board_id,
      tenantId: tenant.id
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const mondayToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;

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

    const boardRowId = String(board.id);

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("notes")
      .select("html, updated_at, updated_by")
      .eq("board_id", boardRowId)
      .maybeSingle();

    if (existingError && existingError.code !== "PGRST116") {
      console.error("Supabase select error:", existingError);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    if (existing?.html && !html.trim()) {
      return NextResponse.json({
        html: existing.html,
        updated_at: existing.updated_at,
        updated_by: existing.updated_by,
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        tenantId: tenant.id
      });
    }

    // upsert note
    const { data, error } = await supabaseAdmin
      .from("notes")
      .upsert(
        {
          board_id: boardRowId,
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

    if (auth.userId) {
      try {
        await upsertBoardViewer({
          boardId: String(board.id),
          mondayUserId: auth.userId,
          mondayToken
        });
      } catch (viewerError) {
        console.error("Failed to upsert default viewer", viewerError);
      }
    }

    return NextResponse.json(responsePayload);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}



