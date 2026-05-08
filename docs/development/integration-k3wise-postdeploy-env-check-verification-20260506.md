# K3 WISE Postdeploy Env Check - Verification

Date: 2026-05-06
Branch: `codex/k3wise-postdeploy-env-check-20260506`

## Verification Plan

Run the new env-check tests, the workflow contract tests, and the existing K3 offline PoC chain:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-env-check.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
pnpm run verify:integration-k3wise:poc
```

Then run package-script coverage and the existing postdeploy smoke/summary tests:

```bash
pnpm run verify:integration-k3wise:postdeploy-env-check
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
git diff --check
```

## Results

### Env Check Tests

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-env-check.test.mjs
```

Result: passed, 11/11 tests.

Covered:

- `require_auth=true` without token fails.
- missing / empty / directory token file fails.
- `K3_WISE_SMOKE_TOKEN` passes without leaking token to stdout/stderr/Markdown.
- unauthenticated mode passes with warning.
- invalid base URL and query/hash URL fail.
- secret-like query values and inline URL credentials are redacted from stdout/stderr/evidence.
- English and Chinese boolean-like env values are accepted for auth/tenant gates.
- base URL with path warns.
- invalid timeout and boolean env values fail.

### Workflow Contract

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
```

Result: passed, 2/2 tests.

Covered:

- manual workflow includes token resolver, env check, smoke, summaries, artifacts, and final gates;
- deploy workflow includes env check before smoke and renders env-check artifacts into the deploy summary.

### K3 Offline PoC

Command:

```bash
pnpm run verify:integration-k3wise:poc
```

Result: passed.

Observed:

- preflight packet tests: 16/16 pass;
- evidence tests: 31/31 pass;
- mock WebAPI + SQL executor chain returned PASS.

### Package Script

```bash
pnpm run verify:integration-k3wise:postdeploy-env-check
```

Result: passed, 11/11 tests.

### Existing Postdeploy Smoke Tests

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
```

Result: passed, 12/12 tests.

### Existing Postdeploy Summary Tests

```bash
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
```

Result: passed, 9/9 tests.

### Diff Check

```bash
git diff --check
```

Result: passed.
