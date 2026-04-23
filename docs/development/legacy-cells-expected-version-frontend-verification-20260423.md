# Legacy Cells Expected Version Frontend Verification - 2026-04-23

## Summary

Result: PASS

This verification covers the legacy spreadsheet frontend opt-in for backend cell optimistic locking from PR #1042.

## Commands

### Dependency Bootstrap

```bash
pnpm install --frozen-lockfile
git restore -- plugins/ tools/cli/node_modules
```

Result: PASS

Notes:

- The new worktree did not have local dependencies.
- `pnpm install` produced known plugin/CLI `node_modules` symlink noise.
- Only those dependency-link paths were restored; business files were preserved.

### Frontend Focused Unit Test

```bash
pnpm --filter @metasheet/web exec vitest run tests/spreadsheet-cell-versioning.spec.ts --reporter=dot
```

Result: PASS

Output:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

Note: Vitest printed `WebSocket server error: Port is already in use` during one focused frontend run, but the process exited 0 and all target assertions passed. No dev server was required for this test.

Coverage:

- Builds version cache from server cells.
- Adds `expectedVersion` only for known cells.
- Merges successful PUT response versions without dropping untouched cells.
- Formats conflict messages from `VERSION_CONFLICT` payloads.

### Frontend Type Check

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: PASS

### Backend Regression For PR #1042 Contract

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/spreadsheets-cell-version.test.ts --reporter=dot
```

Result: PASS

Output:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

### Whitespace Check

```bash
git diff --check
```

Result: PASS

## Manual Verification Plan

Recommended staging checks after merge:

1. Open the same legacy spreadsheet in two browser sessions.
2. Session A loads cells and edits `A1`, then saves.
3. Session B, without refresh, edits the same `A1` and saves.
4. Expected: Session B receives a `409 VERSION_CONFLICT` message and local edits are not marked synced.
5. Refresh Session B, edit again, save.
6. Expected: save succeeds and the version cache advances from the PUT response.

## Limitations

- No automatic merge UI is implemented for legacy spreadsheet cells.
- Unknown/new cells still omit `expectedVersion` to preserve old-client compatibility.
- This branch does not add browser automation for the two-session conflict flow.
