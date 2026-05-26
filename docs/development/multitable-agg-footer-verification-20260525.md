# Multitable Aggregation Footer (#4-3b-1) — Verification (2026-05-25)

Implements the design (`docs/development/multitable-agg-footer-design-20260525.md`, #1840).
benchmark v2 §9 #4 sub-slice 3b-1. Backend-first (confirmed in CI) then frontend footer.

---

## 1. What shipped

**Backend** (multitable-internal kernel-polish):
- `multitable/aggregation-helpers.ts` — `aggregateField` (locked fns sum/avg/min/max/count/countNonEmpty/countDistinct; `toNumber` replicated; `isEmptyCell` = null/undefined/''/[]), `parseAggregations` (narrow), `isNumericFieldType`, `fnApplies`.
- `GET /sheets/:sheetId/view-aggregate` (univer-meta.ts) — aggregates the **full (unpaginated) persisted-view-filtered** set; view-config-driven; D3c permission composite for allowed fields; max-rows COUNT-first **413** hard-fail.

**Frontend** (`apps/web/src/multitable/`):
- `client.aggregateView` (+ `ViewAggregateResult`); 413 surfaces as a catchable `AGGREGATE_TOO_LARGE`.
- `MetaGridTable` `<tfoot>` grand-total row (per-visible-field value + minimal fn `<select>` picker, type-aware options) + `set-aggregation` emit. **Value rendered ONLY from the server response.**
- `MultitableWorkbench` — `aggregateValues`/`aggregateTooLarge` refs, `loadAggregates` (server only), watcher on (view/sheet/config/search) → reload, `onSetAggregation` persists `view.config.aggregations`.
- `meta-core` label `grid.aggregateTooLarge`.

## 2. Locked constraints honored

| constraint | done |
|---|---|
| #1 source = full server-filtered set (not page/visible) | endpoint unpaginated; footer reads server response only |
| **no local fallback** (your hard rule) | `loadAggregates` catch → clears values (never computes from rows); footer test asserts server 999 wins over local-sum 3 |
| view-config-driven, no ad-hoc param | endpoint reads `view.config.aggregations` only |
| max-rows HARD-FAIL not truncate | 413 + `total`; frontend shows "too large" state, no number |
| **security: D3c export composite** | `filterVisiblePropertyFields` + `loadFieldPermissionScopeMap` + `deriveFieldPermissions` + `view.hiddenFieldIds`; hidden field's aggregate OMITTED (CI security test) |
| fn locked + countNonEmpty semantics | helper owns the set; empty = null/undefined/''/[] |

## 3. Boundary

Backend = `core-backend/src/multitable` + a route (multitable-internal kernel-polish; **no** integration-core/k3-wise/attendance/rbac-core). Frontend = `apps/web/src/multitable`. `view.config` freeform jsonb (no schema/migration change).

## 4. Verification

- **Backend real-DB (CI, dedicated `plugin-tests.yml` step): `multitable-view-aggregate.test.ts` 10/10** — full-set sum (60 rows > page), `/view` filter-resolution parity, persisted filter, **SECURITY hidden-field-omitted**, fn-not-applicable, **413 max-rows**, **uppercase-search normalization parity**, **filter-on-view-hidden-field parity (counts rows like /view, not the D3c set)**, **computed (formula) filter 422 hard-fail**. Backend `tsc` clean.
- **Frontend: 25 tests** (agg-footer 5 incl no-local-fallback + i18n/frozen/inline-create regressions). vue-tsc clean.
- **Caveat:** offset/footer LAYOUT (sticky-bottom) is browser-native — not headless-unit-testable; the value-source / no-fallback / picker / too-large logic IS tested.

## 4b. Review fixes (PR #1841 self-review, 4 findings)

| finding | fix |
|---|---|
| **High** — filter/search resolved over the D3c-allowed set, diverging from `/view` | filter/search now use `visibleFields` (static-visible, mirrors `/view`); **only the aggregate OUTPUT** uses the D3c-allowed set. A filter on a view-hidden field still counts rows (parity) but that field's aggregate is omitted (no leak). |
| **Medium** — search used raw `.trim()` (case-sensitive) | now `normalizeSearchTerm()` (trim+lowercase), identical to `/view`. |
| **Medium** — computed filter conditions silently evaluated against raw `data` → wrong totals | computed (lookup/rollup/formula) filter conditions now **HARD-FAIL 422 `AGGREGATE_COMPUTED_FILTER_UNSUPPORTED`** — `/view` materializes these via `applyLookupRollup`; this endpoint does not, so a clear deferred error beats a silent wrong total. |
| **Low** — `loadAggregates` had no request sequencing | monotonic `aggregateReqSeq`: a stale response is dropped if a newer request was issued. |

## 5. Deferred (#4-3b-2)

- **Group subtotals** (`group.count` is page-only → needs per-group server aggregation).
- **SQL-side aggregation** (avoid the in-memory full-set scan for large sheets; MVP is an intentional scan bounded by the 413 cap).
- **Computed (lookup/rollup/formula) filter parity** — currently 422 (clear deferred error, never silent-wrong). Parity requires running `applyLookupRollup` materialization in this endpoint too.
