import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard, getUsage } from "@/lib/tenancy";
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
    const { boardId, filename, contentType, sizeBytes } = await req.json();
    if (!boardId || !filename || !sizeBytes) return NextResponse.json({ error: "bad request" }, { status: 400 });

    const { tenant, board, caps } = await resolveTenantBoard({
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
    const usageState = await getUsage(tenant.id);
    const storageUsed = usageState.usage.storageUsed;
    const maxStorage = caps.maxStorage ?? usageState.caps.maxStorage;

    if (maxStorage != null && storageUsed + Number(sizeBytes) > maxStorage) {
      throw new LimitError("storage", caps.plan, "Storage cap exceeded");
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

    const status = e?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: e?.message || "Failed to prepare upload" }, { status });
  }
}

function cryptoRandom(len: number) {
  const bytes = new Uint8Array(len);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
