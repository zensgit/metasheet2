# Multitable Dashboard BI — v2-d multi-series (stacked bar) design-lock

**Status:** design-lock (docs-only). Implementation is a *separate* opt-in, not started.
**Date:** 2026-06-04
**Predecessors:** v2-a create editor (#2276) · v2-b1 edit/delete (#2279) · v2-b1.1 date-grouped preserve (#2281) · v2-b2 live preview (#2286) · v2-c donut/area variants (#2290).
**Ground-truth base:** `origin/main` @ `9726d6561`.

> ⚠️ Recon note: the canonical working tree was a **stale detached HEAD 433 commits behind** origin/main (pre-#1950, pre-ECharts). All file/line references below were read against `origin/main` via a fresh worktree, **not** the canonical checkout. Anyone implementing this must do the same.

---

## 0. Why v2-d is different from v2-a..v2-c

v2-a through v2-c were **frontend-only** (they rode the existing `display` jsonb passthrough or pure `buildChartOption` render). **v2-d is the first slice that crosses the backend**: it adds a real grouping dimension that the *producer* (`ChartAggregationService.computeChartData`) must compute and that the *field-read-gate* must cover. That raises the bar — backend-first ordering and real-DB tests are mandatory (mirrors the agg-footer 口径).

The v2-c ledger already flagged this: "v2-d multi-series (ChartData→series[] contract change + stacked)".

---

## 1. Recon — the as-built single-series path (what we extend)

**Producer** — `packages/core-backend/src/multitable/chart-aggregation-service.ts:84` `computeChartData(chart, records)`:
- One grouping dimension: `dateFieldId+dateGrouping` → `else groupByFieldId` → `else "All"` (`:108-115`).
- Emits flat `dataPoints: [{label, value}]` (`:118-123`), then **sort** (`:126`) then **limit** (`:129-131`), then `total = Σ dataPoints` (`:133`).
- `ChartData` (`:17`): `{ chartId, chartType, dataPoints: ChartDataPoint[], total?, metadata? }`. `ChartDataPoint` (`:11`): `{ label, value, color? }`.

**Render** — `apps/web/src/multitable/components/MetaChartRenderer.vue` (ECharts at real main, NOT the SVG version in the stale tree): `echarts.init` (`:121`) → `chart.setOption(buildChartOption(chartData, displayConfig), true)` (`:123-124`). `buildChartOption` (`apps/web/src/multitable/utils/buildChartOption.ts:32`) maps bar/line/pie → ECharts series; number/table → `null` (HTML). number/table + pie-legend stay HTML (`v-for dataPoints`). Today every chart emits **exactly one** ECharts series.

**Field-read-gate (security spine)** — `packages/core-backend/src/routes/dashboard.ts`:
- `chartReferencedFieldIds(chart)` (`:148-157`) = `[aggregation.fieldId, groupByFieldId, dateFieldId, filterFieldId]`.
- `isChartDataRestricted` (`:159-161`) = any referenced field ∉ `allowedFieldIds` → restricted.
- `restrictedChartData` (`:163-174`) = `{ dataPoints:[], total:0, metadata.restricted:true }` (no compute, no leak).
- **Both** the live `GET …/charts/:id/data` (`:346-353`) and the `POST …/charts/preview-data` (`:269-276`) call this same helper — so a single edit gates both paths.

**Validation** — `buildPreviewChart` (`:180-214`) enforces "groupByFieldId or date grouping required" + "value field required for sum/avg/min/max". (Persisted create/update trusts the body; the **read/preview gate** is the real enforcement.)

**Wire** — Express `res.json(data)` is duck-typed (no field-by-field pick), so an **optional** new field passes through untouched. But `ChartData` is **hand-synced** across backend (`chart-aggregation-service.ts:17`) and frontend (`apps/web/src/multitable/types.ts:972`) — both must change in the same PR.

---

## 2. The three locked decisions

### Decision 1 — Data model: **additive `series?`, keep `dataPoints` unchanged** ✅ LOCKED

```ts
// NEW
export interface ChartSeries {
  name: string        // a distinct seriesByFieldId value (the stack segment / legend entry)
  data: number[]      // dense, aligned POSITIONALLY to dataPoints[] (same order, same length)
}

// ChartData gains ONE optional field (backend chart-aggregation-service.ts + frontend types.ts, same PR):
series?: ChartSeries[]
```

**Invariant (lock this):** `dataPoints` is **unchanged** — it remains the existing single-dimension (`groupByFieldId`) aggregation, sorted + limited exactly as today. `seriesByFieldId` triggers an **additional pass** that builds `series` and **changes nothing about `dataPoints` or `total`**.
- `series[i].data[j]` = aggregation over records where `groupBy == dataPoints[j].label` **and** `seriesBy == series[i].name`.
- `series[i].data` is **dense**: length === `dataPoints.length`, `0` where that (category × series) cell has no rows (a gap would break a stack; `0` is correct for additive aggs).
- `series` is built **after** `dataPoints` is sorted **and** limited, so series only ever covers the categories that survived `limit` and in their final order. (Building before limit would leak limited-out categories.)
- `total` stays `Σ dataPoints` — the **existing displayed/limited** total semantics (the producer computes `total` *after* sort+limit at `chart-aggregation-service.ts:133`, so when `limit` is set it is the sum of the *shown* categories, not a full-population grand total). v2-d does **not** change this; `series` does not alter it.

**Why not `dataPoints[X].value = Σ series`** (the rejected option): that is arithmetically correct only for additive aggregations. For `avg`: category X with series A=[10,20], B=[30] → true category avg = 20, but `avg(A)+avg(B) = 15+30 = 45`. So `dataPoints` must come from the unchanged single-dimension path, not from summing series. (For sum/count it *does* coincide — see Decision below — which is exactly why those are the safe stacking aggregations.)

**Why `{name, data:number[]}` not `{name, dataPoints:[]}`:** ECharts stacked bars take `xAxis.data = categories` + one `series.data` number-array per stack, aligned by index. Mirroring that removes any render-time label-alignment/union step. The positional-alignment-to-`dataPoints` invariant is the contract.

### Decision 2 — UI minimal slice: **v2-d-a = stacked bar ONLY** ✅ LOCKED
- `bar` + multiple series → **stacked** (each ECharts series gets `stack: 'total'`).
- No `line` multi-series (overlaid lines), no grouped/side-by-side bar, no new chart types in v2-d-a.
- Single-series charts (no `series` present) render **byte-identically** to today.
- Deferred to **v2-d-b**: grouped (side-by-side) bar — needs a `displayConfig` bar-mode flag (`stacked` | `grouped`); multi-series **line**; **date-axis × series** (stacked-over-time).

### Decision 3 — Grouping model: **groupByFieldId (primary axis) + seriesByFieldId (stack split) + single aggregation** ✅ LOCKED
- `ChartDataSource += seriesByFieldId?: string` (backend `charts.ts` + frontend `types.ts`).
- Reuses the existing `groupRecords` primitive on a second field — symmetric, minimal.
- **Not** multi-value-field series (e.g. two series = `sum(A)`, `sum(B)`): that would make `aggregation` an array — a larger contract change, conflicting with the single-`aggregation` shape. Deferred.
- v2-d-a primary axis = **`groupByFieldId` only** (date primary + series deferred to v2-d-b). `seriesByFieldId` **requires** `groupByFieldId` (you can't stack without a primary axis), is honored **only for `bar`**, and **only with an additive aggregation (`sum`/`count`) — see §4** (inert / rejected otherwise).

---

## 3. 🔴 Security — the one non-obvious must-lock

**`chartReferencedFieldIds` (dashboard.ts:148) MUST include `seriesByFieldId`.** Otherwise a chart whose `seriesByFieldId` points at a **permission-denied** field still computes, and the field's distinct values **leak as series names / legend entries**. Because that one helper feeds both the live-data and preview routes, the single edit closes both.

```ts
const ids = [
  source.aggregation.fieldId,
  source.groupByFieldId,
  source.seriesByFieldId,   // ← v2-d
  source.dateFieldId,
  source.filterFieldId,
]
```

Proof obligation: a **real-DB** test (not a fixture) where `seriesByFieldId` is denied via seeded `field_permissions` → `restricted: true`, empty `dataPoints`, **no `series`**, no series names in the body. Mock/unit can't prove the permission face — this is the empty-field-permission-map false-green trap from prior gate work; seed real rows.

---

## 4. ✅ Decision (owner-confirmed 2026-06-04) — stacking restricted to additive aggregations (sum + count)

**Firm:** v2-d-a permits `seriesByFieldId` **only when `aggregation.function ∈ {'sum','count'}`.**

Rationale (chart *semantics*, not a technical limit): a stacked bar's total height inherently expresses *"the total once the segments are added up."* Only `sum`/`count` have a stack height that equals that whole-bar meaning — and equals the equivalent single-series bar (the *Σ series.data[j] == dataPoints[j].value* consistency property). `avg`/`min`/`max`/`count_distinct` segments are each individually computable, but stacking them produces a **misleading** height; `avg` (avg-of-avgs: 15+30=45 vs. a true category avg of 20) and `count_distinct` (a value distinct in two series double-counts) express an outright *wrong* quantity.

**Enforcement is server-side — frontend gating is necessary but NOT sufficient:**
- **Producer (the uniform safety net):** `computeChartData` emits `series` **only** for `type==='bar'` + `seriesByFieldId` set + additive aggregation. For any other combination it ignores `seriesByFieldId` and returns the single-series `dataPoints` unchanged. Because **both** the live-data and preview routes go through `computeChartData`, this alone stops a hand-crafted/persisted non-additive chart from ever producing a misleading stack.
- **Input validation (clear error at the boundary):** `buildPreviewChart` (preview route) **and** the persisted create/update path reject `seriesByFieldId` paired with a non-additive aggregation (or a non-`bar` type / missing `groupByFieldId`) — a clear 400, not a silent drop. (Today only the preview route validates dataSource; v2-d adds the same check to the persisted path so the UI is never the sole guard.)
- **UI:** the series picker is shown/enabled only when `chartType==='bar'` **and** `aggregation.function ∈ {'sum','count'}`; switching to a non-additive aggregation or a non-bar type clears `seriesByFieldId`.

Future non-additive support, if ever wanted, uses **grouped side-by-side bar** (per-segment height is the honest encoding) — **never** stacked — in a later slice (§7).

---

## 5. Render contract (buildChartOption, frontend-only at render time)

When `chartData.series?.length` and `chartType === 'bar'`:
- `xAxis.data` = `dataPoints.map(p => p.label)` (categories, already sorted+limited by the producer).
- emit `series.length` ECharts bar series; `series[i]` = `{ type:'bar', name, stack:'total', data: chartData.series[i].data }`.
- legend: stacked needs a real legend to read segments → emit the HTML legend over `series[].name` (extend the existing pie-legend pattern, gated by `displayConfig.showLegend`). (ECharts `legend` stays off — chrome stays HTML, per the Slice-1 contract.)
- `displayConfig.orientation: 'horizontal'` still honored (swap axes, `stack:'total'` unchanged).

When `series` is absent → today's single-series path, untouched. `series` present on a non-`bar` type → ignored (render falls back to `dataPoints`); the form prevents authoring it.

---

## 6. Impl plan (separate opt-in; backend-first; NOT started)

Single cohesive v2-d-a slice, but **backend lands and goes real-DB-green before any frontend**:

1. ⬜ **Types (both, same PR):** `ChartDataSource += seriesByFieldId?` (backend `charts.ts` + frontend `types.ts`); `ChartData += series?: ChartSeries[]` + `ChartSeries` (backend `chart-aggregation-service.ts` + frontend `types.ts`).
2. ⬜ **Producer (additive-only safety net, §4):** in `computeChartData`, after sort+limit, emit dense `series` aligned to `dataPoints` **only** when `type==='bar'` + `seriesByFieldId` set + `aggregation.function ∈ {'sum','count'}`; otherwise ignore `seriesByFieldId` (single-series unchanged). `dataPoints`/`total`/`metadata` unchanged. This is the uniform guard both routes inherit.
3. ⬜ **🔴 Gate:** add `seriesByFieldId` to `chartReferencedFieldIds` (one line).
4. ⬜ **Validation (server-side, both routes — not UI-only, §4):** `buildPreviewChart` **and** the persisted create/update path reject `seriesByFieldId` paired with a non-additive aggregation / non-`bar` type / missing `groupByFieldId` (clear 400).
5. ⬜ **Backend tests (real-DB, in plugin-tests.yml):** two-series stacked produces dense aligned series; `Σ series.data[j] == dataPoints[j].value` for sum+count (consistency); **denied seriesByFieldId → restricted, no leak** (§3, seed real `field_permissions`); preview === getChartData parity for an equivalent persisted chart; `seriesByFieldId` absent ⇒ byte-identical to today.
6. ⬜ **Render:** `buildChartOption` bar branch stacked (§5) + HTML legend over series names.
7. ⬜ **Form:** `MetaDashboardView` — series-field `<select>` shown only for `bar` + additive aggregation; cleared on chartType/aggregation change away from the allowed set; carried in `buildChartInput.dataSource.seriesByFieldId` so **create/edit/preview = one config** (the v2-b1 overlay + v2-c carry discipline).
8. ⬜ **Frontend tests:** buildChartOption unit (stacked: N series each `stack:'total'`, xAxis from dataPoints, dense data; no-series regression; inert on non-bar) + dashboard form spec (picker visibility gated on bar+additive; create/edit/preview carry `seriesByFieldId`; cleared-on-switch) + the pre-existing-failure verify-by-revert caveat.

**Frozen / out of scope:** `src/formula/engine.ts`; central RBAC/auth; integration-core; storage/migrations (series is computed, never persisted — only `seriesByFieldId` persists in the existing `data_source` jsonb). No OpenAPI change (chart data endpoints are un-modeled today; same posture as v2-b2).

---

## 7. Deferred (each a later, separately-gated opt-in)
- **v2-d-b:** grouped (side-by-side) bar (`displayConfig` bar-mode flag) · multi-series **line** · **date-axis × series** (stacked-over-time).
- Multi-value-field series (`aggregation` becomes an array).
- avg/min/max/count_distinct stacking (only if a grouped-render mode makes per-segment height honest).
