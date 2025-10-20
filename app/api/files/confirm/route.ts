import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard, incrementStorage } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";
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
    const { boardId, name, sizeBytes, contentType, storagePath } = await req.json();
    if (!boardId || !name || !sizeBytes || !storagePath) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
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

    // Insert file row
    const { error } = await supabaseAdmin.from("files").insert({
      board_id: board.id,
      name,
      size_bytes: Number(sizeBytes),
      storage_path: storagePath,
      content_type: contentType || "application/octet-stream",
      uploaded_by: auth.userId || "unknown"
    });
    if (error) throw error;

    // Account storage
    await incrementStorage(tenant.id, Number(sizeBytes));

    if (auth.userId) {
      const accessToken = tenant.access_token;
      try {
        await upsertBoardViewer({
          boardId: String(board.id),
          mondayUserId: auth.userId,
          accessToken
        });
      } catch (viewerError) {
        console.error("Failed to upsert default viewer", viewerError);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: e?.message || "Failed to confirm upload" }, { status });
  }
}
