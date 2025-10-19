import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get("accountId");
    const boardId = searchParams.get("boardId");
    const q = searchParams.get("q") || "";
    if (!accountId || !boardId) return NextResponse.json({ error: "missing ids" }, { status: 400 });

    const { board } = await resolveTenantBoard({ accountId, boardId });

    let query = supabaseAdmin.from("files").select("id,name,size_bytes,content_type").eq("board_id", board.id).order("created_at", { ascending: false });
    if (q) query = query.ilike("name", `%${q}%`);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ files: data || [] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
