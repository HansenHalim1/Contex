import { supabaseAdmin, BUCKET } from "@/lib/supabase";
import { incrementStorage } from "@/lib/tenancy";

type DeleteBoardOptions = {
  boardId: string;
  tenantId: string;
};

export async function deleteBoardWithData({ boardId, tenantId }: DeleteBoardOptions) {
  const normalizedBoardId = String(boardId);
  const normalizedTenantId = String(tenantId);

  let totalBytes = 0;
  let storagePaths: string[] = [];

  try {
    const { data: files, error: filesError } = await supabaseAdmin
      .from("files")
      .select("id, storage_path, size_bytes")
      .eq("board_id", normalizedBoardId);

    if (filesError) throw filesError;

    if (Array.isArray(files)) {
      storagePaths = files
        .map((file) => (file?.storage_path ? String(file.storage_path) : null))
        .filter((path): path is string => Boolean(path));

      totalBytes = files.reduce((sum, file) => {
        const value = Number(file?.size_bytes);
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);
    }
  } catch (error) {
    console.error("Failed to load board files:", error);
    throw error;
  }

  if (storagePaths.length) {
    const { error: storageError } = await supabaseAdmin.storage.from(BUCKET).remove(storagePaths);
    if (storageError) {
      console.error("Failed to remove board files from storage:", storageError);
    }
  }

  await Promise.allSettled([
    supabaseAdmin.from("files").delete().eq("board_id", normalizedBoardId),
    supabaseAdmin.from("board_viewers").delete().eq("board_id", normalizedBoardId),
    supabaseAdmin.from("notes").delete().eq("board_id", normalizedBoardId),
    supabaseAdmin.from("note_snapshots").delete().eq("board_id", normalizedBoardId)
  ]);

  const { error: boardDeleteError } = await supabaseAdmin.from("boards").delete().eq("id", normalizedBoardId);
  if (boardDeleteError) {
    throw boardDeleteError;
  }

  if (totalBytes > 0) {
    try {
      await incrementStorage(normalizedTenantId, -totalBytes);
    } catch (error) {
      console.error("Failed to decrement tenant storage after board deletion:", error);
    }
  }
}
