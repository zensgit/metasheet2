# K3 WISE Live PoC Markdown Escape Verification

Date: 2026-05-07

## Target

Verify that the live PoC packet and evidence Markdown renderers keep table shape
stable when dynamic values contain pipes, newlines, and backticks, while the
existing preflight/evidence machine contracts remain unchanged.

## Commands

```bash
node --check scripts/ops/integration-k3wise-live-poc-preflight.mjs
node --check scripts/ops/integration-k3wise-live-poc-evidence.mjs
node --check scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node --check scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
```

Result: passed.

```bash
node --test \
  scripts/ops/integration-k3wise-live-poc-preflight.test.mjs \
  scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
```

Result: passed, 49/49 tests.

```bash
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
```

Result: passed. The demo ended with:

```text
K3 WISE PoC mock chain verified end-to-end (PASS)
```

```bash
git diff --check
```

Result: passed.

## Added Coverage

### Preflight Packet Markdown

`renderMarkdown keeps preflight packet tables stable for markdown-breaking
values`

The test renders a synthetic packet whose summary, external system, pipeline,
checklist, and note values contain table pipes, line breaks, and backticks. It
asserts that:

- metadata values are rendered as inline code where appropriate;
- notes are collapsed into one bullet line;
- External Systems, Pipelines, and Checklist tables keep one header row and one
  data row each;
- pipes inside cells are escaped;
- backtick-containing cells use a larger inline-code fence.

### Evidence Report Markdown

`renderMarkdown keeps evidence report tables stable for markdown-breaking values`

The test renders a synthetic evidence report whose decision metadata, phase
evidence, and issue message contain Markdown-sensitive values. It asserts that:

- decision metadata is rendered as inline code;
- Phase Results and Issues tables keep stable row counts;
- pipes inside phase/issue cells are escaped;
- line breaks do not split table rows;
- backtick-containing cells use a larger inline-code fence.

## Non-Goals Verified By Scope

- JSON packet/report output was not changed.
- CLI stdout summary output was not changed.
- Preflight safety rules were not changed.
- Evidence PASS/PARTIAL/FAIL decision rules were not changed.
- Secret redaction behavior was not changed.

## Outcome

The live PoC customer handoff Markdown is now robust against common copy/paste
and spreadsheet artifacts without changing the automation-facing contract.
