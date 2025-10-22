import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard, incrementStorage, getUsage } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";
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
    const parsedSize = Number(sizeBytes);
    if (!boardId || !name || Number.isNaN(parsedSize) || !Number.isFinite(parsedSize) || parsedSize <= 0 || !storagePath) {
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

    let actualSize = parsedSize;
    try {
      const { data: signed, error: signedError } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(storagePath, 60);
      if (signedError || !signed?.signedUrl) {
        throw signedError ?? new Error("Signed URL generation failed");
      }
      const headResponse = await fetch(signed.signedUrl, { method: "HEAD" });
      if (!headResponse.ok) {
        throw new Error(`HEAD request failed with status ${headResponse.status}`);
      }
      const lengthHeader = headResponse.headers.get("content-length");
      if (lengthHeader != null) {
        actualSize = Number(lengthHeader);
      }
    } catch (metadataError) {
      console.error("Supabase storage metadata lookup failed:", metadataError);
      return NextResponse.json({ error: "Storage metadata lookup failed" }, { status: 500 });
    }

    if (!Number.isFinite(actualSize) || actualSize <= 0) {
      return NextResponse.json({ error: "Invalid stored file size" }, { status: 400 });
    }

    // Ensure storage cap is still respected with actual size
    const usageDetails = await getUsage(tenant.id);
    const storageCap = usageDetails.caps.maxStorage;
    if (storageCap != null && usageDetails.usage.storageUsed + actualSize > storageCap) {
      await supabaseAdmin.storage.from(BUCKET).remove([storagePath]).catch((err) => {
        console.error("Failed to remove oversized upload", err);
      });
      throw new LimitError("storage", usageDetails.plan, "Storage cap exceeded");
    }

    // Insert file row
    const { error } = await supabaseAdmin.from("files").insert({
      board_id: board.id,
      name,
      size_bytes: actualSize,
      storage_path: storagePath,
      content_type: contentType || "application/octet-stream",
      uploaded_by: auth.userId || "unknown"
    });
    if (error) throw error;

    // Account storage
    await incrementStorage(tenant.id, actualSize);

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
    return NextResponse.json({ error: e?.message || "Failed to confirm upload" }, { status });
  }
}
