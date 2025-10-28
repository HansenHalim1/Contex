import { verifyMondayJwt } from "./verifyMondayJwt";
import { resolveTenantBoard } from "./tenancy";

export type VerifiedMondayToken = {
  accountId: string;
  boardId: string;
  userId: string;
  tenantId: string;
  boardUuid: string;
};

export async function verifyMondayToken(token: string, fallbackBoardId?: string): Promise<VerifiedMondayToken | null> {
  const session = await verifyMondayJwt(token);
  if (!session?.accountId || !session?.userId) {
    return null;
  }

  const boardId = session.boardId ?? fallbackBoardId;
  if (!boardId) {
    return null;
  }

  const resolved = await resolveTenantBoard({
    accountId: session.accountId,
    boardId: String(boardId),
    userId: session.userId
  });

  return {
    accountId: session.accountId,
    boardId: String(boardId),
    userId: session.userId,
    tenantId: String(resolved.tenant.id),
    boardUuid: String(resolved.board.id)
  };
}
