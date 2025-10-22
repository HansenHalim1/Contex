import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertViewerAllowedWithRollback } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "usage-read", 30, 60_000);

    const { searchParams } = new URL(req.url);
    const boardId = searchParams.get("boardId");
    if (!boardId) return NextResponse.json({ error: "missing boardId" }, { status: 400 });

    const { tenant, board, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });
    if (!tenant?.access_token) {
      return NextResponse.json({ error: "Missing monday access token" }, { status: 500 });
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

    const status = e?.status === 403 ? 403 : e?.status === 429 ? 429 : 500;
    if (status >= 500) {
      console.error("Usage fetch failed:", e);
    }
    const payload: Record<string, any> = { error: "Failed to load usage" };
    if (e?.status === 429 && typeof e?.retryAfter === "number") {
      payload.retryAfter = e.retryAfter;
    }
    return NextResponse.json(payload, { status });
  }
}
