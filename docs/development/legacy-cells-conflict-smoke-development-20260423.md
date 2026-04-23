# Legacy Cells Conflict Smoke Development - 2026-04-23

## Context

PR #1092 wired the legacy spreadsheet frontend to send `expectedVersion` when the client has a known backend cell version. The remaining rollout risk was staging-level validation of the underlying legacy cells API contract:

- two clients read the same cell version;
- client A writes with `expectedVersion`;
- client B writes with the stale `expectedVersion`;
- backend must return `409 VERSION_CONFLICT`;
- final persisted value must remain client A's value.

## Scope

Included:

- Added a reusable smoke script: `scripts/ops/legacy-cells-conflict-smoke.mjs`.
- Added node test coverage: `scripts/ops/legacy-cells-conflict-smoke.test.mjs`.
- Ran the smoke against the live 142 staging deployment on `http://142.171.239.56:8081/api`.
- Wrote development and verification documentation.

Not included:

- Browser automation for the GridView UI.
- Persisting or committing a reusable staging admin token.
- Changing remote users or passwords.

## Script Behavior

The smoke script performs a real write flow against a target API:

1. Resolve auth from `AUTH_TOKEN`/`TOKEN`, login credentials, or explicitly allowed dev-token fallback.
2. Require `CONFIRM_WRITE=1` before any write.
3. Create a temporary spreadsheet with one sheet.
4. Seed `A1` without `expectedVersion`.
5. Read the seeded version as session A and session B.
6. Update `A1` as session A with the current version.
7. Attempt to update `A1` as session B with the stale version.
8. Assert `409 VERSION_CONFLICT` with `serverVersion` and `expectedVersion`.
9. Assert final cell value is still session A's value.
10. Delete the temporary spreadsheet when `CLEANUP` is not false.

## Configuration

Supported environment variables:

- `BASE_URL`, `API_BASE`, or `STAGING_BASE_URL`
- `AUTH_TOKEN` or `TOKEN`
- `LOGIN_EMAIL`, `LOGIN_USERNAME`, `USERNAME`, or `YUANTUS_BOOTSTRAP_ADMIN_USERNAME`
- `LOGIN_PASSWORD`, `PASSWORD`, or `YUANTUS_BOOTSTRAP_ADMIN_PASSWORD`
- `TENANT_ID`
- `ALLOW_DEV_TOKEN=1`
- `CONFIRM_WRITE=1`
- `CLEANUP=0|1`
- `OUTPUT_DIR`, `REPORT_JSON`, `REPORT_MD`

The script also supports `--env-file <path>`.

## Staging Auth Note

The local shared-dev credentials were not valid for the current `8081` deployment:

- `p2-shared-dev.env` login returned `401`.
- `shared-dev.bootstrap.env` login returned `401`.
- `/api/auth/dev-token` returned `404` on the staging deployment.

For the final live smoke, a short-lived admin JWT was generated inside the remote backend container using the running `JWT_SECRET` and an existing active admin user. The token was not printed, committed, or persisted.

## Changed Files

- `scripts/ops/legacy-cells-conflict-smoke.mjs`
- `scripts/ops/legacy-cells-conflict-smoke.test.mjs`
- `docs/development/legacy-cells-conflict-smoke-development-20260423.md`
- `docs/development/legacy-cells-conflict-smoke-verification-20260423.md`
- `output/delivery/legacy-cells-conflict-smoke-20260423/TEST_AND_VERIFICATION.md`
