# Attendance Locale zh Deploy Token Fallback Development

## Summary

`Attendance Locale zh Smoke (Prod)` already rejects an expired `ATTENDANCE_ADMIN_JWT` before running the real smoke. The live run proved that the only configured token is stale and no email/password fallback exists. This change keeps that validation, then adds a deploy-host temporary token fallback using the same safety model as the K3 WISE postdeploy smoke.

## Change

- Added `scripts/ops/resolve-attendance-smoke-token.sh`.
- The resolver uses `DEPLOY_HOST`, `DEPLOY_USER`, and `DEPLOY_SSH_KEY_B64` to SSH into the deploy host from GitHub Actions.
- It executes inside the running backend container and signs a short-lived admin token with the backend runtime `authService.createToken()`.
- The token is printed only to stdout for command substitution, masked by the workflow, and never persisted as a repository secret.
- Updated `.github/workflows/attendance-locale-zh-smoke-prod.yml` so the auth flow is:
  1. validate configured `ATTENDANCE_ADMIN_JWT`;
  2. try refresh/login fallback when configured;
  3. if still invalid, mint a deploy-host temporary token;
  4. validate the minted token through `/api/auth/me`;
  5. only then run `pnpm verify:attendance-locale-zh`.

## Safety Notes

- No database schema changes.
- No business runtime API changes.
- No secret values are written to docs, logs, or Git.
- The temporary SSH key is created under `${TMPDIR:-/tmp}` with mode `0600` and removed on exit.
- The fallback is read-only against application data; it selects one active admin user and signs a temporary smoke token.

## Follow-Up

If the deploy-host fallback passes live, the stale `ATTENDANCE_ADMIN_JWT` can remain as a non-blocking cleanup item or be rotated separately. The workflow no longer depends on a long-lived repo token for this smoke path.
