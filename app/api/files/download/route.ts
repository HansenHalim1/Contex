import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";
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
    await enforceRateLimit(req, "files-download", 40, 60_000);

    const { searchParams } = new URL(req.url);
    const boardId = searchParams.get("boardId");
    const fileId = searchParams.get("fileId");
    if (!boardId || !fileId) return NextResponse.json({ error: "missing ids" }, { status: 400 });

    const { board, tenant, boardWasCreated } = await resolveTenantBoard({
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
    const { data: file } = await supabaseAdmin.from("files").select("storage_path,name").eq("id", fileId).eq("board_id", board.id).single();

    if (!file) return NextResponse.json({ error: "file not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(file.storage_path, 60);
    if (error) throw error;

    return NextResponse.json({ url: data.signedUrl, name: file.name });
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
      console.error("File download failed:", e);
    }
    const payload: Record<string, any> = { error: "Failed to download file" };
    if (e?.status === 429 && typeof e?.retryAfter === "number") {
      payload.retryAfter = e.retryAfter;
    }
    return NextResponse.json(payload, { status });
  }
}
