# Multitable Gantt Self-Table Dependency Field · Verification

> Date: 2026-05-07
> Branch: `codex/multitable-gantt-self-table-dependency-20260507`

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-gantt-view.spec.ts \
  tests/multitable-view-manager.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --watch=false --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-view-config.api.test.ts \
  --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
pnpm --filter @metasheet/core-backend build
git diff --check
```

## Results

Frontend focused tests:

```text
Test Files  3 passed (3)
Tests       76 passed (76)
```

Backend view-config integration test:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

Type/build gates:

```text
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
passed

pnpm --filter @metasheet/core-backend build
passed

git diff --check
passed
```

## Coverage Added

- `resolveGanttViewConfig()` keeps self-table link dependency fields and drops cross-table link dependency fields when `sheetId` is provided.
- `MetaGanttView` dependency dropdown lists self-table links only.
- `MetaViewManager` Gantt dependency dropdown lists self-table links only.
- `MultitableWorkbench` passes active sheet id into `MetaGanttView`.
- Backend rejects `PATCH /views/:viewId` with a cross-table Gantt dependency field.
- Backend allows `PATCH /views/:viewId` with a self-table Gantt dependency field.
- Backend rejects `POST /views` when a new Gantt config references a non-self-table dependency field.

## Notes

The default backend vitest config excludes integration tests, so the backend route test must be run with `vitest.integration.config.ts`.

`pnpm install --frozen-lockfile` rewrote plugin and CLI `node_modules` symlinks in the worktree. Those install artifacts were reverted with:

```bash
git checkout -- plugins/ tools/
```
