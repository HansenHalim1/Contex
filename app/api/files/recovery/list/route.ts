import { NextRequest, NextResponse } from "next/server";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
import { assertViewerAllowedWithRollback, ensureEditorAccess } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { normalisePlanId, planSupportsRecoveryVault } from "@/lib/plans";

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "files-recovery-list", 30, 60_000);

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
    if (!planSupportsRecoveryVault(planId)) {
      return NextResponse.json({ files: [] });
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

    await ensureEditorAccess({
      boardUuid: board.id,
      mondayBoardId: board.monday_board_id,
      mondayUserId: auth.userId,
      tenantAccessToken: tenant.access_token
    });

    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("file_recovery")
      .select(
        "id,name,size_bytes,content_type,deleted_at,expires_at,deleted_by"
      )
      .eq("board_id", board.id)
      .is("restored_at", null)
      .gt("expires_at", nowIso)
      .order("deleted_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ files: data ?? [] });
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("Recovery list failed:", error);
    const status = error?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: "Failed to load recovery vault" }, { status });
  }
}
