# Data Factory postdeploy summary adapter details - verification - 2026-05-14

## Scope

This verification covers the postdeploy summary rendering update for Data
Factory adapter discovery failures.

Validated behavior:

- failed smoke evidence with `details.invalidAdapters` renders the nested
  adapter and field path in the summary;
- existing missing adapter, route, field, signoff, markdown escaping, and
  missing-evidence behavior stays unchanged;
- on-prem package scripts include and verify this closeout documentation.

## Commands

### Script syntax

Command:

```bash
node --check scripts/ops/integration-k3wise-postdeploy-summary.mjs
node --check scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
```

Expected: PASS.

Result: PASS.

### Summary renderer regression

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
```

Expected:

- the new Data Factory adapter metadata drift case passes;
- summary renderer exits `0` for failed smoke evidence;
- existing summary tests remain green.

Result: PASS.

Observed output:

```text
✔ renders Data Factory adapter metadata drift details
ℹ tests 15
ℹ pass 15
```

### Postdeploy smoke regression

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
```

Expected:

- adapter discovery smoke evidence still records
  `data-factory-adapter-discovery`;
- the smoke-level `invalidAdapters` failure case remains unchanged.

Result: PASS.

Observed output:

```text
✔ authenticated postdeploy smoke fails when Data Factory adapter metadata loses staging write guardrails
ℹ tests 17
ℹ pass 17
```

### Workflow wiring regression

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
```

Expected:

- manual and deploy workflows still call the postdeploy summary renderer.

Result: PASS.

Observed output:

```text
✔ manual K3 WISE postdeploy smoke workflow keeps dispatch and auth contract stable
✔ deploy workflow keeps K3 WISE smoke evidence wired into deploy summary and artifacts
ℹ tests 2
ℹ pass 2
```

### Diff and staged hygiene

Commands:

```bash
git diff --check
git diff --cached --check
```

Expected: PASS.

Result: PASS.

## Manual Checklist

- No bearer token, JWT, private key, webhook, or local absolute path is added.
- No package artifact under `output/` is generated or staged.
- The summary renderer consumes existing evidence only; it does not perform
  live network calls.
