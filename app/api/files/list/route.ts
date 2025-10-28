import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
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
    await enforceRateLimit(req, "files-list", 60, 60_000);

    const { searchParams } = new URL(req.url);
    const boardIdParam = searchParams.get("boardId");
    const normalizedBoardId = boardIdParam ? boardIdParam.trim() : "";
    const rawSearch = searchParams.get("q");
    const q = rawSearch ? rawSearch.trim().slice(0, 120) : "";
    if (!normalizedBoardId || normalizedBoardId.length > 128) {
      return NextResponse.json({ error: "missing boardId" }, { status: 400 });
    }

    const { board, tenant, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId: normalizedBoardId,
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

    let query = supabaseAdmin.from("files").select("id,name,size_bytes,content_type").eq("board_id", board.id).order("created_at", { ascending: false });
    if (q) query = query.ilike("name", `%${q}%`);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ files: data || [] });
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
      console.error("File listing failed:", e);
    }
    const payload: Record<string, any> = { error: "Failed to list files" };
    if (e?.status === 429 && typeof e?.retryAfter === "number") {
      payload.retryAfter = e.retryAfter;
    }
    return NextResponse.json(payload, { status });
  }
}
