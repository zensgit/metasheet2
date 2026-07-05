# Multitable grid grouped-windowing runtime — dev & verification (2026-07-05)

> **Design-lock**: `docs/development/multitable-grid-grouped-windowing-designlock-20260705.md`
> (`#3591`, squash `b061d4166`).
>
> **Runtime**: PR #3648.
>
> **Runtime scope**: frontend render-only in `MetaGridTable.vue`, plus jsdom and Playwright
> verification. No backend, API, storage, data-shape, env-flag, grouped paging, server-side grouping,
> or cross-page grouping behavior changed.

## 1. Line summary

The measure-first baseline (`docs/development/multitable-grid-perf-baseline-20260705.md`, `#3582`,
`b891780bd`) showed the flat grid path was already windowed, while the grouped `<tbody>` still mounted
the whole flattened group stream. This runtime extends the existing flat-window architecture to grouped
mode by slicing the already-existing `groupRenderItems` stream and reserving off-screen item height with
top/bottom spacer rows.

The slice is intentionally narrow: it makes large grouped render surfaces bounded in the DOM. It does
not change grouped pagination, grouping semantics, server aggregate contracts, or how many records the
workbench loads.

## 2. Implementation

Primary file:

- `apps/web/src/multitable/components/MetaGridTable.vue`

Runtime behavior:

- The grouped branch now renders `windowedGroupRenderItems` rather than the full `groupRenderItems` list.
- `renderableGroupItems` filters subtotal entries when there are no server subtotals, so the offset table
  matches the actual mounted stream.
- Grouped mode uses a per-kind height table:
  - data row: existing density-aware `rowHeightPx`
  - group header: measured first mounted `.meta-grid__group-header`, fallback to row height
  - group subtotal: measured first mounted `.meta-grid__group-subtotal`, fallback to row height
- `groupedItemOffsets` is a prefix-sum table over the renderable stream; scroll offset resolves to item
  index by binary search.
- The existing spacer row pattern is reused for grouped mode:
  - `topSpacerHeight = offset[groupWindowStart]`
  - `bottomSpacerHeight = totalHeight - offset[groupWindowEnd]`
- Keyboard focus scroll-in-view now resolves grouped row pixel offsets through the grouped offset table;
  flat focus math remains flat-only.
- `printing` disables grouped windowing exactly as it already disables flat windowing.

Verification files:

- `apps/web/tests/meta-grid-table-virtualization.spec.ts`
- `apps/web/tests/multitable-grid-perf-baseline.spec.ts`
- `apps/web/verification/grouped-windowing-harness.html`
- `apps/web/verification/grouped-windowing-harness.ts`
- `apps/web/verification/grouped-windowing.spec.ts`

## 3. Golden matrix

| Lock | Proof |
| --- | --- |
| GW1 bounded grouped DOM | `3,000 rows / 30 groups` now mounts a bounded grouped window; baseline grouped spec flipped from "documents full render" to "locks bounded render". |
| GW2 scroll sequence | Scrolling the grouped container changes the mounted first row while keeping DOM count bounded. |
| GW3 spacer invariant | Under jsdom's 36px density fallback, `top spacer + mounted item heights + bottom spacer == full grouped stream height`. |
| GW4 keyboard nav | Arrow navigation to an off-window grouped record scrolls that exact absolute `navIndex` into the mounted window. |
| GW5 collapse clamp | Controlled group collapse while scrolled deep leaves a nonblank bounded window and keeps the toggled header mounted. |
| GW6 subtotal parity | Server-provided `aggregateGroups` values render unchanged inside the grouped window. |
| GW7 select-all parity | Header select-all emits all model row ids (`3,000`), not only mounted DOM ids. |
| GW8 print | `beforeprint` forces full grouped render and zero spacers; `afterprint` restores windowing. |
| GW9 flat path | Existing flat virtualization tests and related grouped/collapse/aggregation/link-chip regressions remain green. |
| GW10 small grouped sets | `<=60` grouped items render fully with no spacer rows. |

## 4. Browser measurements

The design-lock required Playwright-driven before/after numbers against a live Vite dev server at a
production-realistic grouped scale. The same `grouped-windowing` verification harness was run twice:

- **Before**: temporary detached worktree at `origin/main@696b4824f` (the goal-pool refresh before this
  runtime), with only the verification harness copied in and `GW_EXPECT_UNWINDOWED=1`.
- **After**: this runtime branch, using the committed Playwright verification harness.

Scale: `5,000` data rows / `50` groups.

| Build | Mount time | Scroll-frame time | Initial mounted items | After-scroll mounted items | First row before -> after scroll |
| --- | ---: | ---: | ---: | ---: | --- |
| Before `696b4824f` | `575.5ms` | `74.1ms` | `5,050` | `5,050` | `1 -> 1` |
| After runtime branch | `22.3ms` | `11.9ms` | `29` | `38` | `1 -> 2493` |

Interpretation:

- Before: grouped mode mounted every data row plus every group header; scrolling did not change the
  mounted stream because there was no window.
- After: grouped mode mounts only the visible stream plus overscan; scrolling changes the mounted window
  while preserving scroll geometry with spacers.

The committed browser verifier writes the evidence to `apps/web/verification-output/gw-grouped-windowing.json`
and asserts the bounded DOM/spacer/scroll-shift contract. The output directory is gitignored.

## 5. Commands

Local validation in `/private/tmp/mt-gw-runtime`:

```text
pnpm --filter @metasheet/web exec vitest run tests/meta-grid-table-virtualization.spec.ts tests/multitable-grid-perf-baseline.spec.ts --watch=false
=> 23 tests / 2 files pass

pnpm --filter @metasheet/web exec vitest run tests/multitable-grid-controlled-collapse.spec.ts tests/multitable-agg-footer-grid.spec.ts tests/multitable-grid-grouped-link-chip.spec.ts --watch=false
=> 22 tests / 3 files pass

pnpm --filter @metasheet/web type-check
=> vue-tsc -b clean

pnpm --filter @metasheet/web exec playwright test --config playwright.verification.config.ts
=> 2 tests pass (cf-reactions + grouped-windowing)

git diff --check
=> clean
```

Before-browser measurement in `/private/tmp/mt-gw-before-browser`:

```text
GW_EXPECT_UNWINDOWED=1 pnpm --filter @metasheet/web exec playwright test --config playwright.verification.config.ts grouped-windowing.spec.ts
=> 1 test pass; initialItems=5050; mount=575.5ms; scrollFrame=74.1ms
```

## 6. Boundaries

Still out of scope and not touched:

- grouped-mode infinite-scroll accumulation
- server-side grouping or cross-page group coalescing
- in-memory accumulation caps
- grouped expand rows
- backend/API changes
- generic variable-height virtualizer adoption

This runtime closes the grouped DOM-windowing gap only. It unlocks grouped scaling follow-ups; it does
not silently implement them.
