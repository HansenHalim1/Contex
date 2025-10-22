import { supabaseAdmin } from "./supabase";
import { defaultCapsByPlan, normalisePlanId, type PlanCaps, type PlanId } from "./plans";
import { normaliseAccountId } from "./normaliseAccountId";
import { enforceBoardViewerLimit } from "./viewerAccess";
import { decryptTenantAuthFields } from "./tokenEncryption";

export type ContextIds = {
  accountId: string; // monday account id
  boardId: string;   // monday board id
  userId?: string;
};

export class LimitError extends Error {
  status = 403;
  code = "limit_reached" as const;
  plan: PlanId;
  kind: "boards" | "storage" | "viewers";

  constructor(kind: "boards" | "storage" | "viewers", plan: PlanId, message: string) {
    super(message);
    this.plan = plan;
    this.kind = kind;
  }
}

type TenantRecord = {
  id: string;
  plan?: string | null;
  storage_bytes_used?: number | null;
};

type TenantCaps = PlanCaps & { plan: PlanId };

async function fetchPlanCaps(plan: PlanId): Promise<TenantCaps> {
  const defaults = defaultCapsByPlan[plan] ?? defaultCapsByPlan.free;

  try {
    const { data, error } = await supabaseAdmin
      .from("tenant_caps")
      .select("max_boards,max_storage,max_viewers")
      .eq("plan", plan)
      .maybeSingle();

    if (!error && data) {
      const caps: PlanCaps = {
        maxBoards: typeof data.max_boards === "number" ? data.max_boards : defaults.maxBoards,
        maxStorage: typeof data.max_storage === "number" ? data.max_storage : defaults.maxStorage,
        maxViewers: typeof data.max_viewers === "number" ? data.max_viewers : defaults.maxViewers
      };
      return { plan, ...caps };
    }

    if (error) {
      console.error("tenant_caps lookup failed", error);
    }
  } catch (error) {
    console.error("tenant_caps lookup threw", error);
  }

  return { plan, ...defaults };
}

async function countTenantBoards(tenantId: string) {
  const { data, error } = await supabaseAdmin
    .from("boards")
    .select("id")
    .eq("tenant_id", tenantId);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  return {
    total: rows.length,
    ids: rows.map((row) => String(row.id))
  };
}

async function countTenantViewers(boardIds: string[]) {
  if (!boardIds.length) {
    return 0;
  }

  const { count, error } = await supabaseAdmin
    .from("board_viewers")
    .select("id", { head: true, count: "exact" })
    .in("board_id", boardIds)
    .eq("status", "allowed");

  if (error) throw error;
  return count ?? 0;
}

export async function resolveTenantBoard(ctx: ContextIds) {
  const accountKey = normaliseAccountId(ctx.accountId);
  if (accountKey == null) {
    throw new Error("Missing account identifier");
  }

  // upsert tenant
  const { data: t0 } = await supabaseAdmin
    .from("tenants")
    .select("*")
    .eq("account_id", accountKey)
    .maybeSingle();

  let tenant = decryptTenantAuthFields(t0);
  if (!tenant) {
    const { data: t1, error } = await supabaseAdmin
      .from("tenants")
      .insert({ account_id: accountKey, plan: "free" })
      .select("*")
      .single();
    if (error) throw error;
    tenant = decryptTenantAuthFields(t1) ?? t1;
  }

  const planId = normalisePlanId(tenant.plan);
  const caps = await fetchPlanCaps(planId);

  // check if board exists already
  const { data: b0 } = await supabaseAdmin
    .from("boards")
    .select("*")
    .eq("tenant_id", tenant.id)
    .eq("monday_board_id", ctx.boardId)
    .maybeSingle();

  let board = b0;

  // count boards used prior to potential insert
  const { total: boardCount, ids: boardIds } = await countTenantBoards(tenant.id);
  let boardsUsed = boardCount;

  let boardWasCreated = false;

  if (!board) {
    if (caps.maxBoards != null && boardsUsed >= caps.maxBoards) {
      throw new LimitError("boards", planId, "Board limit reached");
    }

    const { data: b1, error } = await supabaseAdmin
      .from("boards")
      .insert({ tenant_id: tenant.id, monday_board_id: ctx.boardId })
      .select("*")
      .single();
    if (error) throw error;
    board = b1;
    boardsUsed += 1;
    boardIds.push(String(board.id));
    boardWasCreated = true;
  }

  if (caps.maxViewers != null) {
    try {
      await enforceBoardViewerLimit({
        boardUuid: board.id,
        mondayBoardId: board.monday_board_id,
        tenantAccessToken: tenant.access_token,
        viewerLimit: caps.maxViewers
      });
    } catch (limitError) {
      console.error("Viewer limit enforcement failed:", limitError);
    }
  }

  return {
    tenant,
    board,
    caps,
    boardsUsed,
    boardIds,
    boardWasCreated
  };
}

export async function getUsage(tenantId: string) {
  const { data: tenant, error } = await supabaseAdmin
    .from("tenants")
    .select("id, plan, storage_bytes_used")
    .eq("id", tenantId)
    .single();
  if (error) throw error;

  const planId = normalisePlanId((tenant as TenantRecord | null)?.plan);
  const caps = await fetchPlanCaps(planId);

  const { total: boardsUsed, ids: boardIds } = await countTenantBoards(tenantId);
  let viewersUsed = 0;
  try {
    viewersUsed = await countTenantViewers(boardIds);
  } catch (viewerError) {
    console.error("viewer count failed", viewerError);
  }

  return {
    plan: planId,
    caps,
    usage: {
      boardsUsed,
      storageUsed: Number((tenant as TenantRecord | null)?.storage_bytes_used) || 0,
      viewersUsed
    }
  };
}

export async function incrementStorage(tenantId: string, delta: number) {
  const { error } = await supabaseAdmin.rpc("increment_storage", { p_tenant_id: tenantId, p_delta: delta });
  if (error) throw error;
}
