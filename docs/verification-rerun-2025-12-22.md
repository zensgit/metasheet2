# Verification Rerun (2025-12-22)

## Scope
- Backend integration + unit tests
- Frontend Vue Vitest + type checks
- React type checks
- Readonly suite, related records UI, computed filter/sort warnings
- View config import/export UI
- Windowing verification (Vue + React)
- Univer POC performance baseline

## Commands Run
```bash
pnpm --filter @metasheet/core-backend test:integration
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/web exec vitest run --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter web-react exec tsc --noEmit

NODE_PATH=apps/web-react/node_modules bash scripts/verify-readonly-suite.sh
NODE_PATH=apps/web-react/node_modules node scripts/verify-related-records-ui.cjs
NODE_PATH=apps/web-react/node_modules RUN_SETUP=true node scripts/verify-computed-filter-sort-ui.cjs
NODE_PATH=apps/web-react/node_modules node scripts/verify-view-config-import-export-ui.cjs
NODE_PATH="$(pwd)/apps/web-react/node_modules" node scripts/verify-grid-entry-legacy.cjs

TARGET=vue OUTPUT_DIR=artifacts/windowing-verify-20251222-full node --import tsx scripts/verify-windowing.ts
TARGET=react OUTPUT_DIR=artifacts/windowing-verify-20251222-full-react node --import tsx scripts/verify-windowing.ts
OUTPUT_DIR=artifacts/univer-poc/windowed-2000x30-20251222-full ROWS=2000 COLS=30 WINDOW_SIZE=200 WINDOW_BUFFER=100 WINDOW_MAX=1000 node --import tsx scripts/benchmark-univer-poc.ts
```

## Results
- ✅ Backend integration tests passed (11 files, 65 tests)
- ✅ Backend unit tests passed (25 files, 266 tests)
- ✅ Vue Vitest + vue-tsc passed
- ✅ React tsc passed
- ✅ Readonly suite passed
- ✅ Related records UI check passed
- ✅ Computed filter/sort warning check passed
- ✅ View config import/export UI check passed
- ✅ Legacy grid entry check passed (Univer redirect)
- ✅ Windowing verification passed (Vue + React)
- ✅ Performance baseline generated

## Evidence
- Readonly suite:
  - `artifacts/readonly-suite/verification-readonly-ui.json`
  - `artifacts/readonly-suite/verification-readonly-list-ui.json`
  - `artifacts/readonly-suite/verification-readonly-header-icons.json`
  - `artifacts/readonly-suite/verification-readonly-header-tooltips.json`
- Related records UI: `artifacts/related-records-ui.png`
- Computed filter/sort warnings:
  - `artifacts/computed-filter-sort-warning-grid.png`
  - `artifacts/computed-filter-sort-warning-kanban.png`
  - `artifacts/kanban-soft-refresh.png`
- View config UI: `artifacts/view-config-ui/view-import-export.png`
- Legacy grid entry: `artifacts/grid-entry-legacy-verification.json`
- Windowing:
  - `artifacts/windowing-verify-20251222-full/windowing-verification.md`
  - `artifacts/windowing-verify-20251222-full-react/windowing-verification.md`
- Performance baseline:
  - `artifacts/univer-poc/windowed-2000x30-20251222-full/performance-baseline-2000x30.md`

## Notes
- Plugin/BPMN warnings appear in tests due to missing local plugin builds and workflow tables.
- Use an absolute `NODE_PATH` when running Playwright scripts from repo root.
