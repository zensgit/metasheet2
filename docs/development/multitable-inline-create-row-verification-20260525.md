# Multitable Inline Create Row — Verification (2026-05-25)

Benchmark v2 §9 #4 (Grid BI polish), first sub-slice: a trailing "+ New record" row in the grid
that creates a record directly, instead of only the toolbar / empty-state CTA.

Predecessor: D3 permission matrix complete (#1831). Successor sub-slices of #4 (frozen columns,
agg footer / group rollup) are separate opt-ins.

---

## 1. What shipped

- **`MetaGridTable.vue`**: a trailing `"+ New record"` row (`.meta-grid__add-row`) in **both** the
  grouped and flat `<tbody>` branches. Gated `v-if="canCreate && filteredRows.length && !loading"`,
  emits **`create-record`** on click. New prop `canCreate?: boolean`, new emit `create-record`.
- **`MultitableWorkbench.vue`**: passes `:can-create="caps.canCreateRecord.value"` and wires
  `@create-record="onAddRecord"` — the **existing gated empty-create path** (`grid.createRecord()` →
  `loadViewData` reload). Same handler the toolbar "+ New Record" button uses.
- **`meta-core-labels.ts`**: `grid.addRecordInline` (`New record` / `新建记录`) via the typed
  `MetaCoreLabelKey` module; the `+` is a separate `aria-hidden` glyph span → renders `+ New record`
  (label intentionally has **no** leading `+` to avoid a doubled glyph).
- **CSS**: `.meta-grid__add-row-btn` — full-width, sticky-left (visible during horizontal scroll),
  hover affordance, `+` glyph `aria-hidden`.

## 2. Design (quick-add, confirmed scope)

Reuses the existing create semantics verbatim — clicking the row fires the **same** gated
`onAddRecord` (empty `createRecord()`), and the existing post-create reload surfaces the new blank
row (then the user edits inline / opens the drawer). No editable phantom-row, no new create path.

- **Capability gate:** identical to the toolbar button (`canCreateRecord` → `canCreate` prop). Hidden
  for viewer/commenter.
- **Empty state:** the "+" row shows only when rows exist; the 0-rows empty-state keeps its own
  "+ New Record" CTA (no duplicate affordance).
- **a11y:** real `<button>`, gated, localized label.

## 3. Boundary

- **`apps/web/src/multitable/` only** (multitable kernel-polish, allowed under the K3 lock). No
  backend / api-client / contract / rbac change — reuses `createRecord` as-is.

## 4. Verification

- **Tests** — `apps/web/tests/multitable-grid-inline-create-row.spec.ts` (5 cases) + existing
  `meta-grid-table-i18n.spec.ts` (6, regression): **11 passed**.
  - renders when `canCreate` + rows; zh-CN label localized; hidden when `!canCreate`; hidden when
    0 rows (empty-state owns it); emits `create-record` on click.
- **Type-check** — `pnpm --filter @metasheet/web type-check` (vue-tsc -b): clean.
- **Lint** — my changed lines are clean. Note: the web `lint` script scopes to a PLM/workflow/auth
  allowlist and does **not** cover `src/multitable/**`, so this surface is gated by type-check + tests,
  not eslint. (A targeted `eslint` run surfaced 2 **pre-existing** issues in `MultitableWorkbench.vue`
  — an unused `apiFetch` import + an attribute-linebreak warning, both on lines I did not touch and
  out of CI lint scope; left as-is, not this slice's debt.)

## 5. Deferred (other #4 sub-slices, separate opt-ins)

- Frozen columns (`view.config.frozenLeftColumnIds[]` + CSS sticky stack).
- Aggregation footer / group rollup (BI core).
- Inline-edit on the created blank row (current flow surfaces the row via reload; inline cell-edit
  on a phantom row was explicitly out of scope — quick-add chosen).
