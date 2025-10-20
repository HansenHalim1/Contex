import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const mondayToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;

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

    const { board } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    await upsertBoardViewer({
      boardId: String(board.id),
      mondayUserId,
      mondayToken
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
