import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertViewerAllowedWithRollback, fetchViewerRoles } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "viewers-remove", 15, 60_000);

    const { boardId, mondayUserId } = await req.json();
    if (!boardId || !mondayUserId) return NextResponse.json({ error: "Missing" }, { status: 400 });

    const { board, tenant, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    if (!auth.userId) {
      return NextResponse.json({ error: "Unable to determine current user" }, { status: 403 });
    }

    await assertViewerAllowedWithRollback({
      boardUuid: board.id,
      mondayBoardId: board.monday_board_id,
      mondayUserId: auth.userId,
      tenantAccessToken: tenant.access_token,
      boardWasCreated
    });

    let roleMap;
    try {
      roleMap = await fetchViewerRoles(tenant.access_token, board.monday_board_id, [String(auth.userId), String(mondayUserId)]);
    } catch (roleError) {
      console.error("Failed to verify admin privileges:", roleError);
      return NextResponse.json({ error: "Failed to verify admin privileges" }, { status: 502 });
    }

    const actorRole = roleMap.get(String(auth.userId)) ?? { isAdmin: false, isOwner: false };
    if (!actorRole.isAdmin) {
      return NextResponse.json({ error: "Only account admins can manage viewers" }, { status: 403 });
    }

    const targetRole = roleMap.get(String(mondayUserId)) ?? { isAdmin: false, isOwner: false };
    if (targetRole.isAdmin || targetRole.isOwner) {
      return NextResponse.json({ error: "Admins and board owners cannot be removed" }, { status: 400 });
    }

    if (String(auth.userId) === String(mondayUserId)) {
      return NextResponse.json({ error: "You cannot remove your own access" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("board_viewers")
      .delete()
      .eq("board_id", board.id)
      .eq("monday_user_id", mondayUserId);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof LimitError) {
      return NextResponse.json(
        {
          error: "limit_reached",
          upgradeRequired: true,
          currentPlan: e.plan,
          limit: e.kind
        },
        { status: 403 }
      );
    }

    const status = e?.status === 403 ? 403 : e?.status === 429 ? 429 : 500;
    if (status >= 500) {
      console.error("Viewer removal failed:", e);
    }
    const payload: Record<string, any> = { error: "Failed to remove viewer" };
    if (e?.status === 429 && typeof e?.retryAfter === "number") {
      payload.retryAfter = e.retryAfter;
    }
    return NextResponse.json(payload, { status });
  }
}
