# K3 WISE Postdeploy Smoke Markdown Escape Verification

Date: 2026-05-07

## Target

Verify that `integration-k3wise-postdeploy-smoke.mjs` still runs the existing
postdeploy smoke contract while its Markdown evidence output remains stable when
values contain table pipes, backticks, and newlines.

## Commands

```bash
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
```

Result: passed.

```bash
node --test \
  scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs \
  scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
```

Result: passed, 15/15 tests.

```bash
git diff --check
```

Result: passed.

## Added Coverage

`postdeploy smoke markdown escapes table-breaking evidence values`

The test builds a synthetic evidence payload with:

- `generatedAt` containing a newline;
- `baseUrl` containing a backtick and newline;
- signoff reason containing a pipe and newline;
- check ID containing a pipe, newline, and backticks;
- check status containing a newline;
- check error detail containing a pipe, newline, and backticks;
- object detail containing a pipe and newline.

Assertions verify that:

- metadata values are rendered as safe inline code where appropriate;
- signoff reason is collapsed to a single line;
- the Markdown check table still has exactly header, separator, and two data
  rows;
- table pipes inside cells are escaped;
- backtick-containing values use a larger inline-code fence;
- actual newline characters do not split table rows.

## Non-Goals Verified By Scope

- JSON evidence format is unchanged.
- CLI stdout summary format is unchanged.
- HTTP probe sequence is unchanged.
- Token redaction logic is unchanged.
- Workflow contract assertions remain green.

## Outcome

The postdeploy smoke evidence Markdown is now robust enough for customer-facing
handoff packets and GitHub artifact inspection without changing the machine
contract consumed by automation.
