import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertViewerAllowedWithRollback } from "@/lib/viewerAccess";

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { boardId } = await req.json();
    if (!boardId) {
      return NextResponse.json({ error: "missing boardId" }, { status: 400 });
    }

    const { tenant, board, caps, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    if (auth.userId) {
      await assertViewerAllowedWithRollback({
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        mondayUserId: auth.userId,
        tenantAccessToken: tenant.access_token,
        boardWasCreated
      });
    }

    return NextResponse.json({
      tenantId: tenant.id,
      boardId: board.id,
      plan: caps.plan,
      caps
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

    const isForbidden = e?.status === 403;
    const status = isForbidden ? 403 : 500;
    if (status >= 500) {
      console.error("Context resolve failed:", e);
    }
    return NextResponse.json({ error: "unexpected error" }, { status });
  }
}
