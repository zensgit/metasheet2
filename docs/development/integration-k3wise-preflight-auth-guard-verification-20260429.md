# K3 WISE Preflight Auth Guard Verification - 2026-04-29

## Scope

Verified that the live PoC preflight rejects K3 WISE packets without a usable auth key shape before generating `preflight-ready` output.

Changed files:

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`
- `docs/development/integration-k3wise-preflight-auth-guard-design-20260429.md`
- `docs/development/integration-k3wise-preflight-auth-guard-verification-20260429.md`

## Checks

### Focused Preflight Test

Command:

```bash
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
```

Expected result:

```text
scripts/ops/integration-k3wise-live-poc-preflight.test.mjs: 14 tests passed
```

Coverage added:

- Missing `k3Wise.credentials` auth keys are rejected with `field: "k3Wise.credentials"`.
- Partial username-only credentials are rejected.
- `credentials.sessionId` is accepted and rendered as a `<set-at-runtime>` placeholder.

## Live Validation

This guard is pre-live validation only. It does not contact customer K3 WISE; live connection testing still happens after the customer GATE response is available.
