# Multitable Default Entry Verification - 2026-05-17

## Result

PASS.

The change was validated in a clean worktree:

`/private/tmp/ms2-multitable-entry-20260517`

Base commit:

`origin/main @ bded0c60a`

## Commands

### V1 - Install

Command:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Result:

PASS.

Notes:

- Lockfile was already up to date.
- No package or lockfile changes were produced.

### V2 - Focused Frontend Tests

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-home-view.spec.ts \
  tests/platform-shell-nav.spec.ts \
  --watch=false
```

Result:

PASS.

Observed:

- `tests/platform-shell-nav.spec.ts`: 3/3 pass.
- `tests/multitable-home-view.spec.ts`: 2/2 pass.
- Total: 5/5 pass.

Non-blocking note:

- Vitest printed `WebSocket server error: Port is already in use`.
- The test process still exited 0 and all assertions passed.

### V3 - Frontend Type Check

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

PASS.

### V4 - Backend Type Check

Command:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

PASS.

### V5 - Backend Preset Tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/attendance-import-permission.test.ts \
  --run
```

Result:

PASS.

Observed:

- 2 test files passed.
- 63/63 tests passed.

### V6 - Diff Hygiene

Command:

```bash
git diff --check
```

Result:

PASS.

## Assertions Covered

- Platform shell shows `/multitable` as the table entry.
- Platform shell does not show `/grid`.
- Platform shell does not show `/spreadsheets`.
- Multitable home lists bases from `listBases()`.
- Opening a base resolves context with `loadContext({ baseId })`.
- Opening a base navigates to `AppRouteNames.MULTITABLE`.
- Creating a base creates a seeded first sheet before navigation.
- Platform onboarding presets now point at `/multitable`.
- TypeScript accepts the new route constants and view.

## Not Verified

- No live browser smoke was run.
- No backend integration DB test was run for real base creation.
- No `/api/spreadsheets` behavior was re-tested because this slice intentionally does not modify legacy Spreadsheet APIs.

