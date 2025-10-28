import { jwtVerify, type JWTPayload } from "jose";
import { createSecretKey } from "crypto";

type VerifiedContext = {
  accountId: string;
  userId?: string;
  boardId?: string;
};

const clientSecret = process.env.MONDAY_CLIENT_SECRET;
const expectedIssuer = process.env.MONDAY_JWT_ISSUER;
const expectedAudience = process.env.MONDAY_JWT_AUDIENCE;

if (!clientSecret) {
  throw new Error("MONDAY_CLIENT_SECRET environment variable is not set");
}

const clientSecretKey = createSecretKey(clientSecret, "utf-8");

function extractContext(payload: JWTPayload): VerifiedContext {
  const dat = (payload as any)?.dat ?? payload;
  const accountId = dat?.account_id ?? (payload as any)?.accountId ?? (payload as any)?.aid ?? null;
  const userId = dat?.user_id ?? (payload as any)?.userId ?? null;
  const boardId = dat?.board_id ?? (payload as any)?.boardId ?? null;

  if (!accountId) {
    throw new Error("monday JWT missing account id");
  }

  return {
    accountId: String(accountId),
    userId: userId != null ? String(userId) : undefined,
    boardId: boardId != null ? String(boardId) : undefined
  };
}

export async function verifyMondayJwt(token: string): Promise<VerifiedContext> {
  if (!token || typeof token !== "string") {
    throw new Error("Missing monday token");
  }

  const isJwt = token.split(".").length === 3;
  if (!isJwt) {
    throw new Error("Provided token is not a JWT");
  }

  const verificationOptions: Record<string, unknown> = {};
  if (expectedIssuer) {
    verificationOptions.issuer = expectedIssuer;
  }
  if (expectedAudience) {
    verificationOptions.audience = expectedAudience;
  }

  const { payload } = await jwtVerify(token, clientSecretKey, verificationOptions);

  if (payload.exp && payload.exp * 1000 < Date.now()) {
    throw new Error("monday session token has expired");
  }

  return extractContext(payload);
}
