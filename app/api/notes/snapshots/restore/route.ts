import { NextRequest, NextResponse } from "next/server";
import sanitizeHtml, { type IOptions } from "sanitize-html";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { resolveTenantBoard } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
import { assertViewerAllowedWithRollback, ensureEditorAccess } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { normalisePlanId, planSupportsSnapshots } from "@/lib/plans";

const SANITIZE_OPTIONS: IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags,
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    "*": ["class", "style", "data-*"]
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  transformTags: {
    a(tagName, attribs) {
      const attrs = { ...attribs };
      if (attrs.target === "_blank") {
        attrs.rel = "noopener noreferrer";
      }
      return { tagName, attribs: attrs };
    }
  }
};

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enforceRateLimit(req, "notes-snapshots-restore", 10, 60_000);

    const { boardId, snapshotId } = (await req.json()) as { boardId?: string; snapshotId?: string };
    if (!boardId || !snapshotId) {
      return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    const { tenant, board, boardWasCreated } = await resolveTenantBoard({
      accountId: auth.accountId,
      boardId,
      userId: auth.userId
    });

    const planId = normalisePlanId(tenant.plan ?? "free");
    if (!planSupportsSnapshots(planId)) {
      return NextResponse.json({ error: "Version history not available" }, { status: 403 });
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

    const { data: snapshot, error } = await supabaseAdmin
      .from("note_snapshots")
      .select("html")
      .eq("id", snapshotId)
      .eq("board_id", board.id)
      .maybeSingle();

    if (error) throw error;
    if (!snapshot) {
      return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
    }

    const sanitizedHtml = sanitizeHtml(snapshot.html || "", SANITIZE_OPTIONS);

    const { error: upsertError } = await supabaseAdmin
      .from("notes")
      .upsert(
        {
          board_id: board.id,
          html: sanitizedHtml,
          updated_by: auth.userId || "unknown",
          updated_at: new Date().toISOString()
        },
        { onConflict: "board_id" }
      );

    if (upsertError) throw upsertError;

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("Snapshot restore failed:", error);
    const status = error?.status === 403 ? 403 : 500;
    return NextResponse.json({ error: "Failed to restore snapshot" }, { status });
  }
}
