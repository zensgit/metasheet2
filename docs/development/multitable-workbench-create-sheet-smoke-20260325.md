# Multitable Workbench Create-Sheet Chain And Smoke

Date: 2026-03-25

## Context

After the base rollback and prop-sync fixes, the next high-value workbench gap was the real user chain:

`switch base -> create sheet -> enter the created sheet`

Two issues remained:

1. `onCreateSheet()` still reloaded the old base context first and then manually selected the created sheet.
2. If the context refresh failed after sheet creation, the component could still continue into a partially updated state.

This round also adds a higher-level multitable smoke check to the repo's current smoke entrypoint. This tree no longer has the older dedicated multitable live smoke script, so the practical smoke surface in this branch is `scripts/verify-smoke-core.mjs`.

## Design

### 1. Drive create-sheet through context reconciliation

File:
[MultitableWorkbench.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue)

`onCreateSheet()` now:

- creates the sheet with the currently active base
- immediately calls `workbench.syncExternalContext(...)` with the created `sheetId`
- uses the created sheet's `baseId` when available
- stops and shows an error if the context reconciliation fails

This removes the old pattern of:

- reloading an arbitrary base context
- then manually calling `selectSheet(...)`

The result is that "enter the created sheet" is now handled by the same context reconciliation path used for external deep-link changes.

### 2. Add a real UI regression for the create-sheet chain

File:
[multitable-workbench-view.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-view.spec.ts)

Added a component-level regression that verifies:

- user switches to a different base
- user triggers sheet creation from the tab bar add button
- the request uses the switched base id
- the component asks the workbench to reconcile into the newly created sheet context

This is intentionally above the composable level and exercises the actual workbench wiring.

### 3. Add multitable create-base/create-sheet/context checks to smoke core

File:
[verify-smoke-core.mjs](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/verify-smoke-core.mjs)

Added checks:

- `api.multitable.bases`
- `api.multitable.create-base`
- `api.multitable.create-sheet`
- `api.multitable.context`
- `api.multitable.fields`

Minimal smoke sequence:

1. obtain dev token
2. list multitable bases
3. create a unique smoke base
4. create a unique seeded smoke sheet inside that base
5. load context for `baseId + sheetId`
6. verify the created sheet is the resolved context sheet
7. verify seeded fields exist

This is the highest-level multitable smoke surface currently available in this branch without reintroducing the removed dedicated pilot/live-smoke harness.

## Tests

### Existing workbench regressions kept

File:
[multitable-workbench.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench.spec.ts)

Still covers:

- base rollback
- external context sync

### New workbench UI regression

File:
[multitable-workbench-view.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-view.spec.ts)

Added:

- `creates a new sheet inside the switched base and syncs into the created sheet context`

## Verification

Executed in:
[metasheet2-multitable-next](/Users/huazhou/Downloads/Github/metasheet2-multitable-next)

Commands:

```bash
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench.spec.ts tests/multitable-workbench-view.spec.ts --reporter=dot
pnpm --filter @metasheet/web build
node --check scripts/verify-smoke-core.mjs
pnpm verify:smoke:all
```

Results:

- `tsc --noEmit` passed
- `2 files / 15 tests passed`
- `@metasheet/web build` passed
- `node --check scripts/verify-smoke-core.mjs` passed
- `pnpm verify:smoke:all` did **not** complete in the local environment

Smoke blocker:

- local Postgres for the smoke script was unavailable
- failure was at migration bootstrap, before the new multitable smoke checks ran
- concrete error:
  - `connect ECONNREFUSED 127.0.0.1:5435`

This means the smoke wiring is implemented, but full execution still requires the standard local smoke database.

## Out Of Scope

- No attendance files were modified.
- No dedicated multitable live Playwright smoke was added, because this branch no longer contains that pilot smoke harness.
- No on-prem scripts were rerun in this round.
