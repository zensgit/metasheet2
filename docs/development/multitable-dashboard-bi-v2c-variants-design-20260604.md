# Multitable Dashboard BI v2-c — donut / area variants — Design-Lock — 2026-06-04

> Status: **DESIGN-LOCK (docs-only). No code in this PR.** Owner decisions locked 2026-06-04. One page on purpose — it pins exactly two points: **stacked → v2-d**, and **`displayConfig.variant` → v2-c**. Implementation (donut/area) is a separate cut after merge.
> Recon on `origin/main` @ `a081151d8` (S0 #2273 · v2-a #2276 · v2-b1 #2279 · v2-b1.1 #2281 · v2-b2 live preview #2286 all present).

## 1. Scope (locked) — donut + area only

v2-c ships two **single-series render variants** of the existing `ChartData`:
- **donut** = `chartType: 'pie'` + `displayConfig.variant: 'donut'` (pie with an inner radius).
- **area** = `chartType: 'line'` + `displayConfig.variant: 'area'` (line with `areaStyle`).

**Stacked is NOT in v2-c.** Stacking needs ≥2 series per category; a single-series chart has nothing to stack. **Stacked moves to v2-d (multi-series)** and is handled together with the multi-series `ChartData`/aggregation **contract** change there. Pulling stacked into v2-c would force a contract change into a render-only slice — exactly what this slice avoids.

## 2. Modeling (locked) — `displayConfig.variant`, no new `ChartType`

Variants are a **`displayConfig` render flag**, NOT new `ChartType` enum values:
- `ChartType` stays `bar | line | pie | number | table` — **backend untouched** (`charts.ts:5`).
- Rationale: a new `ChartType` would promote a pure render variant into a **protocol-model change** (backend enum + `computeChartData` + validation + parity tests). Not worth it for "pie-with-a-hole" / "line-with-fill". When v2-d does real multi-series, stacked gets its contract then.

This keeps v2-c **frontend-only**, matching the v2-a/v2-b cadence.

## 3. Integration (it rides the EXISTING displayConfig channel — verified)

`displayConfig` already flows end-to-end and into the renderer, so variant needs no new plumbing:
- `buildChartOption(chartData, displayConfig)` (`buildChartOption.ts:32`) already reads `displayConfig` (`showValues`, `orientation`). **Add:** in the **pie** branch, `variant === 'donut'` → inner radius (e.g. `radius: ['45%','70%']`); in the **line** branch, `variant === 'area'` → `areaStyle: {}`. `variant` is honored **only** in the pie/line branches — a stray variant on another type is inert (no need to hard-error).
- **Save:** the form's `displayConfig` → `createChart`/`updateChart` (wire `display`) — v2-b1's overlay already preserves `displayConfig`.
- **Preview (v2-b2):** `previewDisplayConfig = buildChartInput(...).displayConfig` (`MetaDashboardView.vue:316`) → `MetaChartRenderer` → `buildChartOption`. So **preview == saved** for variants automatically — no preview change.
- **Persisted panel:** `chartConfigMap[panel.chartId]?.displayConfig` → `MetaChartRenderer` → `buildChartOption` (`:92`).

**Frontend changes (impl slice):**
1. `ChartDisplayConfig` (frontend `types.ts`): add `variant?: 'donut' | 'area'`.
2. `buildChartOption`: the two branch tweaks above.
3. Form (`MetaDashboardView`): add `variant` to `chartDraft`; render a **variant `<select>` only when `chartType` is `pie` (donut) or `line` (area)**; clear `variant` when `chartType` leaves pie/line; `buildChartInput` includes `variant` in `displayConfig` (alongside the existing `{...base.displayConfig, title}` overlay). Save + preview both read this one config.

## 4. Non-goals

New `ChartType` values; any backend change; stacked; multi-series; new aggregation; RBAC.

## 5. Test plan (frontend-only — backend untouched, no real-DB)

- **`buildChartOption` unit:** `displayConfig.variant: 'donut'` on a pie → option has an inner radius (array radius); `variant: 'area'` on a line → `series[0].areaStyle` present; **no variant → byte-identical to today** (regression); a variant on bar/number/table is inert.
- **Form spec (`multitable-dashboard-view.spec.ts`):** the variant `<select>` shows only for `chartType` pie/line and is hidden for bar/number/table; switching chartType away from pie/line **clears** `variant`; `buildChartInput().displayConfig.variant` is carried on **create**, **edit**, and **preview** (same config) — so the create body / update body / preview render all include it.

## 6. Decisions (locked 2026-06-04)

1. **v2-c = donut + area only.**
2. **stacked → v2-d** (multi-series; not a single-series capability).
3. **`displayConfig.variant`, no new `ChartType`** — donut = pie+`variant:'donut'`, area = line+`variant:'area'`.
4. **Backend untouched**; save / preview / persisted render all reuse the existing `displayConfig` pass-through; the form shows the variant option only under pie/line.
