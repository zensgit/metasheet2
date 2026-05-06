# K3 WISE Postdeploy Operator Permission Gate Development

Date: 2026-05-06

## Context

The postdeploy smoke already verifies public health, the K3 WISE frontend route,
authenticated integration route registration, read-only list probes, and staging
descriptor contracts.

That was enough to prove the token can read the integration control plane, but
not enough to prove the operator can run the live PoC flow. The live flow needs
write-capable integration access for setup, external-system connection tests,
pipeline dry-run/run, staging install, and dead-letter replay.

## Backend Permission Contract

The integration plugin route guard accepts:

- `role:admin` or `integration:admin` for every integration action.
- `integration:read` or `integration:write` for read actions.
- `integration:write` for write actions, unless the user is admin.

The mutating K3 PoC routes therefore require at least one of:

- `role:admin`
- `integration:admin`
- `integration:write`

## Implementation

The smoke now adds an `operator-permission` check after `/api/auth/me` succeeds.
The check is intentionally read-only:

1. Call `/api/auth/me` with the supplied bearer token.
2. Extract claims from `data.user`, plus legacy-compatible top-level shapes.
3. Normalize `role`, `roles`, `permissions`, and `perms` into comparable claims.
4. Pass only when one live-operator claim is present.
5. Fail the smoke and block internal-trial signoff for read-only tokens.

No write requests are issued by this gate.

## Files Changed

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`

## Stacking Note

This branch is stacked on PR #1330 because both slices touch the same smoke
script. After #1330 merges, this branch should be rebased onto `main` before
final merge.
