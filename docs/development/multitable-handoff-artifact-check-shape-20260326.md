# Multitable Handoff Artifact Check Shape

## Background

`multitable-pilot-handoff.mjs` records copied readiness artifacts in two different places:

- `copied.*`
- `artifactChecks.readinessGate.*`

The `copied.*` fields are booleans because `safeCopy()` returns presence success, not destination paths.

One focused test still asserted path-shaped values for:

- `readinessGateReportMd`
- `readinessGateLog`

That no longer matched the actual handoff contract.

## Goal

Align the focused handoff test with the real contract shape:

- artifact checks assert boolean presence
- file-path checks remain covered through copied files on disk and handoff markdown

## Design

No runtime code changes.

Only the focused handoff spec is corrected:

- `artifactChecks.readinessGate.readinessGateReportMd === true`
- `artifactChecks.readinessGate.readinessGateLog === true`

This keeps the test aligned with `safeCopy()` semantics while preserving path-level evidence through:

- copied files under `handoffRoot/gates`
- markdown assertions for `gates/report.md` and `gates/release-gate.log`

## Validation

Executed:

```bash
node --test scripts/ops/multitable-pilot-handoff.test.mjs
```

## Result

The focused handoff contract test now matches the actual JSON shape emitted by the pilot handoff bundle.
