# Data Factory adapter discovery postdeploy smoke - verification - 2026-05-14

## Scope

This verification covers the postdeploy smoke extension for Data Factory
adapter discovery.

Validated behavior:

- authenticated smoke calls `/api/integration/adapters`;
- smoke evidence includes `data-factory-adapter-discovery`;
- `metasheet:staging` is validated as the source-side multitable adapter;
- `metasheet:multitable` is validated as the target-side multitable adapter;
- a missing or unsafe guardrail causes the smoke to fail.
- the Windows on-prem package scripts include and verify this smoke evidence.

## Commands

### Smoke unit test

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
```

Expected:

- public smoke remains unchanged and still skips authenticated checks without a
  token;
- authenticated smoke now records the adapter discovery check;
- failure evidence remains redacted;
- metadata drift in Data Factory multitable adapters fails the smoke.

Result: PASS.

Observed output:

```text
✔ authenticated postdeploy smoke validates route and staging contracts without leaking token
✔ authenticated postdeploy smoke fails when Data Factory adapter metadata loses staging write guardrails
ℹ tests 17
ℹ pass 17
```

### K3 WISE mock PoC regression

Command:

```bash
pnpm verify:integration-k3wise:poc
```

Expected:

- Save-only K3 mock chain remains PASS;
- adding a read-only adapter discovery smoke does not change K3 execution.

Result: PASS.

Observed output:

```text
✓ step 6: K3 Save-only upsert wrote 2 records, 0 Submit, 0 Audit (PoC safety preserved)
✓ step 8-9: evidence compiler returned PASS with 0 issues
✓ K3 WISE PoC mock chain verified end-to-end (PASS)
```

### Script syntax and diff hygiene

Commands:

```bash
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
node --check scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
git diff --check
```

Expected: PASS.

Result: PASS.

## Manual Checklist

- No bearer token is printed to stdout, stderr, JSON evidence, or Markdown
  evidence.
- No live external write is performed by the new check.
- The check requires only stable roles and guardrails, not staging's exact
  supports list.
- The on-prem package verifier checks the smoke script for
  `data-factory-adapter-discovery`.
