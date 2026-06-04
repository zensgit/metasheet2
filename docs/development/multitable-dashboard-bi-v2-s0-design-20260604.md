# Multitable Dashboard BI v2 — S0 (recon + first-slice lock) — Design-Lock — 2026-06-04

> Status: **DESIGN-LOCK (docs-only). No code in this PR.** S0 = current-code recon + lock the first deliverable slice. Owner decisions locked 2026-06-04 (§3, §7). Implementation (v2-a) is a separate cut.
> Author: Claude (Opus 4.8, 1M context) + read-only recon on `origin/main` @ `2dfa4cb7e` (restricted-chart UX #2262 present).
> Scope discipline: narrow. Confirm the data path, the permission boundary, and lock **one** user-visible slice. No "big BI".

## 0. TL;DR — the three questions, answered

1. **Is dashboard chart-data wired to real records, or is there test-provider/empty-data legacy?**
   **Real data IS wired** for the path the shipped UI uses (the *persisted* charts path). No test-provider/empty stub in production.
2. **If not wired → build a real provider.** N/A — it's wired.
3. **If wired → smallest of {multi-series / config UI / richer chart types}.** The recon shows the real gap is **there is no chart-authoring/config UI at all**: the backend `ChartConfig` model + the client `createChart`/`updateChart`/`deleteChart` exist but are **never called from the frontend**. A new chart type or multi-series would be invisible with no editor to select it. **So the keystone first slice is a minimal chart-config (authoring) UI.**

**Locked first slice (BI v2-a): a minimal "create chart" editor** — name + chartType (the existing 5) + groupBy field + aggregation + value field — wired to the existing `client.createChart` + `ChartConfig`, reusing the field-visibility gate. Frontend-only. Richer types / multi-series become trivial follow-ups once the editor exists.

## 1. Current-state ground truth (`origin/main` @ `2dfa4cb7e`)

### 1.1 Two chart-data paths — the shipped UI uses the PERSISTED one

| Path | Entry | Producer | Used by shipped UI? |
|---|---|---|---|
| **Persisted charts** | `GET /sheets/:id/charts/:chartId/data` (`client.getChartData`) | `ChartAggregationService.computeChartData(chart: ChartConfig, records)` (`chart-aggregation-service.ts:84`) | **YES** — `MetaDashboardView` |
| **Ad-hoc widgets** | `POST /dashboard/query` (`univer-meta.ts:4801`) | `loadDashboardSourceRows` + `buildDashboardWidgetResult` (inline widgets) | not by `MetaDashboardView` (separate/older surface) |

Both query **real records**. The S0 slice targets the **persisted** path (what users see).

### 1.2 The persisted path is real + permission-gated + single-series

- `MetaDashboardView` calls `listDashboards` / `listCharts` / `getChartData(chartId)` / `createDashboard` / `updateDashboard({panels})`. Real data, not a stub.
- `getChartData` → `ChartAggregationService.computeChartData` aggregates real records: filter → group (by field **or** date bucket) → aggregate (one `function` + one `fieldId`). Output `ChartData { chartId, chartType, dataPoints: {label,value,color}[], total?, metadata }`.
- **Single-series** by construction (`dataPoints` is a flat label→value list; one series in `buildChartOption`).
- **Field-gate already applied**: the dashboard query path derives `visibleFields` via `deriveFieldPermissions` + `fieldScopeMap` (e.g. `univer-meta.ts:4836`), and `ChartData.metadata.restricted` (`chart-aggregation-service.ts:26`) is the permission signal the renderer now honors (#2262). **The permission substrate exists and is reused — no RBAC work needed.**
- `ChartType = 'bar' | 'line' | 'pie' | 'number' | 'table'` (`charts.ts:5`); `buildChartOption` maps bar/line/pie to ECharts, number/table render as HTML (#1950).

### 1.3 The real gap: no chart-authoring UI

- The client has full CRUD — `createChart` / `updateChart` / `deleteChart` / `listCharts` / `getChartData` (`api/client.ts:1634-1671`) — and the backend `ChartConfig` supports type + groupBy + aggregation + filter + date-grouping + display.
- **But `createChart`/`updateChart`/`deleteChart` are NEVER invoked from the frontend** (verified: zero call sites in `apps/web/src`). `MetaDashboardView` only **lists** charts, **displays** `chart.chartType` (read-only), and **adds an existing chart to a panel** (`onAddPanel(chartId)`). There is **no chart-config editor component** (none found).
- Net effect: a user with no API-seeded charts sees `dashboard.noCharts` and **cannot create one in-product**. The rich backend is unreachable from the UI.

## 2. Permission boundary (reuse, do not rebuild)

- The chart-authoring editor offers **only visible, groupable/numeric fields** — reuse the SAME `deriveFieldPermissions` + `filterVisiblePropertyFields` gate the dashboard query already applies; do not invent a new gate.
- Chart **data** is re-gated server-side at `getChartData` time (already does field-perm derivation + `restricted`); the editor never bypasses that. Creating a chart def referencing a field the user can see is consistent with the existing read model.
- **No central RBAC/auth change. No aggregation/engine change.** The `restricted` render semantics (#2262) stay as-is.

## 3. Locked first slice — BI v2-a (minimal chart-config CREATE editor)

A small **create-only** modal/panel in the dashboard surface to **create a chart**, wired to the existing `client.createChart` + `ChartConfig`. The closed loop it must prove: **create → persist → render** (after save, the chart renders through the *existing* dashboard/chart-data path — `getChartData` → `MetaChartRenderer`). Nothing more.
- **Inputs:** name; `chartType` (the existing 5 — bar/line/pie/number/table); `groupByFieldId` (from visible **groupable** fields); `aggregation.function` (count/sum/avg/min/max per `ChartAggregation`); `valueFieldId` (required + numeric-only when function ≠ count — mirror the server validation in `/dashboard/query:4853`).
- **Reuse:** existing client `createChart`, the `ChartConfig` contract, the field-visibility gate, and the existing render path for the post-save result.
- **Form component may be written for future reuse** (so v2-b's edit can adopt it), but v2-a **exposes no edit UX and no edit/update API change** — create only.
- **Frontend-only.** Backend `ChartConfig` CRUD + aggregation already support everything; no backend change.

**Why this is the right keystone:** it's the missing link that makes the already-real data path usable; richer chart types and multi-series are **invisible without it** (no way to select them). Once the editor exists, those become incremental options in the type-picker / a second series field.

## 4. Non-goals (S0 + v2-a)

Multi-series (a `ChartData` shape change — `dataPoints` → series[]); new chart types beyond the existing 5; the ad-hoc `/dashboard/query` surface; any backend `ChartConfig`/aggregation change; RBAC/auth; `formula-over-lookup` A-full / Option D. **Edit/delete chart UI → v2-b** (edit pulls in config back-fill, dirty state, update semantics, and perm/concurrency edges that would balloon the first cut). **Live preview → v2-b** (preview means data requests for *unsaved* config + debounce/stale-drop + error/permission states — a second cut; v2-a only renders *after* save via the existing path).

## 5. Slicing

| Slice | Scope | Risk |
|---|---|---|
| **S0 (this doc)** | recon + lock the first slice | none (docs) |
| **v2-a** | minimal chart **create** editor (existing types, single-series), reuse client CRUD + field gate | Low (frontend-only) |
| **v2-b** 🔒 | edit/delete chart + live preview polish | Low |
| **v2-c** 🔒 | richer chart types (area/donut/stacked — rendering variants of single-series) | Low-med (enum + buildChartOption) |
| **v2-d** 🔒 | multi-series (`ChartData`/`ChartConfig` contract change + aggregation + render) | Med-high (contract) |

Each post-v2-a slice is a separate gated opt-in.

## 6. Test plan (v2-a, when implemented)

- Frontend specs: editor renders; offers **only visible groupable/numeric** fields (field-gate reuse); `createChart` called with the assembled `ChartConfig`; `sum`/`avg` blocks submit without a numeric `valueFieldId`; created chart appears in `listCharts`.
- One real-DB smoke (optional): create a chart via the editor's path → `getChartData` returns real aggregation over seeded records (proves the editor → existing real provider round-trip), added to the `plugin-tests.yml` runner list if included.

## 7. Decisions (locked 2026-06-04)

1. **Keystone framing → v2-a = minimal chart CREATE editor.** Not richer-type / multi-series first:
   chart-data + rendering already exist; the real blocker is that users can't create a chart config.
   Close the **create → persist → render** loop first; richer chart capability needs that surface to land on.
2. **v2-a minimality → CREATE-only, no edit.** The form component may be written to be reusable later, but
   v2-a exposes no edit UX / no edit-API change (edit's config back-fill + dirty-state + update semantics +
   perm/concurrency edges → v2-b).
3. **Live preview → deferred to v2-b.** v2-a only requires that a saved chart renders immediately via the
   existing dashboard/chart-data path; unsaved-config preview (data requests + debounce/stale-drop + error/
   perm states) is the second cut.

### v2-a slice boundary (locked)

A minimal create form (necessary inputs: chart type + group-by field + aggregation + value field) → on save,
`createChart` → refresh the chart list → render the new chart through the existing path. **No edit, no live
preview, no multi-series, no new chart types, no backend change.** Each of those is a separate later opt-in.
