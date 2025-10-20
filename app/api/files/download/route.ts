import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertViewerAllowed } from "@/lib/viewerAccess";

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
    const fileId = searchParams.get("fileId");
    if (!boardId || !fileId) return NextResponse.json({ error: "missing ids" }, { status: 400 });

    const { board } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });
    if (auth.userId) {
      await assertViewerAllowed({ boardId: board.id, mondayUserId: auth.userId });
    }
    const { data: file } = await supabaseAdmin.from("files").select("storage_path,name").eq("id", fileId).eq("board_id", board.id).single();

    if (!file) return NextResponse.json({ error: "file not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(file.storage_path, 60);
    if (error) throw error;

    return NextResponse.json({ url: data.signedUrl, name: file.name });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: e?.message || "Failed to download file" }, { status });
  }
}
