import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get("accountId");
    const boardId = searchParams.get("boardId");
    const fileId = searchParams.get("fileId");
    if (!accountId || !boardId || !fileId) return NextResponse.json({ error: "missing ids" }, { status: 400 });

    const { board } = await resolveTenantBoard({ accountId, boardId });
    const { data: file } = await supabaseAdmin.from("files").select("storage_path,name").eq("id", fileId).eq("board_id", board.id).single();

    if (!file) return NextResponse.json({ error: "file not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(file.storage_path, 60);
    if (error) throw error;

    return NextResponse.json({ url: data.signedUrl, name: file.name });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
