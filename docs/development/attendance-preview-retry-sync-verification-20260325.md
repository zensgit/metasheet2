# Attendance Preview Retry Sync Verification

Date: 2026-03-25  
Repo: `metasheet2-multitable`  
Branch: `codex/multitable-fields-views-linkage-automation-20260312`

## Verified Change

Commit:

- `a4ffffd54` `fix(attendance): clear stale preview retry state`

Behavior verified:

- successful preview still renders preview rows and merged CSV/group warnings
- failed retry clears stale preview rows
- failed retry clears stale CSV warnings
- failed retry keeps retry action metadata
- clicking `Retry preview` after failure does not restore stale rows or stale warnings

## Commands Run

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench.spec.ts \
  tests/multitable-import.spec.ts \
  tests/multitable-link-picker.spec.ts \
  tests/multitable-record-drawer.spec.ts \
  tests/attendance-import-preview-regression.spec.ts \
  --watch=false
```

Result:

- `5 files / 30 tests passed`

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- passed

## Notes

- The regression originally failed for a real runtime reason, not just brittle assertions: stale preview rows and warnings remained visible after a preview failure.
- The final test now targets the import section itself instead of broad page text, which reduces false positives while preserving the intended behavior check.
- This verification only covers the attendance preview retry sync and a minimal multitable UI regression set. It is not a full multitable branch validation.

