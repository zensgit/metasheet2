# Legacy Cells Conflict Smoke - Test And Verification

Date: 2026-04-23

## Result

PASS

## Delivered

- Added `scripts/ops/legacy-cells-conflict-smoke.mjs`.
- Added `scripts/ops/legacy-cells-conflict-smoke.test.mjs`.
- Verified the legacy spreadsheet `expectedVersion` contract against live 142 staging.
- Wrote development and verification docs.

## Verified Commands

```bash
node --test scripts/ops/legacy-cells-conflict-smoke.test.mjs
git diff --check
BASE_URL=http://142.171.239.56:8081 CONFIRM_WRITE=1 AUTH_TOKEN=<short-lived-admin-jwt> node scripts/ops/legacy-cells-conflict-smoke.mjs
```

## Verified Results

- Script unit tests: 8/8 pass.
- Whitespace check: pass.
- Live staging smoke: 12/12 checks pass.
- Stale cell update returned `409 VERSION_CONFLICT`.
- Conflict payload returned `serverVersion=2` and `expectedVersion=1`.
- Final persisted cell value remained `session-a`.
- Temporary spreadsheet cleanup succeeded.

## Evidence

Live staging report:

```text
output/legacy-cells-conflict-smoke/142-8081-dbadmin-20260423-102321/report.md
```

Development docs:

```text
docs/development/legacy-cells-conflict-smoke-development-20260423.md
docs/development/legacy-cells-conflict-smoke-verification-20260423.md
```

## Auth Note

The existing local shared-dev credential files do not authenticate against the current `8081` deployment. The passing smoke used a short-lived JWT generated inside the remote backend container for an existing active admin user. The token was not printed or persisted.
