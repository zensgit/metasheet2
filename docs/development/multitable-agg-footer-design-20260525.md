# Multitable Aggregation Footer — Design (2026-05-25)

benchmark v2 §9 #4 (Grid BI polish), sub-slice 3. A grid **footer row** showing per-column
aggregates (sum/avg/min/max/count) over the **full server-filtered result**. Predecessors: inline
create row (#1834), frozen columns (#1837).

**Path decision (signed off): B — server aggregation endpoint.** The scout established there is NO
reusable generic aggregation endpoint and the client holds only the current page (50), so numeric
aggregates over the filtered set REQUIRE a backend endpoint. This is a **backend slice**
(`core-backend/src/multitable` + a route) — multitable-internal **kernel-polish** (allowed under the
K3 stage-1 lock; not integration-core/k3-wise/attendance), but a deliberate backend feature.

---

## 0. Scope

- **In:** a server aggregation endpoint over the filtered set + a grid footer (grand-total row) +
  per-field aggregation config in `view.config`.
- **Out (deferred):** group subtotals (`group.count` is page-only today → needs per-group server
  aggregation; #4-3b-2 follow-up); SQL-side aggregation optimization (see §2); right-edge/sticky-footer
  polish.
- **Boundary:** multitable-internal only. No integration-core / k3-wise / attendance / rbac-core. The
  endpoint MUST respect field visibility/permissions (§5) — a sum over a hidden field would leak.

## 1. Endpoint contract

`GET /api/multitable/sheets/:sheetId/view-aggregate` (sibling of `GET /view`):

- **Query:** `viewId?`, `search?`, and the same filter/sort inputs `GET /view` accepts (reuse its
  resolution). NO `limit`/`offset` — aggregation is over the full filtered set.
- **Aggregations requested:** from `view.config.aggregations` (server reads the view) OR an explicit
  query param; MVP reads the view's config so the footer is consistent with what's persisted.
- **Response:**
  ```jsonc
  { "ok": true, "data": {
      "total": 1234,                       // filtered row count (free; COUNT(*) OVER())
      "aggregates": { "fld_amount": { "fn": "sum", "value": 98765.4 },
                      "fld_score":  { "fn": "avg", "value": 7.2 } } } }
  ```
- Only fields the requester may see appear in `aggregates` (§5). Unknown/non-applicable fn → omitted.

## 2. Aggregation engine + perf boundary (decision #4)

`GET /view` resolves the filtered set in 3 paths (univer-meta.ts ~5830-5984): A simple-search (SQL
predicate), B complex filter/sort (loads all rows, filters **in-memory**), C unfiltered (SQL).

- **MVP: reuse `GET /view`'s filter resolution to get the filtered records, then aggregate in-memory
  via `ChartAggregationService`** (`multitable/chart-aggregation-service.ts` already has
  sum/avg/min/max/count/count_distinct). One code path, reuses existing logic + the existing service.
- **Perf parity, not regression:** for complex filters this loads all matching rows — but `GET /view`
  Path B **already does exactly that**, so the aggregate endpoint is no worse than the existing
  filtered-view. Documented; not introducing a new unbounded scan beyond what Path B has.
- **Deferred optimization:** SQL-side aggregation (`SUM((data->>'fld')::numeric) WHERE <predicate>`)
  for the SQL-predicate paths (A/C) — faster on large tables, but more code + jsonb-numeric-cast edge
  cases. Not MVP; flagged as a follow-up if perf demands.

## 3. Aggregation types (decision #2)

- **Numeric fields** (`number`, `currency`, `percent`, `rating`, `autoNumber`): `sum` (default) / `avg`
  / `min` / `max` / `count` / `countNonEmpty`. Add an `isNumericFieldType(type)` helper (none exists).
- **Non-numeric fields:** `count` / `countNonEmpty` / `countDistinct` only (no sum/avg). **Decision:**
  include count/countNonEmpty for non-numeric in MVP (low-risk, useful); `countDistinct` optional.
- Numeric values live in jsonb; `toNumber` coercion (the service already has it) — non-numeric cell
  values are skipped by sum/avg (not zero-filled).

## 4. UI (footer grand-total row)

- A `<tfoot>` grand-total row in `MetaGridTable` (greenfield — no footer today), one cell per visible
  field showing its configured aggregate (or blank if none), aligned to column widths. Sticky-bottom
  optional (MVP: normal tfoot).
- Per-field aggregation picker: a small menu on the footer cell (or reuse the header pin-menu pattern)
  to choose the fn → emits → persists to `view.config.aggregations`. MVP could ship the footer
  rendering + a minimal fn picker; richer picker is polish.
- Footer reads the **server aggregate response**, NOT the visible/loaded rows — so virtual rendering /
  pagination never affect it (decision #1).

## 5. Filter / hidden / permission parity (decisions #1, #5) — security-relevant

- **Filtered set, not page/visible-window** (decision #1): the endpoint aggregates the same filtered
  set `GET /view` would return unpaginated.
- **Hidden / permission (reuse D3 learnings):** the endpoint MUST exclude fields hidden via
  `view.hiddenFieldIds` AND `field_permissions.visible=false` (reuse `filterVisiblePropertyFields` +
  `loadFieldPermissionScopeMap`). **Aggregating a field the user can't see leaks its data** (e.g. a
  salary `sum`) — same class as the D3 export leak. This is a hard requirement + a test.

## 6. Persistence

`view.config.aggregations: { [fieldId]: 'sum'|'avg'|'min'|'max'|'count'|'countNonEmpty'|'countDistinct' }`
— freeform jsonb (no backend schema change, confirmed). Read via a narrow helper (like
`parseFrozenIds`): only a record of fieldId→known-fn passes; dirty config → `{}`. Persisted via the
existing `updateView` PATCH / `onPersistActiveViewConfig`.

## 7. Slicing

- **#4-3b-1 (this design → impl):** endpoint + grand-total footer + config + fn picker (MVP).
- **#4-3b-2 (follow-up):** group subtotals (per-group server aggregation) + SQL-side optimization.

## 8. Tests

- **Backend (real-DB, dedicated step like D3d):** aggregate equals the full filtered set (NOT a single
  page) — seed >pageSize rows, filter, assert sum/avg/count match the filtered total; **hidden /
  permission-denied field is absent from `aggregates`** (security); numeric cast skips non-numeric;
  empty filtered set → zero/empty.
- **Frontend:** footer renders configured aggregates from the server response; config persist;
  pagination/virtual-render does not change the footer; fn picker emits + persists.
- **Caveat:** same headless note — logic/contract tested; visual footer layout manual.

## 9. K3 boundary recap

Multitable-internal aggregation endpoint = kernel-polish (allowed). Touches `core-backend/src/multitable`
+ a route + a frontend footer. **No** integration-core/k3-wise/attendance/rbac-core. Field-permission
parity (§5) is mandatory, reusing the D3 permission helpers.
