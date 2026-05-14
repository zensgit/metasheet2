# Attendance Locale zh Smoke Auth Resolver Development - 2026-05-14

## Summary

Implemented the production attendance zh-locale smoke workflow auth closeout slice.

The workflow had drifted away from the shared attendance production gate auth resolver. It passed the configured admin JWT directly into `pnpm verify:attendance-locale-zh`; when that JWT was stale and login fallback values were absent, the smoke failed inside the Node smoke script with a less actionable failure.

This slice reuses the shared `scripts/ops/attendance-resolve-auth.sh` and `scripts/ops/attendance-write-auth-error.sh` path already used by the strict and perf production gates.

## Changed Behavior

- `Attendance Locale zh Smoke (Prod)` now resolves a valid auth token before running the real zh-locale smoke.
- The workflow now reads attendance admin auth inputs from GitHub Secrets first, then GitHub Variables, then an empty fallback.
- The resolver validates the configured token with `/api/auth/me`, tries refresh, then tries login when email/password are configured.
- On resolver failure, the workflow writes a redacted `auth-error.txt` artifact and fails before launching Playwright.
- The real smoke step receives only the resolved masked token through `AUTH_TOKEN_EFFECTIVE`.
- Drill mode remains unchanged and still exits before setup, install, resolver, and real smoke steps.
- Step summary now points operators to the expected screenshot on success and to `auth-error.txt` on resolver failure.

## Files Changed

- `.github/workflows/attendance-locale-zh-smoke-prod.yml`
- `scripts/ops/attendance-locale-zh-workflow-contract.test.mjs`
- `docs/development/attendance-locale-zh-smoke-auth-resolver-development-20260514.md`
- `docs/development/attendance-locale-zh-smoke-auth-resolver-verification-20260514.md`

## Design Notes

This change intentionally does not duplicate auth fallback logic in the workflow. The shell resolver remains the single production-gate auth path for attendance workflows.

The workflow-level resolver is useful even though `scripts/verify-attendance-locale-zh-smoke.mjs` still has its own fallback logic: the workflow can now fail earlier with a standard diagnostic artifact, and all attendance production gates use the same token validation contract.

No runtime API, frontend, database, DingTalk, or attendance product behavior is changed by this slice.

Added a small `node:test` workflow contract so the locale smoke workflow keeps the shared resolver, fallback variables, resolved-token handoff, redacted auth-error artifact, and drill ordering intact.

## Security Notes

- No admin JWT, login password, DingTalk webhook, DingTalk signing secret, or bearer token is written to Git.
- The resolved token is masked through `::add-mask::` before being exported to the job environment.
- The failure artifact records only HTTP status diagnostics and whether login fields were present.
- GitHub Secrets remain the preferred source. GitHub Variables are supported only as the existing production-gate compatibility fallback.

## Operational Follow-Up

After this PR reaches `main`, rerun `Attendance Locale zh Smoke (Prod)`.

If GitHub Secrets or Variables contain either a valid attendance admin JWT or valid attendance admin login credentials, the workflow should pass or reach a product-level smoke assertion.

If neither credential source is valid, the workflow should fail with a redacted `auth-error.txt` artifact. That is an ops credential blocker, not a workflow implementation failure.
