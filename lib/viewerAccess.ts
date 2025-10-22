import { supabaseAdmin } from "@/lib/supabase";
import { upsertBoardViewer } from "@/lib/upsertBoardViewer";

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
  if (!mondayUserId) return;

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
    const createViewerRow = async (status: "allowed" | "restricted") => {
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
