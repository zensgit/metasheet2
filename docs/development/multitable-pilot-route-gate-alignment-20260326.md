# Multitable Pilot Route Gate Alignment

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Align the restored pilot/live-smoke gate with the newly mounted app-shell multitable route so the direct pilot URLs are not only documented, but are also part of the executable readiness bar.

This follows `f42aac363 feat(multitable): mount direct app-shell route`, which made:

```text
/multitable/<sheetId>/<viewId>?baseId=<baseId>
/multitable/<sheetId>/<viewId>?baseId=<baseId>&mode=form&recordId=<recordId>
```

reachable in the first-party web shell.

## Why This Slice

Before this round:

- runbooks and quickstart docs told pilot owners to hand out direct multitable URLs
- `scripts/verify-multitable-live-smoke.mjs` already navigated to those URLs
- but the smoke report did not emit a dedicated success/failure check for the route contract itself
- readiness and runbook acceptance bars therefore could still pass without explicitly proving the direct route entry path

This slice closes that gap without touching the current unstaged UI manager/import workbench WIP.

## Scope

Touch only pilot smoke / readiness / runbook surfaces:

- `scripts/verify-multitable-live-smoke.mjs`
- `scripts/ops/multitable-pilot-readiness.mjs`
- `docs/deployment/multitable-internal-pilot-runbook-20260319.md`

Do not touch:

- `MetaFieldManager.vue`
- `MetaFormView.vue`
- `MetaImportModal.vue`
- `MetaViewManager.vue`
- `MultitableWorkbench.vue`

## Implementation

### 1. Dedicated route-entry checks in live smoke

Added `verifyDirectRouteEntry()` in `scripts/verify-multitable-live-smoke.mjs`.

It now records two once-only pilot checks:

- `ui.route.grid-entry`
- `ui.route.form-entry`

Validation is based on the real browser URL after `page.goto()`:

- path must match `/multitable/<sheetId>/<viewId>`
- required query params must match expected values
- `grid-entry` validates `baseId`
- `form-entry` validates `baseId + mode=form + recordId`

### 2. Readiness required-check alignment

Updated `scripts/ops/multitable-pilot-readiness.mjs` so `summarizeSmoke()` now requires:

- `ui.route.grid-entry`
- `ui.route.form-entry`

This makes readiness fail if the direct pilot entry points stop working even when later UI flows still happen to pass in some alternate navigation path.

### 3. Runbook acceptance bar alignment

Updated `docs/deployment/multitable-internal-pilot-runbook-20260319.md` so the documented acceptance bar matches the executable smoke gate.

## Claude Code Input

Claude Code was used as a scope check for this round.

Prompt intent:

- choose between:
  - route smoke / release-gate alignment
  - import modal refresh cue
- while avoiding the current unstaged WIP in manager/import/workbench component files

Directionally, this matched the local conclusion:

- the next reviewable slice should stay outside the active component WIP
- route-gate alignment is the higher-value follow-up immediately after the direct route mount

## Files

- `scripts/verify-multitable-live-smoke.mjs`
- `scripts/ops/multitable-pilot-readiness.mjs`
- `docs/deployment/multitable-internal-pilot-runbook-20260319.md`
