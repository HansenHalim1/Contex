import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { capsByPlan } from "@/lib/plans";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get("accountId");
    const boardId = searchParams.get("boardId");
    if (!accountId || !boardId) return NextResponse.json({ error: "missing ids" }, { status: 400 });

    const { tenant } = await resolveTenantBoard({ accountId, boardId });
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
