import { jwtVerify, createRemoteJWKSet } from "jose";

// Monday provides a JWKS endpoint for verifying tokens
const mondayJWKS = createRemoteJWKSet(new URL("https://auth.monday.com/.well-known/jwks.json"));

export async function verifyMondayToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, mondayJWKS, {
      issuer: "monday.com",
      audience: "context"
    });
    return payload;
  } catch {
    throw new Error("Invalid monday session token");
  }
}
