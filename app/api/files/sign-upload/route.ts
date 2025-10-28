import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { LimitError, resolveTenantBoard, getUsage } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertViewerAllowedWithRollback } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";

const MAX_UPLOAD_SIZE = 512 * 1024 * 1024; // 512 MB upper bound guard
const FILENAME_MAX_LENGTH = 200;
const CONTENT_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/i;

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

    const normalizedBoardId =
      typeof boardId === "string"
        ? boardId.trim()
        : typeof boardId === "number"
        ? String(boardId)
        : "";
    const rawFilename = typeof filename === "string" ? filename : "";
    const trimmedFilename = rawFilename.trim().slice(0, FILENAME_MAX_LENGTH);
    const parsedSize = Number(sizeBytes);

    if (
      !normalizedBoardId ||
      !trimmedFilename ||
      normalizedBoardId.length > 128 ||
      Number.isNaN(parsedSize) ||
      !Number.isFinite(parsedSize) ||
      parsedSize <= 0 ||
      parsedSize > MAX_UPLOAD_SIZE
    ) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }

    const sanitizedContentTypeCandidate = typeof contentType === "string" ? contentType.trim() : "";
    const sanitizedContentType =
      sanitizedContentTypeCandidate && CONTENT_TYPE_PATTERN.test(sanitizedContentTypeCandidate)
        ? sanitizedContentTypeCandidate.slice(0, 100)
        : "application/octet-stream";

    const { tenant, board, caps, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId: normalizedBoardId,
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

    const safeNameBase = trimmedFilename.replace(/[^\w.\-]/g, "_");
    const safeName = safeNameBase.replace(/^_+|_+$/g, "") || "file";
    const storagePath = `tenant_${tenant.id}/board_${board.id}/${cryptoRandom(8)}-${safeName}`;

    // Create a signed upload URL (Supabase defaults to a short expiry)
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);
    if (error) throw error;

    return NextResponse.json({
      uploadUrl: data.signedUrl,
      storagePath,
      expectedSize: parsedSize,
      contentType: sanitizedContentType
    });
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
