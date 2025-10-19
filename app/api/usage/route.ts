import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { capsByPlan } from "@/lib/plans";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";

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

    const { tenant } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });
    const usage = await getUsage(tenant.id);
    const caps = capsByPlan[usage.plan as keyof typeof capsByPlan];

    return NextResponse.json({
      boardsUsed: usage.boardsUsed,
      boardsCap: caps.maxBoards,
      storageUsed: usage.storageUsed,
      storageCap: caps.maxStorage
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
