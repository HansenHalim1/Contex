import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard, incrementStorage } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";
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
    const { boardId, fileId } = (await req.json()) as { boardId?: string; fileId?: string };
    if (!boardId || !fileId) {
      return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    const { tenant, board } = await resolveTenantBoard({
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

    const { data: fileRow, error: fileError } = await supabaseAdmin
      .from("files")
      .select("id,storage_path,size_bytes")
      .eq("id", fileId)
      .eq("board_id", board.id)
      .maybeSingle();

    if (fileError) throw fileError;
    if (!fileRow) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    if (fileRow.storage_path) {
      const { error: storageError } = await supabaseAdmin.storage.from(BUCKET).remove([fileRow.storage_path]);
      if (storageError) {
        console.error("Supabase storage remove failed:", storageError);
      }
    }

    const { error: deleteError } = await supabaseAdmin.from("files").delete().eq("id", fileId).eq("board_id", board.id);
    if (deleteError) throw deleteError;

    if (fileRow.size_bytes) {
      await incrementStorage(tenant.id, -Number(fileRow.size_bytes));
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error instanceof LimitError) {
      return NextResponse.json(
        {
          error: "limit_reached",
          upgradeRequired: true,
          currentPlan: error.plan,
          limit: error.kind
        },
        { status: 403 }
      );
    }

    if (process.env.NODE_ENV !== "production") console.error("File delete failed:", error?.message);
    const status = error?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: error?.message || "Failed to delete file" }, { status });
  }
}
