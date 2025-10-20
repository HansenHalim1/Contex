import { supabaseAdmin } from "@/lib/supabase";

const MONDAY_API_URL = "https://api.monday.com/v2";

type UpsertOptions = {
  boardId: string;
  mondayUserId: string;
  mondayToken?: string | null;
};

async function fetchMondayUser(mondayToken: string, mondayUserId: string) {
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
      Authorization: `Bearer ${mondayToken}`,
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

export async function upsertBoardViewer({ boardId, mondayUserId, mondayToken }: UpsertOptions) {
  if (!boardId || !mondayUserId) return;

  const viewerRow: Record<string, any> = {
    board_id: boardId,
    monday_user_id: mondayUserId,
    created_at: new Date().toISOString()
  };

  if (mondayToken) {
    try {
      const details = await fetchMondayUser(mondayToken, mondayUserId);
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

