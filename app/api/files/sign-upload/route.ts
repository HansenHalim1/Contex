import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { LimitError, resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertViewerAllowedWithRollback } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "files-sign-upload", 15, 60_000);

    const { boardId, filename, contentType, sizeBytes } = await req.json();
    const parsedSize = Number(sizeBytes);
    if (!boardId || !filename || Number.isNaN(parsedSize) || !Number.isFinite(parsedSize) || parsedSize <= 0) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }

    const { tenant, board, caps, boardWasCreated } = await resolveTenantBoard({
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
    const usageState = await getUsage(tenant.id);
    const storageUsed = usageState.usage.storageUsed;
    const maxStorage = caps.maxStorage ?? usageState.caps.maxStorage;

    if (maxStorage != null && storageUsed + parsedSize > maxStorage) {
      throw new LimitError("storage", caps.plan, "Storage cap exceeded");
    }

    const safeName = filename.replace(/[^\w.\-]/g, "_");
    const storagePath = `tenant_${tenant.id}/board_${board.id}/${cryptoRandom(8)}-${safeName}`;

    // Create a signed upload URL (Supabase defaults to a short expiry)
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);
    if (error) throw error;

    return NextResponse.json({ uploadUrl: data.signedUrl, storagePath, expectedSize: parsedSize, contentType });
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
      console.error("File upload preparation failed:", e);
    }
    const payload: Record<string, any> = { error: "Failed to prepare upload" };
    if (e?.status === 429 && typeof e?.retryAfter === "number") {
      payload.retryAfter = e.retryAfter;
    }
    return NextResponse.json(payload, { status });
  }
}

function cryptoRandom(len: number) {
  return randomBytes(len).toString("hex");
}
