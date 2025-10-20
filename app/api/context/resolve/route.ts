import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertViewerAllowed } from "@/lib/viewerAccess";

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

    const { tenant, board, caps } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    if (auth.userId) {
      await assertViewerAllowed({
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        mondayUserId: auth.userId,
        tenantAccessToken: tenant.access_token
      });
    }

    return NextResponse.json({
      tenantId: tenant.id,
      boardId: board.id,
      plan: tenant.plan,
      caps
    });
  } catch (e: any) {
    const isForbidden = e?.status === 403 || e?.message === "boards cap exceeded";
    const status = isForbidden ? 403 : 500;
    return NextResponse.json({ error: e?.message || "unexpected error" }, { status });
  }
}
