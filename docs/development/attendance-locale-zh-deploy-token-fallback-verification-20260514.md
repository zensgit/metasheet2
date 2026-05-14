# Attendance Locale zh Deploy Token Fallback Verification

## Local Verification

- `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/attendance-locale-zh-smoke-prod.yml"); puts "yaml-parse-ok"'`
- `bash -n scripts/ops/attendance-resolve-auth.sh`
- `bash -n scripts/ops/attendance-write-auth-error.sh`
- `bash -n scripts/ops/resolve-attendance-smoke-token.sh`
- `node --test scripts/ops/attendance-auth-scripts.test.mjs scripts/ops/attendance-locale-zh-workflow-contract.test.mjs scripts/ops/resolve-attendance-smoke-token.test.mjs`
- `git diff --check`
- Changed-file secret scan for webhook tokens, DingTalk signing secrets, JWT-looking values, bearer tokens, and attendance password assignments.

## Live Evidence Before This Change

- Workflow: `Attendance Locale zh Smoke (Prod)`
- Run: `25843193505`
- Head SHA: `c4e026efbcc741fa8764587dad33171dbd494c87`
- Result: failed before real smoke at `Resolve valid auth token`.
- Redacted diagnosis:
  - `auth_me_last_http=401`
  - `refresh_last_http=401`
  - `login_last_http=unknown`
  - `login_email_present=false`
  - `login_password_present=false`
- Repository secret inventory shows `ATTENDANCE_ADMIN_JWT` exists, while `ATTENDANCE_ADMIN_EMAIL` and `ATTENDANCE_ADMIN_PASSWORD` are not configured.

## Post-Merge Live Verification

- PR: `#1535`
- Merge SHA: `288a64353ec601fe63f2ecc29b340def3bac5f9a`
- Build and deploy run: `25844315249`
- Build and deploy result: `success`
- Manual live smoke run: `25844468696`
- Live smoke result: `success`
- Smoke job result: `success`
- Issue job result: `success`
- `Resolve valid auth token`: `success`
- `Run zh locale smoke`: `success`
- Artifact: `attendance-locale-zh-smoke-prod-25844468696-1`

Artifact checks:

- `deploy-host-auth-fallback.log` confirms configured auth failed first, then deploy-host fallback minted a token from the backend runtime.
- `auth-resolve-meta.txt` confirms `AUTH_SOURCE=token` and `AUTH_ME_LAST_HTTP=200` after the minted token was revalidated through the existing resolver.
- `attendance-zh-locale-summary.json` confirms `status=pass`, `ok=true`, `authSource=token`, `locale=zh-CN`, `lunarLabelCount=35`, `holidayCheckEnabled=true`, and cleanup `holidayDeleted=true`.
- `attendance-zh-locale-calendar.png` was produced.

## Current Conclusion

This scheduled smoke gate is now `可交付` for the tested path. The long-lived `ATTENDANCE_ADMIN_JWT` is still stale, but the workflow no longer depends on it: when configured auth fails, it mints and validates a short-lived token from the deployed backend runtime, then runs the real zh locale smoke successfully.
