import { NextRequest, NextResponse } from "next/server";
import { verifyMondayAuth } from "@/lib/verifyMondayAuth";
import { resolveTenantBoard, LimitError } from "@/lib/tenancy";
import { supabaseAdmin } from "@/lib/supabase";
import { assertViewerAllowedWithRollback } from "@/lib/viewerAccess";
import { enforceRateLimit } from "@/lib/rateLimiter";
import { normaliseMondayRegion, resolveMondayApiUrl } from "@/lib/mondayApiUrl";

function normaliseBoardId(id: string | number) {
  const numeric = Number(id);
  return Number.isNaN(numeric) ? String(id) : numeric;
}

async function fetchBoardNames(accessToken: string, region: string | null, boardIds: string[]) {
  if (!boardIds.length) return new Map<string, string>();

  const endpoint = resolveMondayApiUrl(region);
  const result = new Map<string, string>();

  const chunkSize = 25;
  for (let i = 0; i < boardIds.length; i += chunkSize) {
    const chunk = boardIds.slice(i, i + chunkSize);
    const query = `
      query ($ids: [ID!]) {
        boards(ids: $ids) {
          id
          name
        }
      }
    `;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables: { ids: chunk.map(normaliseBoardId) } })
    });

    if (!res.ok) {
      const details = await res.text().catch(() => "");
      console.error("monday boards lookup failed", res.status, details);
      continue;
    }

    const json = await res.json().catch(() => null);
    const boards = Array.isArray(json?.data?.boards) ? json.data.boards : [];
    boards.forEach((board: any) => {
      if (!board) return;
      const id = String(board.id ?? "");
      const name = typeof board.name === "string" ? board.name : "";
      if (id) result.set(id, name);
    });
  }

  return result;
}

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await verifyMondayAuth(req);
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") console.error("verifyMondayAuth failed:", error?.message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const boardId = searchParams.get("boardId");
  const region = normaliseMondayRegion(searchParams.get("region"));

  if (!boardId) {
    return NextResponse.json({ error: "missing boardId" }, { status: 400 });
  }

  try {
    await enforceRateLimit(req, "boards-list", 30, 60_000);

    const { tenant, board, boardWasCreated } = await resolveTenantBoard({
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

    const { data, error } = await supabaseAdmin
      .from("boards")
      .select("id,monday_board_id,created_at")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    const mondayIds = rows.map((row) => String(row.monday_board_id || "")).filter(Boolean);

    const names = tenant.access_token
      ? await fetchBoardNames(tenant.access_token, region, mondayIds)
      : new Map<string, string>();

    const boards = rows.map((row) => ({
      boardUuid: String(row.id),
      mondayBoardId: String(row.monday_board_id),
      name: names.get(String(row.monday_board_id)) || null,
      createdAt: row.created_at
    }));

    return NextResponse.json({ boards });
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

    const status = error?.status === 403 ? 403 : error?.status === 429 ? 429 : 500;
    if (status >= 500) {
      console.error("Board list failed:", error);
    }
    const payload: Record<string, any> = { error: "Failed to load boards" };
    if (error?.status === 429 && typeof error?.retryAfter === "number") {
      payload.retryAfter = error.retryAfter;
    }
    return NextResponse.json(payload, { status });
  }
}
