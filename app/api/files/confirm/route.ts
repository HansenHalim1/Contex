import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard, incrementStorage } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";

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

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
