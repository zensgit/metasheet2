# Multitable Frozen Columns — Design (2026-05-25)

benchmark v2 §9 #4 (Grid BI polish), second sub-slice: user-configurable **left-frozen** columns
(sticky during horizontal scroll). Predecessor: inline create row (#1834). Frontend-only.

Model decision (signed off): **left-prefix** — freeze the leftmost contiguous N columns
("Freeze up to this column" / "Unfreeze"), like Feishu/Airtable. Keeps sticky offsets sane and
reorder semantics simple.

---

## 0. Scope + boundary

- **Frontend-only.** `view.config` is freeform `jsonb` (backend zod `config: z.record(z.unknown())`,
  `univer-meta.ts:4979`) → `frozenLeftColumnIds` needs **no backend/contract/migration change**.
- Files: `MetaGridTable.vue` (sticky stack), `MetaFieldHeader.vue` (freeze affordance),
  `useMultitableGrid.ts` (read config), `MultitableWorkbench.vue` (wire + persist). No backend.
- Multitable kernel-polish (allowed under K3 lock); no rbac/contract.

## 1. Persistence

- Stored at `view.config.frozenLeftColumnIds: string[]` — the ordered field ids of the frozen prefix.
- Read: `workbench.activeView.value?.config?.frozenLeftColumnIds` → prop into `MetaGridTable`.
- Write: existing `onPersistActiveViewConfig({ config: { ...currentConfig, frozenLeftColumnIds } })`
  → `client.updateView` (PATCH) → reload. (No new API.)

## 2. Prefix derivation (reorder-robust)

`MetaGridTable` derives, at render, the **frozen count** = length of the longest prefix of
`visibleFields` whose ids are ALL in `frozenLeftColumnIds`:

```
frozenCount = while visibleFields[n].id ∈ frozenSet: n++
isFrozen(i) = i < frozenCount
```

So only a contiguous left prefix is ever sticky. After a column **reorder**, if the frozen set is no
longer a left prefix, the non-prefix ids are simply ignored (graceful; no broken sticky). Persisted
ids are normalized to the prefix on the next freeze action.

## 3. Sticky stack offsets (the core)

**Existing quirk to fix:** `.meta-grid__check-col` (36px) and `.meta-grid__row-num` (56px) are BOTH
`position: sticky; left: 0` → they overlap when multi-select is on. Frozen columns require an
**offset-driven** stack. When `frozenCount > 0`, set inline `left` on the whole prefix:

| element | inline `left` (only when `frozenCount>0`) | width |
|---|---|---|
| check-col (if multiSelect) | `0` | 36 |
| row-num | `multiSelect ? 36 : 0` | 56 |
| frozen data col `i` (`i<frozenCount`) | `base + Σ_{j<i} width(j)` | width(i) |

`base = (multiSelect ? 36 : 0) + 56`. `width(id) = columnWidths[id] ?? FROZEN_DEFAULT_WIDTH` (160).
**Reactive to `columnWidths`** → resizing a frozen column recomputes downstream offsets automatically.

- When `frozenCount === 0`: **no inline left** → existing CSS unchanged (no behavior change; the
  pre-existing overlap stays as-is, out of this slice's scope to "fix" globally).
- The base-fix (inline left on check-col/row-num) applies **only in frozen mode** — documented as an
  incidental correctness improvement, not a separate refactor.

**z-index layers:** normal cells (0) < frozen body cells (2) < sticky header row (3) < frozen header
cells (4). Frozen cells get an opaque `background` (so scrolled content doesn't show through).

**Width-determinism:** a frozen column with no explicit `columnWidths` entry is rendered at
`FROZEN_DEFAULT_WIDTH` (also pinned as its `min/maxWidth`) so the offset math is exact.

## 4. Grouped vs flat tbody

Both `<tbody>` branches render data cells via `v-for (field, ci) in visibleFields` → apply the frozen
style by index in both. The **group-header row** is a single `colspan` cell — NOT frozen (it spans the
full width; freezing it is meaningless). Only data cells + headers stick.

## 5. Freeze UI (minimal, greenfield)

`MetaFieldHeader` has no menu today. MVP affordance: a small **pin toggle** in each header cell:

- click on column `i` (not currently the boundary) → freeze up to `i`: emit `set-frozen` with
  `visibleFields[0..i].map(id)`.
- click when `i` is the current boundary → unfreeze: emit `set-frozen` with `[]`.
- visual: pin icon filled when the column is within the frozen prefix.

`MetaGridTable` re-emits to the workbench → `onPersistActiveViewConfig`. (A richer dropdown menu —
"freeze 1/2/3 columns", per-column context menu — is a later polish; MVP is the pin toggle.)

## 6. Edge cases

- **Frozen wider than viewport:** allowed (user's choice); horizontal scroll still works, frozen prefix
  just occupies most width. No cap in MVP (note for later).
- **Reorder:** §2 graceful derivation.
- **Resize:** §3 reactive offsets.
- **All columns frozen / 0 columns:** frozenCount clamps to visibleFields.length / 0; harmless.
- **hiddenFieldIds interaction:** `visibleFields` is already post-hidden; prefix derived over visible set.

## 7. Verification plan

- **Component test** (`MetaGridTable`): asserts `isFrozen` prefix derivation + computed `left` offset
  values (the offset math) for a few width configs + multiselect on/off; asserts non-prefix-after-
  reorder is not sticky. Asserts `MetaFieldHeader` pin emits `set-frozen` with the right prefix.
- **Caveat:** actual CSS `position: sticky` rendering is browser-native and NOT unit-testable headless;
  the test covers the **offset math + gating + emit**, which is the logic. Visual confirmation is manual.
- vue-tsc clean; `src/multitable/**` not in eslint allowlist (gated by type-check + tests).

## 8. Slicing

Single slice (rendering + minimal pin UI + persistence) — all three needed for a usable feature.
Richer freeze menu + right-edge freeze = deferred polish.
