import { verifyMondayJwt } from "./verifyMondayJwt";
import { resolveTenantBoard } from "./tenancy";

type VerifiedMondayToken = {
  accountId: string;
  boardId: string;
  userId?: string;
  tenantId: string;
  boardUuid: string;
};

export async function verifyMondayToken(token: string): Promise<VerifiedMondayToken | null> {
  const session = await verifyMondayJwt(token);
  if (!session?.accountId || !session?.boardId) return null;

  const resolved = await resolveTenantBoard({
    accountId: session.accountId,
    boardId: session.boardId,
    userId: session.userId
  });

  return {
    accountId: session.accountId,
    boardId: String(session.boardId),
    userId: session.userId,
    tenantId: String(resolved.tenant.id),
    boardUuid: String(resolved.board.id)
  };
}
