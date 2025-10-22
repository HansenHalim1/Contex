import { NextRequest, NextResponse } from "next/server";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { fetchViewerRoles } from "@/lib/viewerAccess";
import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";
import { deleteBoardWithData } from "@/lib/deleteBoard";

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { boardUuid, mondayBoardId } = (await req.json()) as {
      boardUuid?: string;
      mondayBoardId?: string;
    };

    if (!boardUuid && !mondayBoardId) {
      return NextResponse.json({ error: "Missing board identifiers" }, { status: 400 });
    }

    if (!auth.userId) {
      return NextResponse.json({ error: "Unable to determine current user" }, { status: 403 });
    }

    const accountKey = normaliseAccountId(auth.accountId);
    if (accountKey == null) {
      return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
    }

    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from("tenants")
      .select("id, account_id, access_token")
      .eq("account_id", accountKey)
      .maybeSingle();

    if (tenantError) {
      console.error("Tenant lookup failed", tenantError);
      return NextResponse.json({ error: "Tenant lookup failed" }, { status: 500 });
    }

    if (!tenant?.id) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    const boardQuery = supabaseAdmin
      .from("boards")
      .select("id, tenant_id, monday_board_id")
      .eq("tenant_id", tenant.id);

    const { data: board, error: boardError } = boardUuid
      ? await boardQuery.eq("id", boardUuid).maybeSingle()
      : await boardQuery.eq("monday_board_id", mondayBoardId).maybeSingle();

    if (boardError && boardError.code !== "PGRST116") {
      console.error("Board lookup failed", boardError);
      return NextResponse.json({ error: "Board lookup failed" }, { status: 500 });
    }

    if (!board?.id) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }

    if (String(board.tenant_id) !== String(tenant.id)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!tenant.access_token) {
      return NextResponse.json({ error: "Missing monday access token" }, { status: 500 });
    }

    const actorId = String(auth.userId);
    const roles = await fetchViewerRoles(tenant.access_token, board.monday_board_id, [actorId]);
    const actorRole = roles.get(actorId) ?? { isAdmin: false, isOwner: false };
    if (!actorRole.isAdmin) {
      return NextResponse.json({ error: "Only account admins can delete board data" }, { status: 403 });
    }

    await deleteBoardWithData({
      boardId: String(board.id),
      tenantId: String(tenant.id)
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("Board deletion failed:", error);
    const status = error?.status === 403 ? 403 : 500;
    const message = error?.message || "Failed to delete board";
    return NextResponse.json({ error: message }, { status });
  }
}
