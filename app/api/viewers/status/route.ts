import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";
import { assertViewerAllowed } from "@/lib/viewerAccess";

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

    const { tenant, board } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    if (auth.userId) {
      await assertViewerAllowed({ boardId: board.id, mondayUserId: auth.userId });
    }

    await upsertBoardViewer({
      boardId: String(board.id),
      mondayUserId: String(mondayUserId),
      accessToken: tenant.access_token,
      status
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("viewer status update failed:", error?.message);
    const status = error?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: error?.message || "Failed to update viewer status" }, { status });
  }
}
