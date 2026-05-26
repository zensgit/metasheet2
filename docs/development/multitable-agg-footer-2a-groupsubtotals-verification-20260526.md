# Multitable Aggregation Footer #4-3b-2a — Group Subtotals (in-memory) Verification (2026-05-26)

Implements the locked design `docs/development/multitable-agg-footer-2b-design-20260526.md` (#1849).
benchmark v2 §9 #4-3b-2a. Backend-first (real-DB + unit green) then frontend. **No SQL-agg, no computed parity** (those stay #4-3b-2b / 2c).

---

## 1. What shipped

**Backend** (multitable-internal kernel-polish):
- `multitable/aggregation-helpers.ts` — new pure `groupRowsByField(rows, groupFieldId)`: partitions rows into ordered buckets (empty/`null` key LAST; others numeric-aware string sort), total-preserving (`Σ buckets === input`). Single group field (matches grid). `key` emit = primitive as-is / JSON string for complex / `null` for empty; map key namespaced so `1` and `"1"` never collide.
- `GET /sheets/:sheetId/view-aggregate` (univer-meta.ts) — extended:
  - group field resolved from **`view.groupInfo.fieldId`** (the grid source of truth; NOT `view.config.groupFieldId`).
  - **computed group field → `422 AGGREGATE_COMPUTED_GROUP_UNSUPPORTED`** (no `applyLookupRollup` here).
  - **group field not in D3c-allowed set → `422 AGGREGATE_GROUP_FIELD_DENIED`** (group keys = the field's distinct values → would leak; hard-fail, no silent grand-total fallback).
  - per-group `aggregates` computed by the SAME `computeAggregates` closure as the grand total → identical fn set + D3c omission (hidden field omitted in every group).
  - response adds `groupFieldId` + `groups:[{key,count,aggregates}]` **only when grouped**; non-grouped requests are byte-identical to #4-3b-1.

**Frontend** (`apps/web/src/multitable/`):
- `client.ts` — `ViewAggregateResult` + new `ViewAggregateGroup` (`groupFieldId?`, `groups?`).
- `MetaGridTable.vue` — per-group subtotal `<tr class="meta-grid__group-subtotal">` rendered after each group's rows (inside the collapse guard), matched to the server group by key (`null` → client `__ungrouped__`). Value rendered **only** from the server `aggregateGroups` prop (`groupAggValueDisplay`) — no local group aggregation. Frozen columns sticky-left like the grand-total `<tfoot>`.
- `MultitableWorkbench.vue` — `aggregateGroups` ref set from `r.groups ?? []` (under the same monotonic `aggregateReqSeq` guard); cleared on empty/error; passed as `:aggregate-groups`.

## 2. Locked constraints honored (design #1849)

| constraint | done |
|---|---|
| group source = `view.groupInfo.fieldId` (not config.groupFieldId) | endpoint reads `view.groupInfo.fieldId` |
| group shape extends #4-3b-1; non-grouped byte-identical | `groups`/`groupFieldId` only when grouped |
| `Σ groups.count === total` (partition) | `groupRowsByField` total-preserving; integration test asserts |
| `key: null` for empty (response contract) → "(empty)" | helper emits `null`; frontend maps to `__ungrouped__`; FE + unit tests |
| group-by denied field → 422 `AGGREGATE_GROUP_FIELD_DENIED` (no silent fallback) | hard-fail; integration test |
| computed group field → 422 `AGGREGATE_COMPUTED_GROUP_UNSUPPORTED` | hard-fail; integration test |
| hidden aggregate field omitted **per group** | shared `computeAggregates`; integration test |
| 413 unchanged (whole-sheet scan-input cap) | untouched |
| frontend renders server response only (no local fallback) | `groupAggValueDisplay` reads prop; FE test asserts server 500/600 win, never local 1/2 |

## 3. Boundary

Backend = `core-backend/src/multitable` + the existing route (multitable-internal kernel-polish; **no** SQL-agg, **no** `applyLookupRollup`/computed parity, **no** integration-core/k3-wise/attendance/rbac-core). Frontend = `apps/web/src/multitable`. No schema/migration change (`group_info` column already exists).

## 4. Verification

- **Backend unit (no DB, runs in default `test` step): `tests/unit/aggregation-helpers.test.ts` 7/7** — `aggregateField` fns + `groupRowsByField` partition / null-key-last / numeric ordering / no `1`-vs-`"1"` collision. (Run locally, green.)
- **Backend real-DB (CI `plugin-tests.yml` step): `multitable-view-aggregate.test.ts` 15/15** — 10 from #4-3b-1 + 5 new: group partition + per-group sums (Σcount===total, grand total still present), per-group hidden-field omission, empty/`null`-key group (count 20), group-denied 422, computed-group 422.
- **Frontend: `multitable-agg-footer-grid.spec.ts` 8/8** — 5 from #4-3b-1 + 3 new: server per-group values win over local rows, server `null`-key → client "(empty)", no subtotal rows when server returned none.
- Backend `tsc` clean; frontend `vue-tsc` clean.
- Pre-existing unrelated local spec flakiness (attendance / approval-center / featureFlags / some multitable-workbench specs) reproduces on clean `origin/main` with this branch stashed → **not introduced here**; CI is the gate.
- **Caveat (header count):** group header count is still page-based (existing behavior); the subtotal *value* is the full filtered-set server value. Reconciling the header count is out of scope (not a subtotal concern).
- **Caveat (complex-type group key, display-only):** the server emits `key = JSON.stringify(val)` for array/object group values (multi-select/link), while the grid's existing `groupedRows` keys by `String(val)` (e.g. `['a','b']` → `"a,b"`). So grouping by a complex-type field renders no subtotal for those buckets — **server data is still correct** (`Σ groups.count === total` holds), the client just can't match the key. Realistic group fields (string/number/single-select) work. Follow-up if needed: client `JSON.stringify` for non-primitive group values, or store both forms in `serverGroupAggByKey`.
- **Caveat (422 refusal UX):** on `AGGREGATE_GROUP_FIELD_DENIED` / `AGGREGATE_COMPUTED_GROUP_UNSUPPORTED` the workbench clears values but `aggregationConfig` stays set, so the `<tfoot>` renders with blank value cells (no number) rather than a "this view can't be aggregated" message. This is the locked hard-fail (no silent grand-total fallback), but the refusal UX is unspecified — follow-up: add a third footer label alongside `aggregateTooLarge`.

## 5. Deferred (unchanged)

- **#4-3b-2b** SQL-side aggregation — evidence-gated (a real sheet hits the raw-count 413).
- **#4-3b-2c** computed-filter/group parity — demand-gated; default keep 422.
- Value-based group ordering, multi-level grouping, collapsible-group server state — not planned.
