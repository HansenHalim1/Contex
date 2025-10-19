"use client";

const clientId = process.env.NEXT_PUBLIC_MONDAY_CLIENT_ID;
const redirectUri = process.env.NEXT_PUBLIC_MONDAY_REDIRECT_URI;

const oauthUrl =
  clientId && redirectUri
    ? `https://auth.monday.com/oauth2/authorize?client_id=${encodeURIComponent(
        clientId
      )}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`
    : null;

export default function ConnectMonday() {
  return (
    <main className="h-screen flex flex-col items-center justify-center text-center px-4">
      <h1 className="text-2xl font-semibold text-[#0073EA] mb-6">Connect Context to monday.com</h1>
      {oauthUrl ? (
        <a
          href={oauthUrl}
          className="rounded-md bg-[#0073EA] text-white px-6 py-3 text-sm font-medium hover:bg-[#005EB8] transition"
        >
          Connect monday.com
        </a>
      ) : (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-600 border border-red-100">
          Missing monday OAuth environment variables. Please configure
          <code className="mx-1 font-mono">NEXT_PUBLIC_MONDAY_CLIENT_ID</code>
          and
          <code className="mx-1 font-mono">NEXT_PUBLIC_MONDAY_REDIRECT_URI</code>.
        </div>
      )}
      <p className="mt-4 text-gray-500 text-sm">You’ll be redirected back once authorized.</p>
    </main>
  );
}
