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
    const actorIsAdmin = Boolean(actorRole.isAdmin);
    const actorIsBoardAdmin = Boolean(actorRole.isOwner);
    const planAllowsBoardAdminPromotion = caps.plan === "pro" || caps.plan === "enterprise";
    const boardAdminSelfPromotion =
      !actorIsAdmin && actorIsBoardAdmin && planAllowsBoardAdminPromotion && requestedRole === "editor";

    if (!actorIsAdmin && !boardAdminSelfPromotion) {
      return NextResponse.json(
        { error: "Only account admins can manage viewer access" },
        { status: 403 }
      );
    }

    if (boardAdminSelfPromotion && requestedRole !== "editor") {
      return NextResponse.json(
        { error: "Board admins can only promote viewers to admin on this plan" },
        { status: 403 }
      );
    }

    const targetRole = roleMap.get(targetId) ?? { isAdmin: false, isOwner: false };
    const targetIsBoardAdmin = Boolean(targetRole.isOwner);
    const targetIsAccountAdmin = Boolean(targetRole.isAdmin);
    const actorCanOverrideBoardAdmin = actorIsAdmin && (caps.plan === "pro" || caps.plan === "enterprise");

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

    if (targetIsAccountAdmin) {
      if (requestedRole === "restricted") {
        return NextResponse.json({ error: "Account admins cannot be restricted" }, { status: 400 });
      }
    }

    if (targetIsBoardAdmin && !actorCanOverrideBoardAdmin && requestedRole !== "editor") {
      return NextResponse.json(
        { error: "Only account admins on Pro or Enterprise can change board admin access" },
        { status: 403 }
      );
    }

    if (targetIsBoardAdmin && requestedRole === "restricted" && !actorCanOverrideBoardAdmin) {
      return NextResponse.json({ error: "Board admins cannot be restricted" }, { status: 400 });
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
      status:
        targetIsAccountAdmin || (targetIsBoardAdmin && !actorCanOverrideBoardAdmin) ? "allowed" : storedStatus
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
