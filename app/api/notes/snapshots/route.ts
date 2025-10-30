import { NextRequest, NextResponse } from "next/server";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
import { assertViewerAllowedWithRollback } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { normalisePlanId, planSupportsSnapshots } from "@/lib/plans";

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "notes-snapshots-list", 30, 60_000);

    const { searchParams } = new URL(req.url);
    const boardId = searchParams.get("boardId");
    if (!boardId || boardId.trim().length > 128) {
      return NextResponse.json({ error: "missing boardId" }, { status: 400 });
    }

    const { tenant, board, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    const planId = normalisePlanId(tenant.plan ?? "free");
    if (!planSupportsSnapshots(planId)) {
      return NextResponse.json({ snapshots: [] });
    }

    if (auth.userId) {
      await assertViewerAllowedWithRollback({
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        mondayUserId: auth.userId,
        tenantAccessToken: tenant.access_token,
        boardWasCreated
      });
    }

    const { data, error } = await supabaseAdmin
      .from("note_snapshots")
      .select("id,html,snapshot_date,created_at")
      .eq("board_id", board.id)
      .order("snapshot_date", { ascending: false })
      .limit(7);

    if (error) throw error;

    return NextResponse.json({ snapshots: data ?? [] });
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("Snapshot list failed:", error);
    const status = error?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: "Failed to load snapshots" }, { status });
  }
}
