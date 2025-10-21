import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertViewerAllowed } from "@/lib/viewerAccess";

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

    const { tenant, board } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });
    if (!tenant?.access_token) {
      return NextResponse.json({ error: "Missing monday access token" }, { status: 500 });
    }
    if (auth.userId) {
      await assertViewerAllowed({
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        mondayUserId: auth.userId,
        tenantAccessToken: tenant.access_token
      });
    }
    const usageDetails = await getUsage(tenant.id);

    return NextResponse.json({
      plan: usageDetails.plan,
      boardsUsed: usageDetails.usage.boardsUsed,
      boardsCap: usageDetails.caps.maxBoards,
      storageUsed: usageDetails.usage.storageUsed,
      storageCap: usageDetails.caps.maxStorage,
      viewersUsed: usageDetails.usage.viewersUsed,
      viewersCap: usageDetails.caps.maxViewers
    });
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
    return NextResponse.json({ error: e?.message || "Failed to load usage" }, { status });
  }
}
