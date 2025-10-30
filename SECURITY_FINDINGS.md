# Security Findings (Context Project)

## High Severity

### 1. Exposed Production Secrets in `.env.local`
- **Location:** `.env.local` (removed)
- **Risk:** The committed file contained live Supabase service role keys, monday.com client secrets, API tokens, and encryption keys. Anybody cloning the repository could fully compromise the tenant database and monday integration.
- **Fix:** Removed the tracked file, added a scrubbed `.env.example`, and documented rotation requirements. Ensure all previously exposed secrets are rotated in Supabase and monday.

### 2. Board Enumeration Leak
- **Location:** `app/api/boards/list/route.ts:72-150`
- **Risk:** Non-admin users could list every board using Context within a tenant, even if they were not invited. This exposed board metadata across teams.
- **Fix:** API now filters the Supabase `boards` result set to only those where the caller is an invited viewer (status not `restricted`). Account admins keep full visibility.

## Medium Severity

### 3. Board Admin Delete Permissions Needed Hard Gate & Logging
- **Location:** `app/api/boards/delete/route.ts:20-111`, `app/api/settings/board-admin-delete/route.ts:14-80`, `app/board-view/page.tsx:1664-1720`
- **Risk:** Board admins on Pro/Enterprise could delete any board’s data without central control, and the previous route lacked rate limiting.
- **Fix:** Added tenant-level toggle (`board_admin_delete_enabled`), admin-only management UI, and rate limiting on both the delete and toggle endpoints. Deletion now requires the toggle plus plan tier.

### 4. Missing Security Headers (CSP, CORS, HSTS)
- **Location:** `next.config.js:6-63`
- **Risk:** The app previously sent no CSP/HSTS headers and relied on implicit CORS behaviour. This increased exposure to XSS and origin spoofing.
- **Fix:** Added strict CSP, HSTS, Referrer-Policy, Permissions-Policy, credentialed CORS allow-list, and standard hardening headers for all routes.

### 5. Secrets & Guardrails Automation
- **Location:** `package.json`, `.secretlintrc.json`, `.husky/pre-commit`, `eslint.config.mjs`
- **Risk:** No automated checks prevented reintroducing secrets or dangerous patterns.
- **Fix:** Added ESLint guardrails (blocking `eval`, `new Function`, `dangerouslySetInnerHTML`), Husky pre-commit with lint/typecheck, lint-staged, and a `secretlint` script for CI.

### 6. Supabase Encryption Key Fallback Warning
- **Location:** `lib/tokenEncryption.ts:4-64`
- **Risk:** Previous logic reused the Supabase service role key hash when no dedicated encryption key was set, encouraging unsafe practices.
- **Fix:** Key material is now resolved once and stored immutably; documentation in SECURITY_GUIDELINES.md mandates providing a dedicated 32-byte encryption key.

## Low Severity

### 7. Operational Configuration Gaps
- **Location:** `README.md`, `SECURITY_GUIDELINES.md`
- **Risk:** Lack of documented security runbooks can lead to misconfiguration (missing CSP, unrotated keys, disabled RLS).
- **Fix:** Added SECURITY_GUIDELINES.md covering key controls (secret handling, private buckets, webhook HMAC, RLS confirmation, CORS/CSP).

### 8. Legacy Utility Scripts (CommonJS)
- **Location:** `scripts/decryptMondaySecret.js`, `scripts/reEncryptMondayTokens.mjs`
- **Risk:** Lint flagged CommonJS `require` usage. Functionality is server-only and now explicitly documented/ignored so tooling can enforce other hot spots without noise.

---

All fixes validated with:
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run scan:secrets`

See `audit.json`, `static-grep.txt`, and `secretlint-report.txt` for raw tool outputs.
