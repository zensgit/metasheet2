# Yjs Staging Enable Workflow Development

Date: 2026-04-21

## Goal

Close the remaining staging rollout gap after the Yjs frontend build flag fix:

- Frontend build flag can already be passed by `VITE_ENABLE_YJS_COLLAB`.
- Backend runtime flag still was not reconciled into remote `docker/app.env`.
- Yjs staging validation required a hand-managed `YJS_ADMIN_TOKEN` secret, which blocked validation when the token was missing or expired.

## Changes

### Docker deploy runtime flag

Updated `.github/workflows/docker-build.yml` so the deploy job reads:

```yaml
ENABLE_YJS_COLLAB: ${{ vars.ENABLE_YJS_COLLAB || 'false' }}
```

The remote env-file reconciliation now persists:

```bash
ENABLE_YJS_COLLAB=true|false
```

into `docker/app.env` and logs the effective value without exposing secrets.

The default remains safe: if the repository variable is not configured, deploy writes `ENABLE_YJS_COLLAB=false`.

### Staging validation token resolution

Updated `.github/workflows/yjs-staging-validation.yml` with a token resolution step:

1. Use `secrets.YJS_ADMIN_TOKEN` if present.
2. Otherwise, use existing deploy SSH secrets to connect to the configured deploy host.
3. Execute `node` inside the running backend container.
4. Generate a short-lived HS256 admin JWT from the backend runtime `process.env.JWT_SECRET`.
5. Mask the token and write it to `GITHUB_ENV` for the validation steps.

This avoids copying the remote `JWT_SECRET` into GitHub repository secrets, avoids requiring a long-lived admin token, and avoids host env-file versus container runtime secret drift.

## Security Notes

- The workflow never prints `JWT_SECRET`.
- The generated token is masked with `::add-mask::`.
- The generated token TTL is 2 hours.
- The token payload is limited to admin validation usage:

```json
{"id":"admin","roles":["admin"],"perms":["*:*"]}
```

## Operational Flow After Merge

For a real Yjs staging run:

```bash
gh variable set VITE_ENABLE_YJS_COLLAB --repo zensgit/metasheet2 --body true
gh variable set ENABLE_YJS_COLLAB --repo zensgit/metasheet2 --body true
gh workflow run docker-build.yml --repo zensgit/metasheet2
gh workflow run yjs-staging-validation.yml --repo zensgit/metasheet2 \
  -f base_url=http://142.171.239.56:8081 \
  -f record_id=rec_0c62c76a-7eab-461d-a6d8-efd822c71b66 \
  -f field_id=fld_pilot_title \
  -f run_twice=true
```

## Non-Goals

- Does not store generated tokens as repository secrets.
- Does not change backend Yjs semantics.
- Does not enable Yjs by default for all deploys.
- Does not bypass admin auth on `/api/admin/yjs/status`.
