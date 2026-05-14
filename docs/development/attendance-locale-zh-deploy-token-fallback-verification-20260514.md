# Attendance Locale zh Deploy Token Fallback Verification

## Local Verification

- `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/attendance-locale-zh-smoke-prod.yml"); puts "yaml-parse-ok"'`
- `bash -n scripts/ops/attendance-resolve-auth.sh`
- `bash -n scripts/ops/attendance-write-auth-error.sh`
- `bash -n scripts/ops/resolve-attendance-smoke-token.sh`
- `node --test scripts/ops/attendance-auth-scripts.test.mjs scripts/ops/attendance-locale-zh-workflow-contract.test.mjs scripts/ops/resolve-attendance-smoke-token.test.mjs`
- `git diff --check`
- Changed-file secret scan for `access_token=`, `SEC...`, JWT-looking values, `Bearer ...`, and `ATTENDANCE_ADMIN_PASSWORD=`.

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

## Expected Post-Merge Verification

1. Merge this patch to `main`.
2. Rerun `Attendance Locale zh Smoke (Prod)` manually on `main`.
3. Confirm the resolver first rejects the stale configured token, then records deploy-host fallback in `deploy-host-auth-fallback.log`.
4. Confirm `AUTH SOURCE` in the workflow summary is `token`, because the minted fallback token is revalidated through the existing resolver.
5. Confirm `Run zh locale smoke` executes and produces `attendance-zh-locale-summary.json` plus `attendance-zh-locale-calendar.png`.

## Current Conclusion

Before live rerun, the prior state is `不可交付` for this scheduled smoke gate because the only long-lived attendance admin JWT is invalid and no login fallback exists. This patch should make the gate independent of that stale long-lived JWT while preserving redacted failure diagnostics.
