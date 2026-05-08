# Multitable Gantt Forced Mode Smoke - Verification - 2026-05-08

## Local Verification

### Install dependencies in isolated worktree

```bash
pnpm install --frozen-lockfile
```

Result:

```text
Done in 3s using pnpm v10.33.0
```

Notes:

- The install was run only inside the isolated worktree.
- Dependency symlink changes under `plugins/*/node_modules` and
  `tools/cli/node_modules` were not staged.

### Frontend targeted tests

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-embed-route.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --reporter=verbose
```

Result:

```text
Test Files  2 passed (2)
Tests       55 passed (55)
```

New assertions:

- Route props preserve `mode: 'gantt'` for `/multitable/:sheetId/:viewId?mode=gantt`.
- Workbench forced mode renders `MetaGanttView` instead of the grid surface.

### Gantt Playwright discoverability

```bash
pnpm --filter @metasheet/core-backend exec playwright test \
  --config tests/e2e/playwright.config.ts \
  multitable-gantt-smoke.spec.ts \
  --list
```

Result:

```text
Total: 3 tests in 1 file
```

The two browser-rendering tests now deep-link with `?mode=gantt`; the API
validation test is unchanged.

### Frontend typecheck

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result:

```text
exit 0
```

## Staging Status

This slice was not re-run against 142 after the code change because 142 still
needs a new deployment containing this frontend change.

Expected post-deploy command shape:

```bash
FE_BASE_URL=http://127.0.0.1:18081 \
API_BASE_URL=http://127.0.0.1:18990 \
AUTH_TOKEN="$(cat /tmp/metasheet-staging-ui-smoke-admin.jwt)" \
pnpm --filter @metasheet/core-backend exec playwright test \
  --config tests/e2e/playwright.config.ts \
  multitable-gantt-smoke.spec.ts \
  --workers=1
```

Pass criteria after deploy:

- `.meta-gantt__bar` appears for the bar-rendering test.
- `.meta-gantt__dependency-arrow` appears for the dependency-arrow test.
- The invalid dependency field API test still returns `400` with
  `VALIDATION_ERROR`.

## Conclusion

The local contract gap is fixed: `mode=gantt` now forces the Gantt surface and
the Gantt smoke uses that direct route. Full remote sign-off remains pending a
142 deploy and re-run.
