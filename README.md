# Context – monday.com OAuth Notes

This repository contains a Next.js 14 application that integrates with monday.com.  
The monday OAuth flow now runs entirely through our own API routes:

- `GET /api/monday/oauth/start` – Generates a signed state token and redirects to monday’s authorize endpoint.
- `GET /api/monday/oauth/callback` – Verifies the state token, exchanges the code for tokens, and stores them.

The signed-state approach works inside monday iframes because it does **not** rely on third‑party cookies.

## Required environment variables

Configure these on Vercel (and locally via `.env.local`):

| Variable | Description |
| --- | --- |
| `MONDAY_CLIENT_ID` | OAuth client ID from the monday developer console. |
| `MONDAY_CLIENT_SECRET` | OAuth client secret. |
| `MONDAY_REDIRECT_URI` | Must match the callback registered in monday, e.g. `https://contex-akxn.vercel.app/api/monday/oauth/callback`. |
| `MONDAY_OAUTH_STATE_SECRET` | Long random string used to sign the state (64+ chars recommended). |
| `MONDAY_POST_AUTH_REDIRECT` *(optional)* | URL or path the user should land on after success. Defaults to `/success`. |
| `NEXT_PUBLIC_BASE_URL` *(optional)* | Only used when `MONDAY_POST_AUTH_REDIRECT` is relative and you are testing locally. |

Without `MONDAY_OAUTH_STATE_SECRET` or `MONDAY_CLIENT_SECRET` the routes throw on boot to avoid insecure defaults.

## How the flow works

1. The UI now links to `/api/monday/oauth/start`.  
   The route generates `nonce.timestamp.signature`, signs it with HMAC‑SHA256, and adds it as the `state` query param.  
2. monday sends the user back to `/api/monday/oauth/callback?code=…&state=nonce.ts.sig`.  
3. The callback verifies the signature, checks that the timestamp is < 10 minutes old, and only then exchanges the code for tokens.  
4. Tokens are stored through Supabase as before. The callback finally redirects to `/success` (or whatever you set in `MONDAY_POST_AUTH_REDIRECT`) and includes any `region` query parameter.

## Testing the flow

1. Visit `/connect` (or wherever your “Authorize” button lives).  
2. Click **Connect monday.com** – the browser should request `/api/monday/oauth/start` and immediately redirect to `https://auth.monday.com/oauth2/authorize?…&state=<nonce.ts.sig>`.  
3. Approve the app in monday.  
4. The callback should succeed (HTTP 302). Check the Vercel logs for lines containing `Token exchange HTTP error` or `OAuth callback failed` if something goes wrong.  
5. After returning you should land on `/success?region=…` (or your configured redirect).

## Troubleshooting

- **Callback still 400s with `state=`** – ensure you are hitting `/api/monday/oauth/start` and that `MONDAY_OAUTH_STATE_SECRET` is set exactly the same in both start and callback environments.  
- **Token exchange fails** – Vercel logs will include the monday response payload (with secrets redacted). Confirm the monday app’s redirect URI matches `MONDAY_REDIRECT_URI` exactly, including scheme and path.  
- **Need different scopes** – update the scope string in `app/api/monday/oauth/start/route.ts` and add those scopes in the monday developer console.  
- **Redirect path change** – set `MONDAY_POST_AUTH_REDIRECT` to an absolute URL or path (e.g. `/dashboard`). When a path is supplied we automatically resolve it against the current request origin.

## Local development

```bash
npm install
npm run dev
```

Create a `.env.local` with the same variables listed above, pointing `MONDAY_REDIRECT_URI` to `http://localhost:3000/api/monday/oauth/callback`. Update your monday app’s redirect list to include that local URL while testing.

Happy building!

## Pro+ features: Recovery Vault & Version History

Pro and Enterprise plans now include two safeguards:

- **Recovery Vault** keeps deleted files for 7 days before purging them. Editors can restore any entry from the **Files → Recovery Vault** view.
- **Version History** surfaces daily note snapshots (captured via `/api/cron/snapshot-notes`). Editors can restore any snapshot from the **Notes → Version History** dialog.

### Required database objects

Create the `file_recovery` table (and supporting indexes) in Supabase:

```sql
create table public.file_recovery (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  board_id uuid not null references public.boards(id) on delete cascade,
  original_file_id uuid,
  name text not null,
  size_bytes bigint not null,
  content_type text,
  storage_path text not null,
  original_storage_path text,
  deleted_by text,
  deleted_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  restored_at timestamptz,
  restored_by text
);

create index file_recovery_board_id_deleted_at_idx
  on public.file_recovery (board_id, deleted_at desc)
  where restored_at is null;

create index file_recovery_expires_at_idx
  on public.file_recovery (expires_at)
  where restored_at is null;
```

### Scheduled jobs

- Continue running `GET /api/cron/snapshot-notes` daily (Pro & Enterprise tenants only).  
- Add a daily job for `GET /api/cron/recovery-vault` to purge vault entries (requires the same `CRON_SECRET` header).

Both cron routes expect `Authorization: Bearer <CRON_SECRET>`.
