# Multitable range fill verification

The opt-in grid now supports rectangular copy and paste, four-direction repeat fill, and numeric or civil-date series. Local acceptance passed on 2026-10-08 and 2026-10-09 (Asia/Taipei). This is a local implementation result, not staging delivery or production acceptance.

Base: `9d65b8318f3d5cbc323b458cb5c96c2240a144f7`. Branch: `codex/multitable-range-fill-20261008`. Contract: [design lock](multitable-range-fill-design-lock-20261008.md). The original checkout and other feature worktrees were not modified.

## Behavior and implementation

Select cells by dragging, Shift-click, or Shift-arrow. Choose Copy or Series in the toolbar and drag the lower-right handle. Copy and paste also work through the toolbar or Ctrl/Cmd+C/V. Operations address loaded visible cells only; they never create records or target collapsed groups, filtered rows or hidden columns. Mouse dragging can use the existing scrollable grid; automatic edge scrolling and touch gestures are outside this slice.

The planner in `apps/web/src/multitable/utils/grid-range-fill.ts` validates the complete operation before returning changes. It handles quoted TSV, nullable clears, strict number/date/select conversion, source-anchored reverse tiling, and independent numeric/date series. Clipboard booleans accept case-insensitive true/false, numbers accept decimal/exponent notation without whitespace, and dateTime text requires an explicit timezone. Series do not infer text patterns or fall back silently to copy.

`useGridRangeSelection.ts` freezes source values and destination versions, cancels stale clipboard/drag work, and keeps delayed responses from replacing a new view's status. `MetaGridRangeToolbar.vue` supplies fixed translated feedback. Grid and workbench changes are limited to integration bindings and selection styling.

`useMultitableGrid.patchRange` sends one existing `/api/multitable/patch` request with `partialSuccess: false`. It checks every destination, preserves captured versions, makes no optimistic edits, rejects concurrent range requests, and avoids applying an old response over newer realtime versions. Successful range operations clear both single-cell undo and redo history. The toolbar explicitly states that range undo is unavailable. Timeout outcomes require refresh and inspection before retry; there is no automatic replay.

## Acceptance gates

| Gate | Local evidence | Result |
| --- | --- | --- |
| G1 Planner | 80 tests: all directions, odd reverse offsets, independent row/column series, decimal steps, leap/month/year/DST transitions, TSV and typed negatives | Pass |
| G2 Interaction | 42 real-component tests plus Chromium selection, numeric series, real clipboard roundtrip, multirow paste and date series | Pass |
| G3 Guards | Exact-string flag 9 tests; locked/readonly/masked/denied, cap, stale identity/version/field/view, outside release and late completion negatives | Pass |
| G4 Atomic writer | 42 tests: one request, expected versions, no optimistic mutation, 403/409/422/network failure, concurrency, navigation and newer realtime projection | Pass with mocked transport |
| G5 Collection and regressions | Four specs in domain guard execution and required web list; both PR and push path triggers. Eight neighboring specs, 190 tests | Pass locally; remote CI pending |
| G6 Review and verification | Three discriminating guard mutations; application TypeScript check; Vite bundle; inspected Chromium screenshot | Pass with tooling limitation below |

Unique local test total: **451** (173 new frontend + 190 neighboring frontend + 52 existing backend writer + 36 manifest tests). The planner also passed all 80 tests under `TZ=America/Los_Angeles`; this repeat is not included again in the total. Existing backend writer tests use mocked database helpers, not a live database.

Independent review corrections included preserving newer realtime data against a late range response, reporting an oversized Copy as a size limit rather than a clipboard permission error, and preserving stale-context feedback after late failures or clipboard completion.

### Mutation results

Each mutation was temporary and restored with a targeted patch before the final green run.

| Removed protection | Discriminating failure |
| --- | --- |
| Writer equality check for expected version | 2 writer tests failed |
| Clipboard snapshot generation and signature check | 5 stale-context interaction tests failed |
| Planner per-user write callback | 1 whole-matrix permission test failed |

## Repeat the checks

Use Node 20 with the repository dependencies installed. From `apps/web`:

```sh
node node_modules/vitest/vitest.mjs run tests/multitable-range-fill-flag.spec.ts tests/multitable-range-fill-planner.spec.ts tests/multitable-range-fill-writer.spec.ts tests/multitable-range-fill-interaction.spec.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
TZ=America/Los_Angeles node node_modules/vitest/vitest.mjs run tests/multitable-range-fill-planner.spec.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
node node_modules/vitest/vitest.mjs run tests/multitable-grid.spec.ts tests/multitable-grid-bulk-edit.spec.ts tests/multitable-grid-cell-edit-commit.spec.ts tests/multitable-grid-cell-edit-commit-round2.spec.ts tests/meta-grid-table-virtualization.spec.ts tests/meta-grid-table-editable-types.spec.ts tests/multitable-grid-grouped-link-chip.spec.ts tests/multitable-workbench.spec.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
node --max-old-space-size=4096 node_modules/vue-tsc/bin/vue-tsc.js -p tsconfig.app.json --noEmit
node --max-old-space-size=4096 node_modules/vite/bin/vite.js build
```

From the repository root, run `node --test scripts/ops/global-history-flag-manifest.test.mjs`. From `packages/core-backend`, run `node node_modules/vitest/vitest.mjs run tests/unit/record-write-service.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot`.

For the browser check, start the isolated synthetic fixture from `apps/web` in one terminal, then execute the verification script in a second terminal from the same directory:

```sh
VITE_MULTITABLE_RANGE_FILL_ENABLED=true node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 18919 --strictPort
node scripts/verify-range-fill-browser.mjs
```

The browser check uses `tests/fixtures/range-fill-browser-demo.html`, the real grid component and a synthetic in-memory writer. It asserts three commits and no browser errors. It saves `artifacts/range-fill/grid-range-fill.png` at the repository root. This screenshot was visually inspected; the fixture is not a production route or a backend persistence test.

## Build and release boundaries

Application source type checking and Vite bundling pass. The combined `vue-tsc -b` command has an existing `vite.config.ts:28` TS2769 mismatch between Vite 7 and Vitest's Vite 5 types in the linked local dependency installation. The isolated `tsconfig.node.json` check reproduces it; the relevant config, package manifest and lockfile are identical to the base commit. No dependency upgrades are included, and the full package build is not claimed green.

No new backend API, migration, customer data, external-system write, deployment or enablement is included. `VITE_MULTITABLE_RANGE_FILL_ENABLED` defaults OFF and requires the exact build-time string `true`. Runtime environment changes alone do not enable an already-built frontend. A real authenticated backend/staging smoke, exact-head CI, publication and merge remain separate release steps.

The earlier Actions run on the base main commit, [37800491746](https://github.com/zensgit/metasheet2/actions/runs/37800491746), failed during action download preparation; its self-hosted test job did not execute tests. It is not CI evidence for this branch.

## Model contributions

Sol 6.1 implemented and tested the writer, added planner and interaction tests, and performed independent code review. Luna 6 implemented the flag and initial CI/manifest wiring. Kimi K3 provided design counterexamples. Grok 4.7 was invoked for the planner but produced no files before its task was closed; it is not credited with implementation or tests. Codex completed the planner and UI integration, corrected review findings, independently ran the verification and mutation checks, and completed both PR/push source-trigger wiring.
