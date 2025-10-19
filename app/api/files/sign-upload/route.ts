import { NextRequest, NextResponse } from "next/server";
import { resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";
import { capsByPlan } from "@/lib/plans";

export async function POST(req: NextRequest) {
  try {
    const { accountId, boardId, filename, contentType, sizeBytes } = await req.json();
    if (!accountId || !boardId || !filename || !sizeBytes) return NextResponse.json({ error: "bad request" }, { status: 400 });

    const { tenant, board, caps } = await resolveTenantBoard({ accountId, boardId });
    const usage = await getUsage(tenant.id);

    // Storage check
    if (usage.storageUsed + Number(sizeBytes) > caps.maxStorage) {
      return NextResponse.json({ error: "storage cap exceeded" }, { status: 403 });
    }

    const safeName = filename.replace(/[^\w.\-]/g, "_");
    const storagePath = `tenant_${tenant.id}/board_${board.id}/${cryptoRandom(8)}-${safeName}`;

    // Create a signed upload URL (Supabase defaults to a short expiry)
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);
    if (error) throw error;

    return NextResponse.json({ uploadUrl: data.signedUrl, storagePath });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

function cryptoRandom(len: number) {
  const bytes = new Uint8Array(len);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
