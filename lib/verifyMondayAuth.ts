import { jwtVerify, createRemoteJWKSet } from "jose";

const mondayJWKS = createRemoteJWKSet(new URL("https://auth.monday.com/.well-known/jwks.json"));

export async function verifyMondayAuth(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing Authorization header");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new Error("Missing Authorization token");
  }

  const { payload } = await jwtVerify(token, mondayJWKS);
  if (!payload.accountId || !payload.userId) {
    throw new Error("Invalid monday payload");
  }

  return {
    accountId: String(payload.accountId),
    userId: String(payload.userId)
  };
}
