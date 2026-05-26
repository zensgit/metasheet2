# Multitable Frozen Columns — Verification (2026-05-25)

Implements the design (`docs/development/multitable-frozen-columns-design-20260525.md`).
benchmark v2 §9 #4 sub-slice 2. Frontend-only.

---

## 1. What shipped

- **`utils/frozen-columns.ts`** — `parseFrozenIds` (narrow: only `string[]` passes, dirty config → `[]`)
  + `frozenPrefixCount` (reorder-robust longest-left-prefix).
- **`MetaGridTable.vue`** — `frozenLeftColumnIds` prop; `frozenCount`/`frozenLeft(i)`/`isFrozen(i)`
  computeds; offset-driven sticky on frozen header (via `MetaFieldHeader`) + body cells; **global
  base-fix** (row-num inline `left = multiSelect?36:0`, fixing the row-num/check-col `left:0` overlap);
  `FROZEN_DEFAULT_WIDTH=160`; `set-frozen` emit + `onToggleFreeze`.
- **`MetaFieldHeader.vue`** — pin toggle (`@click.stop @mousedown.stop`, localized aria/title); `frozen`
  + `frozenLeft` props; inline `position:sticky` (overrides the broken CSS `relative`, keeps the
  absolute resize handle); `toggle-freeze` emit.
- **`MultitableWorkbench.vue`** — `activeFrozenLeftColumnIds = parseFrozenIds(activeView.config)` prop;
  `@set-frozen → onSetFrozen` merges `frozenLeftColumnIds` into `view.config` via the existing persist.
- **`meta-core-labels.ts`** — `grid.freezeUpToColumn` / `grid.unfreezeColumns` (en/zh).

## 2. Design adherence

| design point | done |
|---|---|
| left-prefix model | ✅ `frozenPrefixCount` (contiguous left prefix; reorder-robust) |
| frontend-only (freeform `view.config`) | ✅ no backend/contract/migration |
| offset-driven stack (check 0 → row-num 36 → frozen base+Σ) | ✅ `frozenLeft(i)` reactive to `columnWidths` |
| global base-fix (not frozen-mode-only) | ✅ row-num inline left always |
| header positioning fix + keep resize handle | ✅ inline `position:sticky` on frozen th |
| `parseFrozenIds` narrow + invalid fallback | ✅ + unit tests |
| pin `@click.stop`/`@mousedown.stop` + aria | ✅ + no-bubble test |
| width-determinism (`FROZEN_DEFAULT_WIDTH`) | ✅ tested |
| minimal pin UI (no dropdown) | ✅ |

## 3. Boundary

`apps/web/src/multitable/` only — **no backend / api-client / contract / rbac**. `view.config` is
freeform `jsonb`; `frozenLeftColumnIds` rides existing `updateView` PATCH.

## 4. Verification

- **27 tests passed** across 4 files:
  - `multitable-frozen-columns-util.spec.ts` — `parseFrozenIds` (valid / missing / non-array /
    non-string element / null / empty) + `frozenPrefixCount` (prefix / reorder-ignored / clamp).
  - `multitable-frozen-columns-grid.spec.ts` — cumulative sticky `left` offsets (no-multiselect base 56;
    multiselect base 92 + row-num fix 36; `FROZEN_DEFAULT_WIDTH` 216; empty = not sticky); pin emits
    left prefix; boundary pin unfreezes `[]`; pin does NOT bubble into sort.
  - regressions: `meta-grid-table-i18n.spec.ts`, `multitable-grid-inline-create-row.spec.ts` — green.
- **vue-tsc**: clean.
- **Caveat (design §7):** actual CSS `position: sticky` rendering is browser-native and NOT
  unit-testable headless; the tests cover the **offset math + gating + emit + parse + no-bubble** (the
  logic). Visual sticky behavior is manual.

## 5. Known MVP limitations / deferred

- Frozen cells use an **opaque bg** (occlude scrolled content) that **preserves conditional-formatting
  `backgroundColor`** (falls back to `#fff` only when no formatting) — verified by spec. They still
  don't show row **hover/selection** tint on the frozen prefix (common grid behavior; documented).
- No cap if the frozen prefix exceeds viewport width (allowed; user's choice).
- Deferred polish (separate opt-ins): richer freeze dropdown menu, right-edge freeze, frozen-cell
  row-state tint. Next #4 sub-slice: aggregation footer / group rollup.
