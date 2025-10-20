import { supabaseAdmin } from "@/lib/supabase";

const MONDAY_API_URL = "https://api.monday.com/v2";

type UpsertOptions = {
  boardId: string;
  mondayUserId: string;
  accessToken?: string | null;
  status?: "allowed" | "restricted";
};

async function fetchMondayUser(accessToken: string, mondayUserId: string) {
  const normalisedId = (() => {
    const numeric = Number(mondayUserId);
    return Number.isNaN(numeric) ? mondayUserId : numeric;
  })();

  const query = `
    query ($ids: [ID!]) {
      users(ids: $ids) {
        id
        name
        email
      }
    }
  `;

  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables: { ids: [normalisedId] } })
  });

  if (!res.ok) {
    const details = await res.text().catch(() => null);
    throw new Error(`monday users lookup failed: ${res.status}${details ? ` ${details}` : ""}`);
  }

  const json = await res.json();
  const user = Array.isArray(json?.data?.users) ? json.data.users.find((u: any) => String(u?.id ?? "") === String(mondayUserId)) : null;

  if (!user) return null;

  return {
    name: typeof user.name === "string" && user.name.trim() ? user.name : undefined,
    email: typeof user.email === "string" && user.email.trim() ? user.email : undefined
  };
}

export async function upsertBoardViewer({ boardId, mondayUserId, accessToken, status }: UpsertOptions) {
  if (!boardId || !mondayUserId) return;

  const viewerRow: Record<string, any> = {
    board_id: boardId,
    monday_user_id: mondayUserId,
    status: status ?? "allowed",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (accessToken) {
    try {
      const details = await fetchMondayUser(accessToken, mondayUserId);
      if (details?.name) viewerRow.user_name = details.name;
      if (details?.email) viewerRow.user_email = details.email;
    } catch (error) {
      console.error("Failed to enrich monday viewer", error);
    }
  }

  await supabaseAdmin
    .from("board_viewers")
    .upsert(viewerRow, { onConflict: "board_id,monday_user_id" });
}
