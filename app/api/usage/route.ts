import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { capsByPlan } from "@/lib/plans";
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
    const usage = await getUsage(tenant.id);
    const caps = capsByPlan[usage.plan as keyof typeof capsByPlan];

    return NextResponse.json({
      boardsUsed: usage.boardsUsed,
      boardsCap: caps.maxBoards,
      storageUsed: usage.storageUsed,
      storageCap: caps.maxStorage
    });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: e?.message || "Failed to load usage" }, { status });
  }
}
