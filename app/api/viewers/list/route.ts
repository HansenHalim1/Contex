import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyMondayToken } from "@/lib/verifyMondayToken";

const MONDAY_API_URL = "https://api.monday.com/v2";

function normaliseBoardId(id: string) {
  const numeric = Number(id);
  return Number.isNaN(numeric) ? id : numeric;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing auth" }, { status: 401 });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const { searchParams } = new URL(req.url);
  const boardIdParam = searchParams.get("boardId") || undefined;

  let verified;
  try {
    verified = await verifyMondayToken(token, boardIdParam || undefined);
  } catch (error) {
    console.error("verifyMondayToken failed:", error);
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  if (!verified || !verified.accountId || !verified.boardId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("access_token")
    .eq("id", verified.tenantId)
    .single();

  const accessToken = tenant?.access_token;
  if (tenantError || !accessToken) {
    console.error("Failed to load tenant access token:", tenantError);
    return NextResponse.json({ error: "Missing monday access token" }, { status: 500 });
  }

  const boardIdArg = normaliseBoardId(verified.boardId);

  const subscribersQuery = `
    query ($boardIds: [ID!]) {
      boards(ids: $boardIds) {
        subscribers {
          id
          name
          email
        }
      }
    }
  `;

  const mondayRes = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query: subscribersQuery, variables: { boardIds: [boardIdArg] } })
  });

  if (!mondayRes.ok) {
    const details = await mondayRes.text();
    console.error("monday subscribers fetch failed:", mondayRes.status, details);
    return NextResponse.json({ error: "Failed to fetch monday subscribers" }, { status: 502 });
  }

  const mondayJson = await mondayRes.json();
  const board = mondayJson?.data?.boards?.[0];
  const subscribers = Array.isArray(board?.subscribers) ? board.subscribers : [];

  const subscriberMap = new Map<string, { id: string; name: string; email?: string | null; source: "monday" | "custom" }>();
  subscribers.forEach((user: any) => {
    if (!user) return;
    const id = String(user.id ?? "");
    if (!id) return;
    subscriberMap.set(id, {
      id,
      name: user.name || id,
      email: user.email || null,
      source: "monday"
    });
  });

  let extraRows: any[] = [];
  try {
    const { data, error } = await supabaseAdmin
      .from("board_viewers")
      .select("monday_user_id,user_name,user_email,status")
      .eq("board_id", verified.boardUuid);
    if (error) {
      console.error("Supabase viewer error:", error);
    } else if (Array.isArray(data)) {
      extraRows = data;
    }
  } catch (error) {
    console.error("Supabase viewer fetch threw:", error);
  }

  const overridesMap = new Map<
    string,
    { name?: string; email?: string; status: "allowed" | "restricted" }
  >();

  extraRows.forEach((row: any) => {
    const id = row?.monday_user_id || row?.id;
    if (!id) return;
    overridesMap.set(String(id), {
      name: row?.user_name ?? undefined,
      email: row?.user_email ?? undefined,
      status: row?.status === "restricted" ? "restricted" : "allowed"
    });
  });

  const missingDetailsIds = Array.from(overridesMap.entries())
    .filter(([id, override]) => (!override.name || !override.email) && !subscriberMap.has(id))
    .map(([id]) => id);

  const manualDetailsMap = new Map<string, { name?: string; email?: string }>();

  if (missingDetailsIds.length > 0) {
    const usersQuery = `
      query ($ids: [ID!]) {
        users(ids: $ids) {
          id
          name
          email
        }
      }
    `;

    try {
      const usersRes = await fetch(MONDAY_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: usersQuery, variables: { ids: missingDetailsIds.map(normaliseBoardId) } })
      });

      if (usersRes.ok) {
        const usersJson = await usersRes.json();
        const users = Array.isArray(usersJson?.data?.users) ? usersJson.data.users : [];
        users.forEach((user: any) => {
          if (!user) return;
          const id = String(user.id ?? "");
          if (!id) return;
          manualDetailsMap.set(id, { name: user.name || undefined, email: user.email || undefined });
        });
      } else {
        const details = await usersRes.text();
        console.error("monday users fetch failed:", usersRes.status, details);
      }
    } catch (error) {
      console.error("Failed to fetch manual viewer details:", error);
    }
  }

  manualDetailsMap.forEach((details, id) => {
    const override = overridesMap.get(id);
    if (!override) return;
    overridesMap.set(id, {
      ...override,
      name: override.name ?? details.name,
      email: override.email ?? details.email
    });
  });

  const resultMap = new Map<
    string,
    { id: string; name: string; email?: string | null; source: "monday" | "custom"; status: "allowed" | "restricted" }
  >();

  subscriberMap.forEach((viewer, id) => {
    const override = overridesMap.get(id);
    resultMap.set(id, {
      id,
      name: override?.name ?? viewer.name ?? id,
      email: override?.email ?? viewer.email ?? null,
      source: "monday",
      status: override?.status ?? "allowed"
    });
    if (override) overridesMap.delete(id);
  });

  overridesMap.forEach((override, id) => {
    resultMap.set(id, {
      id,
      name: override.name || id,
      email: override.email || null,
      source: "custom",
      status: override.status ?? "allowed"
    });
  });

  const viewers = Array.from(resultMap.values()).sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "allowed" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json({ viewers });
}
