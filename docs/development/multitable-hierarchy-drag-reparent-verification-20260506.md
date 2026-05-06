# Multitable Hierarchy Drag Reparent Verification - 2026-05-06

## Environment

- Worktree: `/private/tmp/ms2-hierarchy-drag-reparent-20260506`
- Branch: `codex/multitable-hierarchy-drag-reparent-20260506`
- Base: `origin/main@922cff530be14f8f661d3105ecf9dd5139ea8ab4`
- Dependency setup: `pnpm install --frozen-lockfile`

`pnpm install` produced local dependency symlink noise under `plugins/*/node_modules` and `tools/cli/node_modules`. Those files are not part of this feature commit.

## Automated Verification

### Focused frontend behavior

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-hierarchy-view.spec.ts tests/multitable-workbench-view.spec.ts --watch=false --reporter=dot
```

Result:

```text
Test Files  2 passed (2)
Tests       55 passed (55)
```

Coverage added:

- drag child row onto another row emits `reparent-record`
- drag child row to the root drop zone emits a null parent
- dragging a parent under a visible descendant is blocked client-side
- workbench passes scoped edit gating into Hierarchy
- workbench converts Hierarchy reparent events into `patchRecords` calls

### Frontend type check

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: exit 0.

### Whitespace guard

Command:

```bash
git diff --check -- apps/web/src/multitable/components/MetaHierarchyView.vue apps/web/src/multitable/views/MultitableWorkbench.vue apps/web/tests/multitable-hierarchy-view.spec.ts apps/web/tests/multitable-workbench-view.spec.ts
```

Result: exit 0.

## Manual Verification Notes

Recommended staging smoke after merge:

1. Open a hierarchy view with an editable parent link field.
2. Drag a child record onto another parent and confirm it moves after refresh.
3. Drag the same child to the root drop zone and confirm the parent link clears.
4. Use a read-only row scope and confirm drag affordances are disabled.
5. Attempt to drag a parent under its visible child and confirm the warning appears and no write happens.

## Residual Risk

Server-side cycle prevention is still open. This feature prevents obvious UI mistakes, but authoritative validation must be added in a follow-up backend slice before treating hierarchy constraints as complete.

