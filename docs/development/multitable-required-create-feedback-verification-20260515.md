# Multitable Required-Field Create Feedback Verification - 2026-05-15

## Verification Matrix

| Check | Command | Result |
| --- | --- | --- |
| Install workspace links in temporary worktree | `pnpm install --frozen-lockfile` | PASS |
| Targeted frontend regression tests | `pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-view.spec.ts tests/multitable-client.spec.ts --watch=false` | PASS, 2 files / 72 tests |
| Frontend type check | `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS |
| Whitespace/conflict marker scan | `git diff --check` | PASS |

## Targeted Test Evidence

```text
Test Files  2 passed (2)
Tests       72 passed (72)
```

Covered paths:

- `MultitableApiClient.createRecord()` preserves server `fieldErrors` and uses the first field error as the thrown message.
- `MultitableWorkbench` receives the toolbar `add-record` event.
- A required-field create failure stored in `grid.error.value` is shown through the existing `showError()` toast path.

## Negative Checks

- No backend route changed.
- No migration added.
- No integration-core runtime behavior changed.
- No K3 WISE Submit/Audit behavior changed.
- No tracked install side effects were kept from `pnpm install`; generated `node_modules` shim drift was restored before commit.

## Issue Coverage

This closes the issue #1526 P0 symptom:

- Before: `+ New Record` on a required-field staging/multitable sheet could fail without visible feedback.
- After: the same server validation error is surfaced to the user as a toast, for example `Material Code is required`.
