"use client";

const OAUTH_START_URL = "/api/monday/oauth/start";

export default function ConnectMonday() {
  return (
    <main className="h-screen flex flex-col items-center justify-center text-center px-4">
      <h1 className="text-2xl font-semibold text-[#0073EA] mb-6">Connect Context to monday.com</h1>
      <a
        href={OAUTH_START_URL}
        className="rounded-md bg-[#0073EA] text-white px-6 py-3 text-sm font-medium hover:bg-[#005EB8] transition"
      >
        Connect monday.com
      </a>
      <p className="mt-4 text-gray-500 text-sm">
        After authorizing on monday.com you&apos;ll be redirected back automatically.
      </p>
    </main>
  );
}
