# Multitable App Shell Route Mount Verification

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Verified Commands

### Focused route and workbench coverage

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-embed-route.spec.ts \
  tests/multitable-phase5.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --watch=false
```

Result:

- `3 files / 23 tests passed`

### Type check

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- passed

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

Result:

- passed

## What The Tests Prove

`tests/multitable-embed-route.spec.ts`

- the app-shell contract now matches `/multitable/:sheetId/:viewId`
- pilot grid URL resolves to the expected host props
- pilot form URL resolves to the expected host props

`tests/multitable-phase5.spec.ts`

- existing embed-host message contract coverage still passes

`tests/multitable-workbench-view.spec.ts`

- workbench view wiring remains intact after route helper extraction

## Notes

- A first attempt imported `appRoutes` through `main.ts` and failed in Vitest because app bootstrap transitively pulled CSS-only imports. The final verification path uses the extracted `multitableRoute.ts` helper instead, which validates the real route mapping without importing bootstrap-only dependencies.
