# Multitable Dashboard BI v2 S0 — current-state decision lock

**Date:** 2026-06-04
**Status:** DESIGN-LOCK ONLY — no implementation in this slice.
**Anchored to:** `origin/main @ 2dfa4cb7e` (`#2262`, restricted chart-data UI landed).
**Scope:** decide the first durable Dashboard BI v2 implementation slice from current code, not from older assumptions.

---

## 0. Executive decision

Dashboard BI v2 should **not** start with multi-series, extra chart types, or a richer chart designer.

It should start with **BI-v2-a: persisted dashboard activation**:

1. make the persisted chart REST wire contract coherent for the web client;
2. wire persisted `GET /sheets/:sheetId/charts/:id/data` to a real, permission-safe record source;
3. keep the existing field-read/restricted semantics from F0b and `#2262` intact;
4. add tests proving persisted dashboards can render real data through the production route.

Reason: the current persisted dashboard surface is visually present, but the main data path is not product-complete. Building more visualization features on top of it would hide the real blocker.

---

## 1. Code facts verified on current main

### 1.1 Persisted dashboard/chart API exists and is mounted

`packages/core-backend/src/index.ts` mounts `dashboardRouter()` at `/api/multitable`. The route provides persisted chart/dashboard CRUD plus chart data:

- `GET/POST /sheets/:sheetId/charts`
- `GET/PATCH/DELETE /sheets/:sheetId/charts/:id`
- `GET /sheets/:sheetId/charts/:id/data`
- `GET/POST /sheets/:sheetId/dashboards`
- `GET/PATCH/DELETE /sheets/:sheetId/dashboards/:id`

The F0b authz slice has already landed: reads call `requireSheetRead`; manage routes call `requireSheetManageViews`; chart-data resolves the layer-2 ∧ layer-3 `allowedFieldIds` composite and returns `metadata.restricted=true` when a referenced chart field is not readable (`routes/dashboard.ts:81-155`, `:178-280`, `:286-362`).

### 1.2 Persisted chart-data has no production record provider

`DashboardService.getChartData()` delegates to `recordProvider` only if one was injected:

```ts
let records: Array<{ data: Record<string, unknown> }> = []
if (this.recordProvider) {
  records = await this.recordProvider(chart.sheetId)
}
return this.aggregationService.computeChartData(chart, records)
```

`setRecordProvider()` is used by tests, but there is no production wiring in `src/`. So current persisted chart data aggregates over `[]` unless a test injects a provider (`dashboard-service.ts:24-34`, `:234-244`; tests call `getDashboardService().setRecordProvider(...)`).

This confirms the old F0b design note still matters: the field-value leak was latent; the value channel becomes real only when provider wiring is added. The F0b restricted-mask gate is already in place and must stay in the same implementation PR as provider activation.

### 1.3 There is an older real-data `/dashboard/query` path, but the persisted dashboard UI does not use it

`POST /dashboard/query` in `univer-meta.ts` does load real `meta_records` and has a safety model:

- resolves `canRead`;
- loads fields and `field_permissions`;
- builds `visibleFields`;
- loads rows from `meta_records`;
- optionally hydrates lookup/rollup for referenced computed fields;
- applies view filters;
- applies record permission filtering;
- filters row data to visible fields before widget aggregation.

Anchors: `dashboardWidgetSchema` at `univer-meta.ts:2083-2091`; `loadDashboardSourceRows()` at `:2457-2547`; route handler at `:4801-4898`.

But the persisted frontend dashboard calls `client.getChartData(sheetId, chartId)` for panels (`MetaDashboardView.vue:179-191`, `:205-227`), which hits `GET /sheets/:sheetId/charts/:id/data`, not `/dashboard/query`. A repo search found no web caller for `/dashboard/query`.

Conclusion: BI-v2-a should not fork a third dashboard data path. It should either reuse/extract the safe source-row semantics from `/dashboard/query`, or explicitly document and test any narrower provider semantics.

### 1.4 Backend and frontend persisted chart contracts currently drift

Backend internal chart model (`packages/core-backend/src/multitable/charts.ts`) uses:

- `type`
- `display`
- `dataSource.groupByFieldId`
- `dataSource.aggregation: { function, fieldId? }`
- optional `filterFieldId`, `dateFieldId`, `dateGrouping`, `sortBy`, `limit`

Frontend `apps/web/src/multitable/types.ts` expects:

- `chartType`
- `displayConfig`
- `dataSource.fieldId`
- `dataSource.groupFieldId`
- `dataSource.aggregation: string`

`MultitableApiClient` currently returns parsed JSON directly (`client.ts:1633-1674`), and `MetaDashboardView` reads `chart.chartType` and `chart.displayConfig` (`MetaDashboardView.vue:82-86`, `:102-110`). That means a real backend chart config can be rendered with undefined chart type/display config on the web side.

This is a contract problem, not a visual polish issue. It must be resolved before adding chart builder UI or multi-series.

### 1.5 The renderer is not the blocker

After Slice 1 / `#1950` and `#2262`, `MetaChartRenderer` can render:

- ECharts `bar` / `line` / `pie`;
- HTML `number` / `table`;
- restricted chart-data state via `metadata.restricted=true`.

So the next blocker is not canvas rendering. It is the persisted chart data source and chart-config wire contract.

---

## 2. Decision: BI-v2-a before BI-v2-b/c

### Chosen first implementation slice: BI-v2-a — persisted dashboard activation

BI-v2-a should do exactly this:

1. **Chart config wire bridge.** Add a single normalization boundary so backend persisted chart configs and web `ChartConfig` agree. The implementation can be either:
   - route serializer accepts/returns frontend aliases while preserving backend internals; or
   - web client maps backend wire ⇄ frontend types.

   The implementation PR must pick one and test both inbound and outbound. Do not leave the current silent drift.

2. **Real chart-data provider.** Wire `GET /sheets/:sheetId/charts/:id/data` to real sheet records. The provider must be request-scoped or route-computed; do not rely on a global, viewer-agnostic `recordProvider` for production behavior.

3. **Permission gate preserved.** Keep the F0b sequence: `canRead` → chart lookup → `allowedFieldIds` → restricted withhold if any referenced field is denied → only then compute chart data. A denied referenced field must still return `metadata.restricted=true` and must not call/emit the denied field's value.

4. **Source semantics stated and tested.** If `chart.viewId` is supported, the provider must honor the view's filter semantics using the same allowed-field logic as `/dashboard/query` / `/view`. If `viewId` is not supported in BI-v2-a, the implementation must explicitly document it as deferred and not silently pretend the comment "`use view's filters/sorts`" is true.

5. **Persisted dashboard render proof.** A real dashboard panel must render non-empty chart data through `MetaDashboardView` using the production REST client shape, not a unit fake whose shape differs from backend.

### Rejected as first slice

- **Multi-series first.** Not until single-series persisted charts are wire-correct and data-backed.
- **More chart types first.** Renderer already supports the shipped chart types; adding types before the provider would just render more empty data.
- **Chart builder UI first.** A builder would create configs into a drifting wire contract unless BI-v2-a fixes that boundary first.
- **SQL cursor `/records` parity.** This is unrelated to persisted dashboard charts and was already demand-gated in the typed-query design.

---

## 3. Recommended implementation shape for BI-v2-a

### 3.1 Chart config normalization

Prefer a small, explicit adapter instead of changing every consumer ad hoc.

Recommended:

- backend keeps internal `ChartConfig` as `type` / `display` / nested `aggregation`;
- route or web client exposes a stable web DTO as `chartType` / `displayConfig`;
- outbound `createChart` / `updateChart` maps web DTO back to backend internal input;
- tests pin both directions.

Backward-compatibility note: existing backend tests and service code still use `type` / `display`. If the route switches wire shape entirely, update route tests and document the wire change. A dual-alias response may reduce breakage, but the web client should still consume one canonical shape.

### 3.2 Real chart-data provider

Do **not** wire a raw global provider that blindly returns all `meta_records.data` as the final design.

Preferred approach:

1. Route resolves auth and `allowedFieldIds` exactly as today.
2. Route calls a request-scoped loader for chart rows.
3. Loader reuses or extracts the safe source semantics already present in `/dashboard/query`:
   - optional view filter application if `chart.viewId` is honored;
   - computed lookup/rollup hydration only when referenced by the chart;
   - field filtering by allowed ids before aggregation;
   - record-read handling consistent with the chosen dashboard aggregate semantics.
4. Route passes the resulting records to `ChartAggregationService.computeChartData`.

Minimal acceptable fallback for BI-v2-a if extraction is too large:

- support only sheet-wide chart data, not `viewId`;
- still apply `allowedFieldIds` restricted withhold before compute;
- return only fields needed by the chart;
- document `viewId` as deferred and test that no view-specific behavior is claimed.

### 3.3 Do not weaken restricted behavior

The restricted withhold shape is already consumed by `#2262`:

```json
{
  "chartId": "...",
  "chartType": "...",
  "dataPoints": [],
  "total": 0,
  "metadata": { "restricted": true, "recordCount": 0 }
}
```

BI-v2-a must keep that shape. If chart wire normalization changes `chartType`, restricted responses must stay compatible with `MetaChartRenderer`.

---

## 4. Verification matrix for BI-v2-a

| ID | Scenario | Current main | Required after BI-v2-a |
|---|---|---|---|
| A1 | Backend chart config returned to web | backend shape (`type`/`display`) | web-consumable chart config (`chartType`/`displayConfig`) or client-normalized equivalent |
| A2 | Web create/update chart payload | frontend shape would not match backend internals | outbound adapter maps to backend-accepted shape |
| A3 | Persisted chart data with records | empty/zero because provider unwired | non-empty series computed from real records |
| A4 | Denied referenced field | `metadata.restricted=true` gate already exists | unchanged; canary absent; restricted notice still renders |
| A5 | Allowed referenced field | provider test-injected only | production route returns real value/group labels |
| A6 | Dashboard panel render | unit fake can render | real REST-shaped chart config + chart data render through `MetaDashboardView` |
| A7 | `/dashboard/query` old path | safe and separate | unchanged or explicitly migrated; no regression |
| A8 | `viewId` semantics | chart type comment says optional view use; persisted data path ignores it | either honored with a test, or explicitly deferred with no false claim |

Minimum commands / gates for implementation PR:

- backend real-DB integration test for persisted chart data provider;
- backend unit or integration test for chart config wire normalization;
- frontend client/dashboard tests for normalized config and non-empty panel render;
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit` or repo's current backend type gate;
- `pnpm --filter @metasheet/web exec vue-tsc -b`;
- focused web specs for dashboard/chart renderer;
- plugin-tests runner entry if the real-DB integration is new.

---

## 5. Slicing after BI-v2-a

### BI-v2-b — chart builder UI

Only after BI-v2-a:

- field picker for group/value/filter fields;
- chart type selector for existing `bar` / `line` / `pie` / `number` / `table`;
- aggregation selector;
- display config editor for title, legend, value labels, orientation, prefix/suffix;
- create chart → add panel flow.

### BI-v2-c — richer visual capabilities

Demand-gated after BI-v2-b:

- multi-series;
- stacked/grouped bars;
- additional chart types;
- chart-level drilldown;
- saved dashboard layout improvements.

Multi-series is not a small renderer-only change: it changes `ChartData`, `buildChartOption`, backend aggregation shape, dashboard tests, and restricted-field semantics. It should not be mixed into BI-v2-a.

---

## 6. Frozen boundaries / non-goals

BI-v2-a must not touch:

- central RBAC/auth capability model;
- field-read-gate contracts already closed by the 12/12 arc;
- formula engine or formula-over-lookup;
- SQL cursor `/records` typed-query parity;
- ECharts bundle imports beyond what the renderer already uses;
- multi-series schema.

If a provider implementation needs a broader record-source extraction from `univer-meta.ts`, that extraction should be small and test-driven, not a wholesale route rewrite.

---

## 7. Open implementation decision to settle before code

BI-v2-a has one real fork:

**Provider semantics**

- **A — extracted safe provider (recommended):** reuse/extract `/dashboard/query` source-row semantics so `viewId`, computed fields, record filtering, and field masks stay aligned.
- **B — sheet-wide minimal provider:** return only fields referenced by the chart, with no `viewId` support in this slice; explicitly document `viewId` as deferred.

My recommendation is **A if the extraction stays contained**. If extraction balloons, take **B** as a consciously limited activation slice, but remove any claim that persisted chart `viewId` is honored until a later PR proves it.

Either path must keep the F0b restricted withhold test green and must prove an allowed chart produces real non-empty data through the persisted dashboard route.
