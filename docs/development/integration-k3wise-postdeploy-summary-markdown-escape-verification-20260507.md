# K3 WISE Postdeploy Summary Markdown Escape Verification - 2026-05-07

## Scope

This verification covers:

```text
scripts/ops/integration-k3wise-postdeploy-summary.mjs
scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
```

The target is GitHub Step Summary rendering for K3 WISE postdeploy smoke
evidence.

## Commands

```bash
node --check scripts/ops/integration-k3wise-postdeploy-summary.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
git diff --check
```

## Result

```text
node --check scripts/ops/integration-k3wise-postdeploy-summary.mjs
# pass

node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
# 10 tests pass

git diff --check
# pass
```

## Regression Added

New test:

```text
escapes markdown-breaking values in postdeploy summary output
```

The test builds evidence containing:

- a base URL with backticks and a newline
- a signoff reason with a pipe and a newline
- a check id with backticks and a newline
- a nonstandard check status with a backtick
- failed-check detail values with backticks, pipes, and newlines

Assertions confirm the summary:

- keeps signoff reason on one line
- uses doubled backticks when values contain single backticks
- preserves failed-check detail readability
- does not drop the existing summary shape

## Notes

The change intentionally does not alter the evidence JSON schema or smoke
decision logic. It only stabilizes Markdown rendering for operator-facing
deployment summaries.

