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
    if (!boardId) return NextResponse.json({ error: "Missing boardId" }, { status: 400 });

    const { board } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    const { data, error } = await supabaseAdmin
      .from("board_viewers")
      .select("monday_user_id")
      .eq("board_id", board.id);
    if (error) throw error;

    return NextResponse.json({ viewers: data?.map((row) => row.monday_user_id) ?? [] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
