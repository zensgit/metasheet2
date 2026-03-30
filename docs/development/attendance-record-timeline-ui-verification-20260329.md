# Attendance Record Timeline UI Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/web exec vitest run tests/attendance-record-timeline.spec.ts tests/attendance-admin-anchor-nav.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Focused Test Result

The new record timeline spec verifies:

- the exact punch-events URL emitted from the records detail row
- chronological rendering of the inline timeline list
- inline unsupported-endpoint fallback on `404`
- no repeated retry after support is known absent

The existing admin navigation suite was rerun as regression coverage because this slice edits the same large view file.

Observed result:

- `20 passed`

## Typecheck / Build

- `vue-tsc --noEmit` passed
- `@metasheet/web build` passed

## Behavioral Summary

Verified outcomes for this slice:

- each record row now exposes a `Details` action
- opening a row lazily loads the raw punch timeline for that work date
- successful responses are cached per row for the current table load
- unsupported servers degrade inline without polluting the global status banner
- refreshing the records table clears stale timeline detail state

## Claude Code Status

Claude Code was re-checked in this restarted session, but `/Users/huazhou/.local/bin/claude` is not present, so it could not be used for this slice.
