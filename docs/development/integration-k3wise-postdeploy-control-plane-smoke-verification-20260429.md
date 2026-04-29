# K3 WISE Postdeploy Control Plane Smoke Verification

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
git diff --check
```

## Expected Result

- Existing public-only smoke cases still pass.
- Authenticated smoke now calls the four read-only control plane list endpoints.
- A failing control-plane list endpoint makes the smoke exit non-zero and records
  a specific failed check in the evidence JSON.
- Smoke evidence does not leak the bearer token in stdout, stderr, or JSON.

## Customer Impact

This does not depend on the K3 WISE customer GATE packet and does not contact
customer PLM, K3 WISE, SQL Server, or middleware.

It only strengthens what our own deployed MetaSheet instance proves after a token
is available.
