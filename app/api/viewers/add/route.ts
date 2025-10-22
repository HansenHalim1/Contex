import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";
import { assertViewerAllowed, fetchViewerRoles } from "@/lib/viewerAccess";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { boardId, mondayUserId } = await req.json();
    if (!boardId || !mondayUserId) return NextResponse.json({ error: "Missing" }, { status: 400 });

    const { board, tenant, caps } = await resolveTenantBoard({
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
      await assertViewerAllowed({
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        mondayUserId: auth.userId,
        tenantAccessToken: tenant.access_token
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

    const initialStatus = targetRole.isAdmin || targetRole.isOwner ? "allowed" : "restricted";

    if (!existingViewer) {
      const usageDetails = await getUsage(tenant.id);
      const maxViewers = caps.maxViewers ?? usageDetails.caps.maxViewers;
      if (maxViewers != null && usageDetails.usage.viewersUsed >= maxViewers) {
        throw new LimitError("viewers", caps.plan, "Viewer limit reached");
      }
    }

    await upsertBoardViewer({
      boardId: String(board.id),
      mondayUserId,
      accessToken: tenant.access_token,
      status: existingViewer
        ? (existingViewer.status === "restricted" ? "restricted" : "allowed")
        : initialStatus
    });

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

    const status = e?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: e?.message || "Failed to add viewer" }, { status });
  }
}
