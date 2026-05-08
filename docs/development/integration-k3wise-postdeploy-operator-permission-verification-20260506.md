# K3 WISE Postdeploy Operator Permission Gate Verification

Date: 2026-05-06

## Local Verification

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
```

Result:

- `16/16` tests passed.

Covered cases:

- Admin role passes the operator gate.
- `integration:write` passes the operator gate.
- `integration:admin` passes the operator gate.
- `integration:read` alone fails the operator gate.
- Read-only token still allows read-route contract checks, but blocks
  `signoff.internalTrial`.
- Token strings remain redacted from stdout, stderr, and evidence JSON.

## Extended Verification

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
```

Result:

- `25/25` tests passed.

Command:

```bash
git diff --check -- scripts/ops/integration-k3wise-postdeploy-smoke.mjs scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs docs/development/integration-k3wise-postdeploy-operator-permission-development-20260506.md docs/development/integration-k3wise-postdeploy-operator-permission-verification-20260506.md
```

Result:

- Passed with no whitespace errors.

## Remote Verification

- GitHub CI should run after the stacked branch is pushed.
- PR remains blocked on review until the normal review or admin-merge decision.
