# Attendance Preview Retry Sync Design

Date: 2026-03-25  
Repo: `metasheet2-multitable`  
Branch: `codex/multitable-fields-views-linkage-automation-20260312`

## Context

After syncing the attendance slice from `origin/main`, the multitable branch still kept an older inline `AttendanceView.vue` implementation for import preview handling. That implementation did not clear `importPreview` and `importCsvWarnings` when a preview request failed after a previous successful preview.

This produced a user-facing inconsistency:

- status banner switched to retry/error state
- setup state was expected to represent a failed preview
- but stale preview rows and warning text from the previous success remained visible in the import section

## Problem

The stale state leak happened in `previewImport()`:

- previous preview rows were not cleared before a new preview started
- failure handling did not reset preview rows and CSV warnings

That meant a second preview failure could render:

- `Retry preview`
- error status and code
- plus the old successful preview table and warnings

## Design Decision

Keep the fix minimal and local to the existing multitable branch architecture.

### Runtime fix

In [`AttendanceView.vue`](/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/src/views/AttendanceView.vue):

- clear `importPreview` and `importCsvWarnings` at the start of `previewImport()`
- clear the same state again in the `catch` path

This matches the intended behavior already present in the newer extracted attendance workflow implementation from main.

### Regression test update

In [`attendance-import-preview-regression.spec.ts`](/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/tests/attendance-import-preview-regression.spec.ts):

- stop asserting against broad page-level `container.textContent`
- inspect the import section directly
- assert preview table row count, empty-state text, and CSV warning block content
- keep `statusMeta.action === retry-preview-import`
- remove the old `statusMeta.context` assertion because this branch’s inline attendance page status model does not expose `context`

## Scope

Included:

- import preview retry state cleanup
- regression test alignment to current multitable attendance page contract

Excluded:

- larger attendance refactor from main
- import workflow composable extraction
- any multitable feature changes

## Files

- [AttendanceView.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/src/views/AttendanceView.vue)
- [attendance-import-preview-regression.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/tests/attendance-import-preview-regression.spec.ts)

