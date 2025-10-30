import { NextRequest, NextResponse } from "next/server";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { resolveTenantBoard, incrementStorage } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";
import { assertViewerAllowedWithRollback, ensureEditorAccess } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { normalisePlanId, planSupportsRecoveryVault } from "@/lib/plans";

function buildFallbackPath(originalPath: string, boardId: string, fileId: string) {
  const baseDir = originalPath.includes("/") ? originalPath.slice(0, originalPath.lastIndexOf("/")) : "";
  const extension = originalPath.includes(".") ? originalPath.slice(originalPath.lastIndexOf(".")) : "";
  const safeDir = baseDir || `tenant_unknown/board_${boardId}`;
  return `${safeDir}/${fileId}-${Date.now()}${extension}`;
}

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "files-recovery-restore", 15, 60_000);

    const { boardId, recoveryId } = (await req.json()) as { boardId?: string; recoveryId?: string };
    if (!boardId || !recoveryId) {
      return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    const { tenant, board, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    const planId = normalisePlanId(tenant.plan ?? "free");
    if (!planSupportsRecoveryVault(planId)) {
      return NextResponse.json({ error: "Recovery vault unavailable" }, { status: 403 });
    }

    if (auth.userId) {
      await assertViewerAllowedWithRollback({
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        mondayUserId: auth.userId,
        tenantAccessToken: tenant.access_token,
        boardWasCreated
      });
    }

    await ensureEditorAccess({
      boardUuid: board.id,
      mondayBoardId: board.monday_board_id,
      mondayUserId: auth.userId,
      tenantAccessToken: tenant.access_token
    });

    const { data: record, error: recordError } = await supabaseAdmin
      .from("file_recovery")
      .select(
        "id,original_file_id,name,size_bytes,content_type,storage_path,original_storage_path,deleted_at"
      )
      .eq("id", recoveryId)
      .eq("board_id", board.id)
      .is("restored_at", null)
      .maybeSingle();

    if (recordError) throw recordError;
    if (!record) {
      return NextResponse.json({ error: "File not found in recovery vault" }, { status: 404 });
    }

    const now = new Date();
    const deletedAt = record.deleted_at ? new Date(record.deleted_at) : null;
    if (deletedAt && now.getTime() - deletedAt.getTime() > 7 * 24 * 60 * 60 * 1000) {
      return NextResponse.json({ error: "Recovery window expired" }, { status: 410 });
    }

    let restorePath = record.original_storage_path || "";
    if (!restorePath) {
      restorePath = `tenant_${tenant.id}/board_${board.id}/${record.original_file_id || record.id}-${Date.now()}`;
    }

    const moveResult = await supabaseAdmin.storage.from(BUCKET).move(record.storage_path, restorePath);
    if (moveResult.error) {
      const fallbackPath = buildFallbackPath(restorePath, String(board.id), String(record.original_file_id || record.id));
      const fallbackResult = await supabaseAdmin.storage.from(BUCKET).move(record.storage_path, fallbackPath);
      if (fallbackResult.error) {
        console.error("Recovery vault restore move failed:", fallbackResult.error);
        return NextResponse.json({ error: "Failed to restore file contents" }, { status: 500 });
      }
      restorePath = fallbackPath;
    }

    const insertPayload: Record<string, any> = {
      board_id: board.id,
      name: record.name,
      size_bytes: record.size_bytes,
      storage_path: restorePath,
      content_type: record.content_type,
      uploaded_by: auth.userId || "unknown",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (record.original_file_id) {
      insertPayload.id = record.original_file_id;
    }

    const { error: insertError } = await supabaseAdmin.from("files").insert(insertPayload);
    if (insertError) {
      console.error("Failed to reinsert restored file:", insertError);
      // move file back to vault path to avoid losing track
      await supabaseAdmin.storage.from(BUCKET).move(restorePath, record.storage_path).catch((err) => {
        console.error("Failed to move file back to vault after insert error:", err);
      });
      return NextResponse.json({ error: "Failed to restore file" }, { status: 500 });
    }

    await supabaseAdmin
      .from("file_recovery")
      .update({ restored_at: new Date().toISOString(), restored_by: auth.userId || "unknown" })
      .eq("id", record.id);

    if (record.size_bytes) {
      await incrementStorage(tenant.id, Number(record.size_bytes));
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("Recovery restore failed:", error);
    const status = error?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: "Failed to restore file" }, { status });
  }
}
