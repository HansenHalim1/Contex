import { verifyMondayJwt } from "@/lib/verifyMondayJwt";

export async function verifyMondayAuth(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing Authorization header");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new Error("Missing Authorization token");
  }

  return verifyMondayJwt(token);
}
