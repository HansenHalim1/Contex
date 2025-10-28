import { NextResponse } from "next/server";
import { randomBytes } from "crypto";

const STATE_COOKIE = "monday_oauth_state";

export async function GET() {
  const redirectUri = `${process.env.NEXT_PUBLIC_BASE_URL}/api/monday/oauth/callback`;
  const scopes = encodeURIComponent("boards:read users:read account:read me:read");
  const state = randomBytes(16).toString("hex");
  const authUrl = `https://auth.monday.com/oauth2/authorize?client_id=${process.env.MONDAY_CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&state=${encodeURIComponent(state)}`;

  const response = NextResponse.redirect(authUrl);
  response.cookies.set({
    name: STATE_COOKIE,
    value: state,
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "none",
    path: "/",
    maxAge: 300
  });

  return response;
}
