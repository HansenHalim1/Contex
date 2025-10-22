import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";
import { assertViewerAllowedWithRollback, fetchViewerRoles } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";

type ViewerStatus = "allowed" | "restricted";

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "viewers-status", 20, 60_000);

    const { boardId, mondayUserId, status } = (await req.json()) as {
      boardId?: string;
      mondayUserId?: string;
      status?: ViewerStatus;
    };

    if (!boardId || !mondayUserId || !status) {
      return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    if (status !== "allowed" && status !== "restricted") {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const { tenant, board, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    if (!tenant?.access_token) {
      return NextResponse.json({ error: "Missing monday access token" }, { status: 500 });
    }

    const actorId = auth.userId ? String(auth.userId) : null;
    const targetId = String(mondayUserId);

    if (!actorId) {
      return NextResponse.json({ error: "Unable to determine current user" }, { status: 403 });
    }

    const roleMap = await fetchViewerRoles(tenant.access_token, board.monday_board_id, [actorId, targetId]);
    const actorRole = roleMap.get(actorId) ?? { isAdmin: false, isOwner: false };

    if (!actorRole.isAdmin) {
      return NextResponse.json({ error: "Only account admins can manage viewer access" }, { status: 403 });
    }

    const targetRole = roleMap.get(targetId) ?? { isAdmin: false, isOwner: false };

    if (actorId === targetId) {
      return NextResponse.json({ error: "You cannot change your own access" }, { status: 400 });
    }

    if (targetRole.isAdmin || targetRole.isOwner) {
      if (status === "restricted") {
        return NextResponse.json({ error: "Admins and board owners cannot be restricted" }, { status: 400 });
      }
    }

    await assertViewerAllowedWithRollback({
      boardUuid: board.id,
      mondayBoardId: board.monday_board_id,
      mondayUserId: auth.userId,
      tenantAccessToken: tenant.access_token,
      boardWasCreated
    });

    await upsertBoardViewer({
      boardId: String(board.id),
      mondayUserId: String(mondayUserId),
      accessToken: tenant.access_token,
      status: targetRole.isAdmin || targetRole.isOwner ? "allowed" : status
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error instanceof LimitError) {
      return NextResponse.json(
        {
          error: "limit_reached",
          upgradeRequired: true,
          currentPlan: error.plan,
          limit: error.kind
        },
        { status: 403 }
      );
    }

    if (process.env.NODE_ENV !== "production") console.error("viewer status update failed:", error);
    const status = error?.status === 403 ? 403 : error?.status === 429 ? 429 : 500;
    const payload: Record<string, any> = { error: "Failed to update viewer status" };
    if (error?.status === 429 && typeof error?.retryAfter === "number") {
      payload.retryAfter = error.retryAfter;
    }
    return NextResponse.json(payload, { status });
  }
}
