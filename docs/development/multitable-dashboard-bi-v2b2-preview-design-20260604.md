# Multitable Dashboard BI v2-b2 — Live Preview — Design-Lock — 2026-06-04

> Status: **DESIGN-LOCK (docs-only). No code in this PR.** Owner decisions locked 2026-06-04: **Option B** (faithful, small backend) — §2/§8. Implementation (v2-b2) is a separate cut.
> Author: Claude (Opus 4.8, 1M context) + read-only recon on `origin/main` @ `8701c46e0` (S0 #2273 · v2-a #2276 · v2-b1 #2279 · v2-b1.1 #2281 all present).
> Builds on the BI v2 arc. The locked goal: **live preview of an UNSAVED chart config in the create/edit form**.

## 0. TL;DR — the pivotal decision

Preview needs chart data for a config the user **hasn't saved yet**. There are only two ways to get it, and they are not equivalent:

- **Option A — reuse `POST /dashboard/query` (frontend-only).** It already computes from inline widget configs over real records — but its config is **strictly narrower** than the form (chartType `bar|line|pie` only — no `number`/`table`; metric `count|sum|avg` only — no `min`/`max`/`count_distinct`; `groupByFieldId` required — no date-grouping), and it returns a **different shape** (`DashboardWidgetResult`, not `ChartData`). A preview built on it would be **partial and divergent**: for number/table charts, min/max aggregations, or date-grouped charts it can't preview faithfully — the preview would **lie** vs the saved result. A preview that doesn't match what you save is worse than no preview.
- **Option B (recommended) — a small backend "preview from inline `ChartConfig`" endpoint.** Runs the **same** `ChartAggregationService.computeChartData(config, rows)` the persisted path uses, behind the **same** field-gate + restricted semantics → returns the **same `ChartData`** shape → renders identically to the saved chart. **Preview == saved, by construction.** Cost: a small backend addition (the arc has been frontend-only since v2-a — this is the one slice that needs a backend touch).

**DECIDED 2026-06-04: Option B.** Faithfulness is the whole point of preview; Option A's divergence defeats it (it would produce fake previews for number/table, min/max/count_distinct, and date-grouped charts — worse than no preview). The backend addition is small and reuses everything (engine + gate + restricted) — no new aggregation logic, no RBAC change, nothing persisted.

## 1. Recon ground truth (`origin/main` @ `8701c46e0`)

### 1.1 Two chart-data compute paths

| Path | Input | Engine | Output | Gate |
|---|---|---|---|---|
| **Persisted** `GET …/charts/:id/data` (`dashboard.ts:256`) | persisted `chartId` | `dashboardService.getChartData` → `ChartAggregationService.computeChartData(chart, rows)` | **`ChartData`** (what `MetaChartRenderer` consumes) | `requireSheetRead` + `loadAllowedFieldIds` + `isChartDataRestricted` → `restrictedChartData` (#2262) |
| **Ad-hoc** `POST /dashboard/query` (`univer-meta.ts:4801`) | inline `widgets[]` | `loadDashboardSourceRows` + `buildDashboardWidgetResult` | `DashboardWidgetResult` (≠ `ChartData`) | `visibleFields` via `deriveFieldPermissions` |

### 1.2 `/dashboard/query` capability gap vs the create/edit form (the reason Option A is partial)

`dashboardWidgetSchema` (`univer-meta.ts:2083`): `chartType ∈ {bar,line,pie}`, `metric ∈ {count,sum,avg}`, `groupByFieldId` **required**. The form (v2-a/v2-b1/v2-b1.1) supports `chartType ∈ {bar,line,pie,number,table}`, `aggregation ∈ {count,sum,avg,min,max,count_distinct}`, and **date-grouped** charts (`dataSource.dateFieldId`/`dateGrouping`). So `/dashboard/query` cannot faithfully preview: **number/table** charts, **min/max/count_distinct** aggregations, or **date-grouped** charts. Plus a `DashboardWidgetResult → ChartData` shape adapter would be needed.

### 1.3 The persisted path's gate is reusable verbatim

`getChartData` route (`dashboard.ts:256-276`): `requireSheetRead` → `loadAllowedFieldIds` → `isChartDataRestricted(chart, allowedFieldIds)` ? `restrictedChartData(chart)` : `computeChartData`. **The inline-config preview reuses this exact chain** (substituting the inline config for the persisted chart) → identical permission + restricted behavior; no new gate.

## 2. The decision (locked)

**DECIDED 2026-06-04 — Option B.** v2-b2 adds a small backend endpoint that computes `ChartData` from an inline (unsaved) chart config via the **same** `computeChartData` + the **same** `getChartData` gate. NOT `/dashboard/query` (its narrower capability + divergent shape would produce fake previews for number/table, min/max/count_distinct, and date-grouped charts). This is the one slice in the arc that touches the backend; the footprint is deliberately minimal (§3).

## 3. Contract (locked, assuming Option B)

### 3.1 Backend (small, reuses everything)
- New route **`POST /api/multitable/sheets/:sheetId/charts/preview-data`**.
- **Request body = a `ChartCreateInput`-compatible inline chart config — NOT a full `ChartConfig`.** It is the **same shape the create/edit form already sends** to `createChart`/`updateChart` (frontend `chartType` / `dataSource` / `displayConfig`, wire-mapped to `type` / `dataSource` / `display`). It carries **no** `id` / `name` / `sheetId`. Wording matters: do **not** write "full inline `ChartConfig`" — that invites conflating the persisted `ChartConfig` (`id`/`name`/`sheetId`/`type`) with the form's `chartType`/`displayConfig` and misreads the implementation.
- **The route synthesizes a transient `ChartConfig`** for the engine: `sheetId` from the route param, an ephemeral `id` (e.g. `'preview'`), empty `name`, and `type`/`dataSource`/`display` from the body. Nothing is written to the DB.
- **Gate identical to `getChartData`**, applied to that transient config: `requireSheetRead` → `loadAllowedFieldIds` → `isChartDataRestricted(transientConfig, allowedFieldIds)` ? `restrictedChartData(transientConfig)` : compute.
- **Compute via the same `ChartAggregationService.computeChartData(transientConfig, rows)`** (add a thin `dashboardService.computeChartDataForConfig(sheetId, config)` that loads rows + computes, mirroring `getChartData` minus the persisted-chart load). **No new aggregation logic.**
- Returns the **same `ChartData`** shape → the existing `MetaChartRenderer` renders it (incl. the `restricted` state) with zero renderer change.
- Validation mirrors create/edit (group field required unless date-grouped; numeric value field for sum/avg/min/max).

### 3.2 Frontend (the preview panel in the reused form)
- `client.previewChartData(sheetId, inlineConfig): Promise<ChartData>`.
- **Debounced** preview request on form-field changes (~300 ms) — do not fire per keystroke.
- **Stale-drop** via a request-sequence guard (mirror the formula dry-run `dryRunSeq` pattern): only the latest request's result renders.
- Render the result through **`MetaChartRenderer`** (same component as panels) — including the **restricted** state (#2262) and a preview-**error** state (request failed). No divergent render path.
- Preview is **read-only + informational** — it never persists, and it never gates Save (Save still depends only on the form-valid check). Disabled / empty until the form is minimally valid.
- Reuses the field-visibility gate server-side; the form already offers only visible fields.

## 4. Permission boundary

Preview reuses the **exact** persisted-path gate (`requireSheetRead` + `loadAllowedFieldIds` + `isChartDataRestricted` + `restrictedChartData`). A preview whose inline config references a field the caller can't read returns the **restricted** state — identical to the saved chart, no leak. No new field-permission gate; no RBAC/auth change.

## 5. Non-goals

`/dashboard/query` reuse (feature-incomplete, divergent); any aggregation-engine change (preview reuses `computeChartData`); multi-series (v2-d); new chart types (v2-c); persisting preview; preview gating Save.

## 6. Slices

| Slice | Scope | Risk |
|---|---|---|
| **v2-b2** | preview-data endpoint (Option B) + `client.previewChartData` + debounced/stale-drop preview in the form, rendered via `MetaChartRenderer` incl. restricted/error states | Low-med (one small backend route + a frontend panel) |

## 7. Test plan (v2-b2) — locked

**Backend (real-DB; added to the `plugin-tests.yml` runner list):**
- **PARITY (the headline):** the preview `ChartData` for an inline config is **identical** to `getChartData` for an **equivalent persisted chart** (same dataSource/type) over the same seeded rows — byte-for-byte equal. This is what proves "preview == saved."
- **Denied field → restricted, no compute, no leak:** an inline config referencing a `field_permissions`-denied field returns the **`restricted`** state via `isChartDataRestricted` and does **not** run `computeChartData` / return any data point.
- **Non-narrow capability (proves it is NOT `/dashboard/query`):** at least one representative each of **date-grouped**, **number / table** chart type, and **min / max** aggregation previews correctly — exactly the cases `/dashboard/query` cannot do.
- Validation: group field required unless date-grouped; numeric value field for sum/avg/min/max.

**Frontend:**
- Preview fires **debounced** on form edits (not per keystroke).
- **Stale-drop:** an earlier slow response never overwrites a later one (request-sequence guard).
- Renders `ChartData` via `MetaChartRenderer`; **restricted** + **error** states render.
- **Preview NEVER gates Save** — Save's enabled/disabled state is independent of preview status/result.

## 8. Decisions (locked 2026-06-04)

1. **Option B** — small backend inline-compute, faithful (preview == saved). NOT `/dashboard/query`.
2. **Endpoint:** `POST /api/multitable/sheets/:sheetId/charts/preview-data`.
3. **Reuse only:** `requireSheetRead` → `loadAllowedFieldIds` → `isChartDataRestricted`/`restrictedChartData` → `computeChartData`. **No new aggregation logic, no RBAC change, nothing persisted.**
4. **Request body = `ChartCreateInput`-compatible inline chart config** (the form's existing shape), **not** a full `ChartConfig`; the route synthesizes the transient `ChartConfig` (id/name/sheetId) internally for the engine (§3.1).
