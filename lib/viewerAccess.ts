import { supabaseAdmin } from "@/lib/supabase";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";
import { fromStoredStatus, type ViewerRole } from "@/lib/viewerRoles";

const MONDAY_API_URL = "https://api.monday.com/v2";

function normaliseGraphId(value: string): string | number {
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) return numeric;
  }
  return value;
}

export type ViewerRoleInfo = {
  isAdmin: boolean;
  isOwner: boolean;
};

export async function fetchViewerRoles(
  accessToken: string,
  mondayBoardId: string | number,
  userIds: string[]
): Promise<Map<string, ViewerRoleInfo>> {
  const result = new Map<string, ViewerRoleInfo>();
  if (!accessToken || !userIds.length) return result;

  const variables = {
    boardIds: [typeof mondayBoardId === "number" ? mondayBoardId : normaliseGraphId(String(mondayBoardId))],
    userIds: userIds.map((id) => normaliseGraphId(id))
  };

  const query = `
    query ($boardIds: [ID!], $userIds: [ID!]) {
      boards(ids: $boardIds) {
        owners { id }
      }
      users(ids: $userIds) {
        id
        is_admin
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`monday role lookup failed: ${response.status} ${text}`);
  }

  const json = await response.json();

  const ownerIds = new Set<string>(
    (json?.data?.boards?.[0]?.owners || []).map((owner: any) => String(owner?.id ?? "")).filter(Boolean)
  );

  (json?.data?.users || []).forEach((user: any) => {
    if (!user) return;
    const id = String(user.id ?? "");
    if (!id) return;
    result.set(id, {
      isAdmin: Boolean(user.is_admin),
      isOwner: ownerIds.has(id)
    });
  });

  userIds.forEach((id) => {
    if (!result.has(id)) {
      result.set(id, { isAdmin: false, isOwner: ownerIds.has(id) });
    }
  });

  return result;
}

type ViewerCheckInput = {
  boardUuid: string | number;
  mondayBoardId: string | number;
  mondayUserId?: string | number | null;
  tenantAccessToken?: string | null;
};

export async function assertViewerAllowed({
  boardUuid,
  mondayBoardId,
  mondayUserId,
  tenantAccessToken
}: ViewerCheckInput) {
  if (!mondayUserId) {
    const err: Error & { status?: number } = new Error("Missing monday user context");
    err.status = 403;
    throw err;
  }

  const normalizedBoardId = String(boardUuid);
  const normalizedUserId = String(mondayUserId);

  const { data, error } = await supabaseAdmin
    .from("board_viewers")
    .select("status")
    .eq("board_id", normalizedBoardId)
    .eq("monday_user_id", normalizedUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const createViewerRow = async (status: "allowed" | "restricted" | "editor") => {
      try {
        if (tenantAccessToken) {
          await upsertBoardViewer({
            boardId: normalizedBoardId,
            mondayUserId: normalizedUserId,
            accessToken: tenantAccessToken,
            status
          });
        } else {
          await supabaseAdmin
            .from("board_viewers")
            .upsert(
              {
                board_id: normalizedBoardId,
                monday_user_id: normalizedUserId,
                status,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              },
              { onConflict: "board_id,monday_user_id" }
            );
        }
      } catch (insertError) {
        console.error("Failed to seed viewer record:", insertError);
      }
    };

    if (tenantAccessToken && mondayBoardId != null) {
      try {
        const roles = await fetchViewerRoles(tenantAccessToken, mondayBoardId, [normalizedUserId]);
        const role = roles.get(normalizedUserId);
        if (role?.isAdmin || role?.isOwner) {
          await createViewerRow("allowed");
          return;
        }
      } catch (roleError) {
        console.error("Failed to determine viewer role:", roleError);
      }
    }

    await createViewerRow("restricted");
    const err: Error & { status?: number } = new Error("viewer restricted");
    err.status = 403;
    throw err;
  }

  if (data?.status !== "restricted") {
    return;
  }

  if (tenantAccessToken) {
    try {
      const roles = await fetchViewerRoles(tenantAccessToken, mondayBoardId, [normalizedUserId]);
      const role = roles.get(normalizedUserId);
      if (role?.isAdmin || role?.isOwner) {
        return;
      }
    } catch (roleError) {
      console.error("Failed to fetch viewer role:", roleError);
    }
  }

  const err: Error & { status?: number } = new Error("viewer restricted");
  err.status = 403;
  throw err;
}

type AccountAdminCheckOptions = {
  accessToken: string;
  mondayUserId: string | number;
};

export async function assertAccountAdmin({ accessToken, mondayUserId }: AccountAdminCheckOptions) {
  const normalizedUserId = String(mondayUserId);
  if (!normalizedUserId) {
    const err: Error & { status?: number } = new Error("Unable to determine monday user id");
    err.status = 403;
    throw err;
  }

  const query = `
    query ($ids: [ID!]) {
      users(ids: $ids) {
        id
        is_admin
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables: { ids: [normaliseGraphId(normalizedUserId)] } })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    console.error("monday admin status lookup failed:", response.status, details);
    const err: Error & { status?: number } = new Error("Failed to confirm admin privileges");
    err.status = 502;
    throw err;
  }

  const payload = await response.json().catch(() => null);
  const userRecord = Array.isArray(payload?.data?.users) ? payload.data.users.find((u: any) => String(u?.id ?? "") === normalizedUserId) : null;
  const isAdmin = Boolean(userRecord?.is_admin);

  if (!isAdmin) {
    const err: Error & { status?: number } = new Error("Admin access required");
    err.status = 403;
    throw err;
  }
}

type ViewerAccessGuardParams = ViewerCheckInput & {
  boardWasCreated?: boolean;
};

export async function assertViewerAllowedWithRollback({
  boardUuid,
  mondayBoardId,
  mondayUserId,
  tenantAccessToken,
  boardWasCreated
}: ViewerAccessGuardParams) {
  try {
    await assertViewerAllowed({ boardUuid, mondayBoardId, mondayUserId, tenantAccessToken });
  } catch (error) {
    if (boardWasCreated) {
      try {
        await supabaseAdmin.from("boards").delete().eq("id", String(boardUuid));
      } catch (cleanupError) {
        console.error("Failed to rollback unauthorized board provisioning:", cleanupError);
      }
    }
    throw error;
  }
}

type EditorAccessInput = {
  boardUuid: string | number;
  mondayBoardId?: string | number;
  mondayUserId?: string | number | null;
  tenantAccessToken?: string | null;
};

export async function ensureEditorAccess({
  boardUuid,
  mondayBoardId,
  mondayUserId,
  tenantAccessToken
}: EditorAccessInput): Promise<ViewerRole> {
  const normalizedUserId = mondayUserId != null ? String(mondayUserId) : "";
  if (!normalizedUserId) {
    const err: Error & { status?: number } = new Error("editor access required");
    err.status = 403;
    throw err;
  }

  const normalizedBoardId = String(boardUuid);
  let viewerRole: ViewerRole = "viewer";

  const { data, error } = await supabaseAdmin
    .from("board_viewers")
    .select("status")
    .eq("board_id", normalizedBoardId)
    .eq("monday_user_id", normalizedUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  viewerRole = fromStoredStatus(data?.status ?? null);
  if (viewerRole === "editor") {
    return viewerRole;
  }

  if (tenantAccessToken && mondayBoardId != null) {
    const roles = await fetchViewerRoles(tenantAccessToken, mondayBoardId, [normalizedUserId]);
    const mondayRole = roles.get(normalizedUserId);
    if (mondayRole?.isAdmin || mondayRole?.isOwner) {
      return "editor";
    }
  }

  const err: Error & { status?: number } = new Error("editor access required");
  err.status = 403;
  throw err;
}

type ViewerLimitInput = {
  boardUuid: string | number;
  mondayBoardId: string | number;
  tenantAccessToken?: string | null;
  viewerLimit: number | null;
};

export async function enforceBoardViewerLimit({
  boardUuid,
  mondayBoardId,
  tenantAccessToken,
  viewerLimit
}: ViewerLimitInput) {
  const limit = viewerLimit ?? null;
  if (limit == null) return;
  if (!tenantAccessToken) {
    console.warn("Cannot enforce viewer limit without tenant access token.");
    return;
  }

  const normalizedBoardId = String(boardUuid);
  const { data, error } = await supabaseAdmin
    .from("board_viewers")
    .select("id,monday_user_id,updated_at")
    .eq("board_id", normalizedBoardId)
    .in("status", ["allowed", "editor"]);

  if (error) {
    console.error("Failed to load board viewers when enforcing limits:", error);
    return;
  }

  const allowedRows = Array.isArray(data) ? data : [];
  if (!allowedRows.length) return;

  const userIds = allowedRows.map((row) => String(row.monday_user_id));
  const roles = await fetchViewerRoles(tenantAccessToken, mondayBoardId, userIds);

  const nonPrivileged = allowedRows.filter((row) => {
    const role = roles.get(String(row.monday_user_id));
    return !(role?.isAdmin || role?.isOwner);
  });

  if (nonPrivileged.length <= Math.max(limit, 0)) {
    return;
  }

  const toRestrictCount = nonPrivileged.length - Math.max(limit, 0);
  const sorted = nonPrivileged.sort((a, b) => {
    const aTime = a.updated_at ? Date.parse(a.updated_at) : 0;
    const bTime = b.updated_at ? Date.parse(b.updated_at) : 0;
    return bTime - aTime; // restrict most recently updated first
  });

  const restrictIds = sorted.slice(0, toRestrictCount).map((row) => row.id);
  if (!restrictIds.length) return;

  const { error: updateError } = await supabaseAdmin
    .from("board_viewers")
    .update({ status: "restricted", updated_at: new Date().toISOString() })
    .in("id", restrictIds);

  if (updateError) {
    console.error("Failed to restrict excess viewers:", updateError);
  }
}
