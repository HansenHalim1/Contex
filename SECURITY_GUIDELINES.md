# Security Guidelines for Context

## Secrets & Environment Variables
- Never commit real credentials. Use `.env.example` as a template and keep `.env.local` untracked.
- Rotate any secrets previously stored in git (Supabase service role key, monday tokens, cron secret, encryption keys).
- Provide a dedicated `MONDAY_TOKEN_ENCRYPTION_KEY`; do **not** rely on the service role key hash fallback.
- Run `npm run scan:secrets` (secretlint) locally and in CI to catch leaks.

## Supabase
- Use the service-role key only from backend code (`lib/supabase.ts`). Never expose it in client bundles or `NEXT_PUBLIC_*`.
- Confirm Row-Level Security is enabled on all tables (`boards`, `board_viewers`, `files`, `notes`, `note_snapshots`, `tenants`) and policies match Context’s access patterns.
- Keep the storage bucket (`board-files`) private; serve assets via signed URLs only.

## monday.com OAuth & API
- State parameter is HMAC-signed; keep `MONDAY_OAUTH_STATE_SECRET` random and private.
- Reject missing or invalid state during callback (`app/api/monday/oauth/callback/route.ts`).
- Verify webhook signatures (`app/api/monday/webhook/route.ts`) with `MONDAY_SIGNING_SECRET`.
- Rotate OAuth client secret after removing the committed `.env.local`.

## API Security
- All sensitive API routes must call `verifyMondayAuth` and enforce role checks through `fetchViewerRoles`.
- Keep `enforceRateLimit` on every mutating endpoint; add new buckets as routes are introduced.
- Validate inputs (trim strings, constrain lengths) before hitting Supabase or external services.

## CORS & Headers
- Security headers are centralised in `next.config.js`. If the public origin changes, update `APP_ORIGIN` there.
- Do not widen CORS; only production origin (and local dev via env override) should be allowed.
- CSP forbids inline scripts. If a feature needs inline behaviour, add nonces/hashes instead of loosening `script-src`.

## Frontend
- Avoid `dangerouslySetInnerHTML`; lint will block it (`react/no-danger`).
- No `eval` or `new Function`.
- Run `npm run lint` and `npm run typecheck` before pushing; Husky enforces this on commits.

## CI / Automation
- Add secretlint (`npm run scan:secrets`) and `npm run lint && npm run typecheck && npm run build` to CI pipelines.
- Review SECURITY_FINDINGS.md each release and update as vulnerabilities are resolved or new ones found.
