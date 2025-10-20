import { supabaseAdmin } from "./supabase";
import { capsByPlan } from "./plans";
import { normaliseAccountId } from "./normaliseAccountId";

export type ContextIds = {
  accountId: string; // monday account id
  boardId: string;   // monday board id
  userId?: string;
};

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

  let tenant = t0;
  if (!tenant) {
    const { data: t1, error } = await supabaseAdmin
      .from("tenants")
      .insert({ account_id: accountKey })
      .select("*")
      .single();
    if (error) throw error;
    tenant = t1;
  }

  // compute caps
  const plan = (tenant.plan || "free") as keyof typeof capsByPlan;
  const caps = capsByPlan[plan];

  // check if board exists already
  const { data: b0 } = await supabaseAdmin
    .from("boards")
    .select("*")
    .eq("tenant_id", tenant.id)
    .eq("monday_board_id", ctx.boardId)
    .maybeSingle();

  let board = b0;

  // count boards used prior to potential insert
  const { count } = await supabaseAdmin
    .from("boards")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant.id);

  let boardsUsed = count || 0;

  if (!board) {
    if (boardsUsed >= caps.maxBoards) {
      const err: Error & { status?: number } = new Error("boards cap exceeded");
      err.status = 403;
      throw err;
    }

    const { data: b1, error } = await supabaseAdmin
      .from("boards")
      .insert({ tenant_id: tenant.id, monday_board_id: ctx.boardId })
      .select("*")
      .single();
    if (error) throw error;
    board = b1;
    boardsUsed += 1;
  }

  return {
    tenant,
    board,
    caps,
    boardsUsed
  };
}

export async function getUsage(tenantId: string) {
  // storage from tenants.storage_bytes_used
  const { data: t, error } = await supabaseAdmin
    .from("tenants")
    .select("id, plan, storage_bytes_used")
    .eq("id", tenantId)
    .single();
  if (error) throw error;

  // counts boards
  const { count: boardsUsed } = await supabaseAdmin
    .from("boards")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenantId);

  return { plan: t.plan, storageUsed: Number(t.storage_bytes_used), boardsUsed: boardsUsed || 0 };
}

export async function incrementStorage(tenantId: string, delta: number) {
  const { error } = await supabaseAdmin.rpc("increment_storage", { p_tenant_id: tenantId, p_delta: delta });
  if (error) throw error;
}
