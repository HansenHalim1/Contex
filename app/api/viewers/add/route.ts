import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";
import { assertViewerAllowedWithRollback, fetchViewerRoles, enforceBoardViewerLimit } from "@/lib/viewerAccess";
import { supabaseAdmin } from "@/lib/supabase";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { allowedRolesForPlan, fromStoredStatus, normaliseRoleInput, toStoredStatus, type ViewerRole } from "@/lib/viewerRoles";

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "viewers-add", 15, 60_000);

    const payload = await req.json();
    const boardId = typeof payload.boardId === "string" ? payload.boardId.trim() : "";
    const mondayUserId = typeof payload.mondayUserId === "string" ? payload.mondayUserId.trim() : "";
    const requestedRole = normaliseRoleInput(payload.role ?? payload.status);
    if (!boardId || !mondayUserId) return NextResponse.json({ error: "Missing" }, { status: 400 });

    const { board, tenant, caps, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    if (!tenant?.access_token) {
      return NextResponse.json({ error: "Missing monday access token" }, { status: 500 });
    }

    if (!auth.userId) {
      return NextResponse.json({ error: "Unable to determine current user" }, { status: 403 });
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

    let roleMap: Map<string, { isAdmin: boolean; isOwner: boolean }> = new Map();
    const actorId = String(auth.userId);
    const targetId = String(mondayUserId);
    try {
      roleMap = await fetchViewerRoles(tenant.access_token, board.monday_board_id, [actorId, targetId]);
    } catch (roleError) {
      console.error("Failed to verify viewer roles:", roleError);
      return NextResponse.json({ error: "Failed to verify admin privileges" }, { status: 502 });
    }

    const actorRole = roleMap.get(actorId) ?? { isAdmin: false, isOwner: false };
    if (!actorRole.isAdmin) {
      return NextResponse.json({ error: "Only account admins can manage viewers" }, { status: 403 });
    }

    const targetRole = roleMap.get(targetId) ?? { isAdmin: false, isOwner: false };

    const { data: existingViewer, error: existingViewerError } = await supabaseAdmin
      .from("board_viewers")
      .select("board_id,status")
      .eq("board_id", board.id)
      .eq("monday_user_id", mondayUserId)
      .maybeSingle();
    if (existingViewerError) {
      console.error("viewer lookup failed", existingViewerError);
    }

    const allowedRoles = allowedRolesForPlan(caps.plan);
    let desiredRole: ViewerRole = "viewer";
    if (requestedRole && allowedRoles.includes(requestedRole)) {
      desiredRole = requestedRole;
    } else if (requestedRole && !allowedRoles.includes(requestedRole)) {
      return NextResponse.json(
        { error: "Role not available on current plan", allowedRoles },
        { status: 403 }
      );
    }

    if (targetRole.isAdmin || targetRole.isOwner) {
      desiredRole = "viewer";
    }

    const storedDesiredStatus = toStoredStatus(desiredRole);
    const existingViewerRole = existingViewer ? fromStoredStatus(existingViewer.status) : null;

    if (!(targetRole.isAdmin || targetRole.isOwner) && desiredRole !== "restricted") {
      const usageDetails = await getUsage(tenant.id);
      const maxViewers = caps.maxViewers ?? usageDetails.caps.maxViewers;
      if (maxViewers != null) {
        const willAdd = existingViewerRole && existingViewerRole !== "restricted" ? 0 : 1;
        if (usageDetails.usage.viewersUsed + willAdd > maxViewers) {
          throw new LimitError("viewers", caps.plan, "Viewer limit reached");
        }
      }
    }

    await upsertBoardViewer({
      boardId: String(board.id),
      mondayUserId,
      accessToken: tenant.access_token,
      status: storedDesiredStatus
    });

    if (caps.maxViewers != null) {
      await enforceBoardViewerLimit({
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        tenantAccessToken: tenant.access_token,
        viewerLimit: caps.maxViewers
      });
    }

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
      console.error("Viewer add failed:", e);
    }
    const payload: Record<string, any> = { error: "Failed to add viewer" };
    if (e?.status === 429 && typeof e?.retryAfter === "number") {
      payload.retryAfter = e.retryAfter;
    }
    return NextResponse.json(payload, { status });
  }
}
