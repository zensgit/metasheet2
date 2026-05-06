# K3 WISE Live PoC Evidence Secret Container Verification

Date: 2026-05-06

## Local Verification

Command:

```bash
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
```

Result:

- `40/40` tests passed.

Covered cases:

- Nested `credentials.value` is rejected as a secret leak.
- Array `authorization[0]` is rejected as a secret leak.
- Nested safe placeholders are accepted.
- `requiredCredentialKeys` metadata is not treated as a secret value.
- Optional `sqlConnection: skipped` can still pass.
- Optional `sqlConnection: fail` forces report `FAIL`.

## Extended Verification

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
```

Result:

- `9/9` tests passed.

Command:

```bash
pnpm run verify:integration-k3wise:poc
```

Result:

- Preflight tests passed.
- Live PoC evidence tests passed.
- Fixture contract tests passed.
- Mock PoC chain completed with `K3 WISE PoC mock chain verified end-to-end (PASS)`.

Command:

```bash
git diff --check -- scripts/ops/integration-k3wise-live-poc-evidence.mjs scripts/ops/integration-k3wise-live-poc-evidence.test.mjs docs/development/integration-k3wise-live-poc-evidence-secret-container-development-20260506.md docs/development/integration-k3wise-live-poc-evidence-secret-container-verification-20260506.md
```

Result:

- Passed with no whitespace errors.
