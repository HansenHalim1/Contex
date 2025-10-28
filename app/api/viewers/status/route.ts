import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";
import { assertViewerAllowedWithRollback, fetchViewerRoles, enforceBoardViewerLimit } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { supabaseAdmin } from "@/lib/supabase";
import {
  allowedRolesForPlan,
  fromStoredStatus,
  normaliseRoleInput,
  toStoredStatus,
  type ViewerRole
} from "@/lib/viewerRoles";

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

    const body = (await req.json()) as {
      boardId?: string;
      mondayUserId?: string;
      role?: string;
      status?: string; // backwards compatibility
    };

    const boardId = typeof body.boardId === "string" ? body.boardId.trim() : "";
    const mondayUserId = typeof body.mondayUserId === "string" ? body.mondayUserId.trim() : "";

    const requestedRole = normaliseRoleInput(body.role ?? body.status);

    if (!boardId || !mondayUserId || !requestedRole) {
      return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    const { tenant, board, caps, boardWasCreated } = await resolveTenantBoard({
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

    const allowedRoles = allowedRolesForPlan(caps.plan);
    if (!allowedRoles.includes(requestedRole)) {
      return NextResponse.json(
        { error: "Role not available on current plan", allowedRoles },
        { status: 403 }
      );
    }

    if (targetRole.isAdmin || targetRole.isOwner) {
      if (requestedRole === "restricted") {
        return NextResponse.json({ error: "Admins and board owners cannot be restricted" }, { status: 400 });
      }
    }

    const storedStatus = toStoredStatus(requestedRole);
    const viewerLimit = caps.maxViewers ?? null;

    let existingViewerRole: ViewerRole | null = null;
    if (viewerLimit != null) {
      const { data: existingViewer } = await supabaseAdmin
        .from("board_viewers")
        .select("status")
        .eq("board_id", board.id)
        .eq("monday_user_id", mondayUserId)
        .maybeSingle();

      existingViewerRole = fromStoredStatus(existingViewer?.status ?? null);

      if (requestedRole !== "restricted" && !(targetRole.isAdmin || targetRole.isOwner)) {
        const usage = await getUsage(tenant.id);
        const allowedCount = usage.usage.viewersUsed;
        const willAdd = existingViewerRole && existingViewerRole !== "restricted" ? 0 : 1;
        if (allowedCount + willAdd > viewerLimit) {
          throw new LimitError("viewers", caps.plan, "Viewer limit reached");
        }
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
      status: targetRole.isAdmin || targetRole.isOwner ? "allowed" : storedStatus
    });

    if (viewerLimit != null) {
      await enforceBoardViewerLimit({
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        tenantAccessToken: tenant.access_token,
        viewerLimit
      });
    }

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
