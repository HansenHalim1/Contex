import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { normaliseAccountId } from "@/lib/normaliseAccountId";
import { normalisePlanId, planFromSku } from "@/lib/plans";

type MondayEvent = {
  type?: string;
  event?: string;
  account_id?: string | number;
  plan_id?: string | null;
  plan?: string | null;
  sku?: string | null;
  board_id?: string | number | null;
  boardId?: string | number | null;
  payload?: Record<string, any>;
};

function extractField(payload: Record<string, any> | undefined | null, keys: string[]): any {
  if (!payload) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      const value = payload[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

async function updateTenantPlan(accountId: string | number, planCandidate: string | null | undefined, skuCandidate: string | null | undefined, status: string) {
  const normalisedPlan = (() => {
    if (skuCandidate) {
      const details = planFromSku(skuCandidate);
      if (details?.plan) return details.plan;
    }
    return normalisePlanId(planCandidate);
  })();

  await supabaseAdmin
    .from("tenants")
    .update({
      plan: normalisedPlan,
      pending_plan: null,
      billing_status: status,
      updated_at: new Date().toISOString()
    })
    .eq("account_id", accountId);
}

async function purgeBoard(accountId: string | number, mondayBoardId: string) {
  const { data: tenant } = await supabaseAdmin
    .from("tenants")
    .select("id")
    .eq("account_id", accountId)
    .maybeSingle();
  if (!tenant?.id) return;

  const { data: board } = await supabaseAdmin
    .from("boards")
    .select("id")
    .eq("tenant_id", tenant.id)
    .eq("monday_board_id", mondayBoardId)
    .maybeSingle();

  if (!board?.id) return;

  const boardUuid = String(board.id);

  await Promise.allSettled([
    supabaseAdmin.from("files").delete().eq("board_id", boardUuid),
    supabaseAdmin.from("board_viewers").delete().eq("board_id", boardUuid),
    supabaseAdmin.from("notes").delete().eq("board_id", boardUuid),
    supabaseAdmin.from("note_snapshots").delete().eq("board_id", boardUuid)
  ]);

  await supabaseAdmin.from("boards").delete().eq("id", boardUuid);
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-monday-signature");
  const rawBody = await req.text();

  if (process.env.MONDAY_SIGNING_SECRET) {
    if (!signature?.includes(process.env.MONDAY_SIGNING_SECRET)) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
    }
  }

  let event: MondayEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const type = String(event.type || event.event || "").toUpperCase();
  const accountIdRaw =
    event.account_id ??
    extractField(event.payload, ["account_id", "accountId"]) ??
    null;

  const normalisedAccount = normaliseAccountId(
    accountIdRaw != null ? String(accountIdRaw) : null
  );

  if (!normalisedAccount) {
    return NextResponse.json({ error: "missing_account" }, { status: 400 });
  }

  try {
    switch (type) {
      case "BILLING_PURCHASED":
      case "BILLING_UPGRADED": {
        const planCandidateRaw =
          event.plan_id ??
          event.plan ??
          extractField(event.payload, ["plan", "plan_id", "planId"]);
        const skuCandidateRaw =
          event.sku ??
          extractField(event.payload, ["sku", "plan_sku", "planSku"]);

        const planCandidate = planCandidateRaw != null ? String(planCandidateRaw) : null;
        const skuCandidate = skuCandidateRaw != null ? String(skuCandidateRaw) : null;

        await updateTenantPlan(normalisedAccount, planCandidate, skuCandidate, "active");
        break;
      }
      case "BILLING_CANCELED": {
        await updateTenantPlan(normalisedAccount, "free", null, "canceled");
        break;
      }
      case "BOARD_DELETED": {
        const boardCandidate =
          event.board_id ??
          event.boardId ??
          extractField(event.payload, ["board_id", "boardId"]);
        if (boardCandidate != null) {
          await purgeBoard(normalisedAccount, String(boardCandidate));
        }
        break;
      }
      default:
        break;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("monday webhook failed", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
