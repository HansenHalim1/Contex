import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";

export async function POST(req: NextRequest) {
  try {
    const { accountId, boardId } = await req.json();
    if (!accountId || !boardId) {
      return NextResponse.json({ error: "missing ids" }, { status: 400 });
    }

    const { tenant, board, caps } = await resolveTenantBoard({ accountId, boardId });

    return NextResponse.json({
      tenantId: tenant.id,
      boardId: board.id,
      plan: tenant.plan,
      caps
    });
  } catch (e: any) {
    const status = e?.status === 403 || e?.message === "boards cap exceeded" ? 403 : 500;
    return NextResponse.json({ error: e?.message || "unexpected error" }, { status });
  }
}
