# Multitable Base-Scoped Workbench Bootstrap

Date: 2026-03-24

## Context

After switching this window back from attendance work to the multitable mainline, the highest-value remaining UX inconsistency was in base navigation:

- `MetaBasePicker` could switch the visible base in UI,
- but initial workbench bootstrap and some reload paths still started from the global `listSheets()` flow,
- so in multi-base setups the selected base and the loaded sheet/view state could drift apart.

This was user-visible in pilot scenarios because the top bar could indicate one base while the sheet/view state still originated from a different base or from the global sheet list.

## Design

### 1. Base state moves into the workbench state machine

`useMultitableWorkbench()` now owns:

- `activeBaseId`
- `loadBaseContext(baseId, { sheetId?, viewId? })`
- `selectBase(baseId)`

This keeps base, sheet, view, capabilities, and fields in one state source instead of splitting them between the component and the composable.

## 2. Bootstrap prefers base-scoped context

`MultitableWorkbench.vue` now bootstraps in this order:

1. load bases
2. if a base is known, load context from that base
3. otherwise fall back to the global sheet bootstrap path

This means a base-scoped entry point now initializes directly from `/api/multitable/context?baseId=...` instead of briefly loading the global sheet universe first.

## 3. Base selection and sheet selection keep each other in sync

- Selecting a base now routes through `workbench.loadBaseContext(...)`.
- Selecting a sheet updates `activeBaseId` from the selected sheet's `baseId`.
- Loading sheet metadata also re-syncs `activeBaseId` from context.

This removes the stale-state case where the sheet/view state was correct but the base picker still displayed an old base.

## 4. System people sheet remains hidden inside base context

The existing people-sheet filtering is preserved for base-scoped context as well, so the workbench does not regress into showing the internal system sheet when bootstrapping from a base.

## Files

- [/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/src/multitable/composables/useMultitableWorkbench.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/src/multitable/composables/useMultitableWorkbench.ts)
- [/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/src/multitable/views/MultitableWorkbench.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/src/multitable/views/MultitableWorkbench.vue)
- [/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/tests/multitable-workbench.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable/apps/web/tests/multitable-workbench.spec.ts)

## Verification

Commands run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench.spec.ts --reporter=dot
pnpm --filter @metasheet/web build
```

Results:

- Vitest passed: `1 file / 11 tests passed`
- `@metasheet/web build` passed

## Claude Code

Claude Code was invoked for a narrow reviewer pass on the workbench base-scoping change. The local CLI session did not return a stable review result within the short verification window, so final sign-off for this round is based on local Vitest and build results.

## Out of Scope

- No attendance files were modified in this round.
- No backend route changes were needed.
- No on-prem, readiness, or smoke scripts were rerun in this round.
