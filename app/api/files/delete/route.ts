import { NextRequest, NextResponse } from "next/server";
import { LimitError, resolveTenantBoard, incrementStorage } from "@/lib/tenancy";
import { supabaseAdmin, BUCKET } from "@/lib/supabase";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { assertViewerAllowedWithRollback, ensureEditorAccess } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { normalisePlanId, planSupportsRecoveryVault } from "@/lib/plans";

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "files-delete", 25, 60_000);

    const payload = (await req.json()) as { boardId?: unknown; fileId?: unknown };
    const normalizedBoardId =
      typeof payload.boardId === "string"
        ? payload.boardId.trim()
        : typeof payload.boardId === "number"
        ? String(payload.boardId)
        : "";
    const normalizedFileId = typeof payload.fileId === "string" ? payload.fileId.trim() : "";

    if (!normalizedBoardId || !normalizedFileId || normalizedBoardId.length > 128 || normalizedFileId.length > 128) {
      return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    const { tenant, board, boardWasCreated } = await resolveTenantBoard({
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
    await ensureEditorAccess({
      boardUuid: board.id,
      mondayBoardId: board.monday_board_id,
      mondayUserId: auth.userId,
      tenantAccessToken: tenant.access_token
    });

    const planId = normalisePlanId(tenant.plan ?? "free");
    const supportsRecovery = planSupportsRecoveryVault(planId);

    const { data: fileRow, error: fileError } = await supabaseAdmin
      .from("files")
      .select("id,storage_path,size_bytes,name,content_type")
      .eq("id", normalizedFileId)
      .eq("board_id", board.id)
      .maybeSingle();

    if (fileError) throw fileError;
    if (!fileRow) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    let movedToVault = false;
    let vaultPath: string | null = null;

    if (supportsRecovery && fileRow.storage_path) {
      const vaultFolder = `tenant_${tenant.id}/vault/board_${board.id}`;
      const sanitizedName = (fileRow.name || "file").replace(/[^\w.\-]/g, "_") || "file";
      vaultPath = `${vaultFolder}/${fileRow.id}-${Date.now()}-${sanitizedName}`;

      const { error: moveError } = await supabaseAdmin.storage.from(BUCKET).move(fileRow.storage_path, vaultPath);
      if (!moveError) {
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const { error: recordError } = await supabaseAdmin.from("file_recovery").insert({
          tenant_id: tenant.id,
          board_id: board.id,
          original_file_id: fileRow.id,
          name: fileRow.name,
          size_bytes: fileRow.size_bytes,
          content_type: fileRow.content_type,
          storage_path: vaultPath,
          original_storage_path: fileRow.storage_path,
          deleted_by: auth.userId || "unknown",
          deleted_at: new Date().toISOString(),
          expires_at: expiresAt
        });

        if (recordError) {
          console.error("Failed to persist recovery vault entry:", recordError);
          const { error: revertError } = await supabaseAdmin.storage
            .from(BUCKET)
            .move(vaultPath, fileRow.storage_path);
          if (revertError) {
            console.error("Failed to revert recovery vault move:", revertError);
          }
        } else {
          movedToVault = true;
        }
      } else {
        console.error("Failed to move file into recovery vault:", moveError);
      }
    }

    if (!movedToVault && fileRow.storage_path) {
      const { error: storageError } = await supabaseAdmin.storage.from(BUCKET).remove([fileRow.storage_path]);
      if (storageError) {
        console.error("Supabase storage remove failed:", storageError);
      }
    }

    const { error: deleteError } = await supabaseAdmin
      .from("files")
      .delete()
      .eq("id", normalizedFileId)
      .eq("board_id", board.id);
    if (deleteError) throw deleteError;

    if (fileRow.size_bytes) {
      await incrementStorage(tenant.id, -Number(fileRow.size_bytes));
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error instanceof LimitError) {
      return NextResponse.json(
        {
          error: "limit_reached",
          upgradeRequired: true,
          currentPlan: error.plan,
          limit: error.kind
        },
        { status: 403 }
      );
    }

    if (process.env.NODE_ENV !== "production") console.error("File delete failed:", error);
    const status = error?.status === 403 ? 403 : error?.status === 429 ? 429 : 500;
    const payload: Record<string, any> = {
      error: status === 403 && typeof error?.message === "string" ? error.message : "Failed to delete file"
    };
    if (error?.status === 429 && typeof error?.retryAfter === "number") {
      payload.retryAfter = error.retryAfter;
    }
    return NextResponse.json(payload, { status });
  }
}
