import { supabaseAdmin } from "@/lib/supabase";

type ViewerCheckInput = {
  boardId: string | number;
  mondayUserId?: string | number | null;
};

export async function assertViewerAllowed({ boardId, mondayUserId }: ViewerCheckInput) {
  if (!mondayUserId) return;

  const normalizedBoardId = String(boardId);
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

  if (data?.status === "restricted") {
    const err: Error & { status?: number } = new Error("viewer restricted");
    err.status = 403;
    throw err;
  }
}
