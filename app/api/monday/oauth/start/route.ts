import { NextResponse } from "next/server";

export async function GET() {
  const redirectUri = `${process.env.NEXT_PUBLIC_BASE_URL}/api/monday/oauth/callback`;
  const scopes = encodeURIComponent("boards:read users:read account:read me:read");
  const authUrl = `https://auth.monday.com/oauth2/authorize?client_id=${process.env.MONDAY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}`;
  return NextResponse.redirect(authUrl);
}
