# Multitable Dashboard BI — v2-d-b multi-series modes design-lock

**Status:** design-lock + implementation ledger. b1 and b2 are complete; b3 is intentionally paused / demand-gated, not the automatic next slice.
**Date:** 2026-06-05
**Predecessors:** v2-d-a stacked bar — backend #2297 + hardening #2299 + frontend #2303 (all merged).
**Ground-truth base:** `origin/main` @ `8bf7b38a6` (read via a fresh worktree, not the canonical checkout).
**Implementation ledger:** b1 grouped bar = backend #2312 (`7e2f60d1f`) + frontend #2315 (`83801c668`); b2 multi-series line = backend #2316 (`f0ebf6bd0`) + frontend #2323 (`4b36444d0`). b3 date-axis × series remains deferred until there is concrete product demand.

> v2-d-a delivered single-axis stacked bar (additive-only, groupBy-primary). v2-d-b adds the three modes the v2-d-a design deferred. Each adds a **semantic layer** v2-d-a doesn't have, which is why this is a fresh design-lock, not just more impl.

---

## 0. The three sub-slices (owner-confirmed split)

- **v2-d-b1 — grouped (side-by-side) bar.** ✅ Shipped. `displayConfig.barMode = 'stacked' | 'grouped'`. Grouped bars are independent (not summed), so **non-additive aggregations are allowed** in grouped mode.
- **v2-d-b2 — multi-series line.** ✅ Shipped. Reuse the `series[]` contract; lines are overlaid, never stacked → **any aggregation**.
- **v2-d-b3 — date-axis × series.** ⏸ Demand-gated. Lift v2-d-a's date-grouping rejection: a date-bucket primary axis split into series. Define the **ordering / zero-fill / limit** rules (the part v2-d-a had no answer for).

Each is a separate opt-in. b1 and b2 have now landed and form a usable BI increment (stacked + grouped bar; multi-series + area line; donut/area variants; number/table; create/edit/delete/preview). b3 remains the hardest and narrowest slice, so it is **not** the default next task; reopen it only for a concrete time-series-with-series use case.

---

## 1. Recon — what v2-d-a built, and the four constraints v2-d-b restructures

`assertSeriesConstraints` (`charts.ts:96-114`) today enforces, for any `seriesByFieldId`:
1. `type === 'bar'` only → **b2 lifts to also allow `line`**.
2. `groupByFieldId` required → **b3 allows a date-axis primary instead**.
3. `dateFieldId + dateGrouping` rejected (the #2299 hardening) → **b3 lifts it (for line + grouped bar)**.
4. additive aggregation (`sum`/`count`) required → **b1/b2 relax to "any aggregation" whenever the series are not stacked**.

Producer (`ChartAggregationService.computeChartData`): emits `series` only for `bar + seriesByFieldId + groupByFieldId + !dateGrouped + additive`. The two-dimensional grouping that builds `series[i].data[j]` (aggregation over `groupBy==j AND seriesBy==i`, dense + aligned to the sorted+limited `dataPoints`) is **mode-agnostic** — stacked vs grouped vs line differ only at *render*, not in the series math.

Render (`buildChartOption`): bar+series → N series each `stack:'total'`; line → single series; `MetaChartRenderer` draws an HTML legend over series names (`data-legend="series"`).

`dataPoints`/`total` are the single-dimension `groupBy` aggregation, unchanged. The **additive consistency property** (`Σ series[*].data[j] === dataPoints[j].value`) holds only because v2-d-a is additive + stacked.

---

## 2. Cross-cutting contract (lands with b1; b2/b3 build on it)

### 2.1 `displayConfig.barMode?: 'stacked' | 'grouped'` — default `'stacked'`
- Backward-compatible: existing v2-d-a charts have **no** `barMode` → treated as `'stacked'`. No migration.
- Display-only field (rides the existing `display` jsonb; like v2-c `variant`). Inert unless `seriesByFieldId` is set and `type === 'bar'`.
- `line` has no stacking concept → `barMode` is ignored for line (multi-line is always overlaid).

### 2.2 Conditional-additive rule
**Additive (`sum`/`count`) is required *iff* the segments are stacked** — i.e. `type === 'bar' && barMode !== 'grouped'`. Rationale: only a stacked bar's *height* (`Σ segments`) needs to be a meaningful total. Grouped bars and overlaid lines show each value independently, so `avg`/`min`/`max`/`count_distinct` are honest there.

| mode | series allowed for | additive required? |
|---|---|---|
| bar + stacked (default) | sum, count | ✅ yes (v2-d-a) |
| bar + grouped (b1) | any aggregation | ❌ no |
| line (b2) | any aggregation | ❌ no |

### 2.3 🔒 Producer must branch on `barMode` — invariant, not just validation
The producer (not only validation) decides whether to emit `series`, reading `chart.display.barMode`:

> emit `series` ⟺ `type ∈ {bar, line}` + `seriesByFieldId` + a primary axis + `(type === 'line' OR barMode === 'grouped' OR additive(aggFn))`

This display-coupling is **deliberate**. v2-d-a's safety-net invariant was *"a hand-crafted/persisted bad config can't render a misleading stack"* — which holds only because the producer omits series for the disallowed combination. If stacked-requires-additive were enforced in validation alone, a persisted `stacked + non-additive` chart would still get series from the producer and render a misleading stack. So the producer keeps the final say.

### 2.4 ⚠️ `dataPoints` / `total` are a separate view in non-additive modes
Once grouped/multi-line allows non-additive aggregations, **`Σ series ≠ dataPoints`** and `total` becomes e.g. a sum-of-averages. State plainly: in grouped/multi-line modes, `dataPoints`/`total` are the **single-dimension view** (the chart without the series split), **not** a roll-up of `series`. Nothing should assert the v2-d-a consistency property outside bar+stacked, nor surface `total` as a grouped/multi-line grand total. (The additive consistency invariant survives **only** for bar+stacked.)

### 2.5 🔴→∅ No new security surface
`chartReferencedFieldIds` needs **no change**: `seriesByFieldId` (v2-d-a) and `dateFieldId` (pre-existing) are already in it; `barMode` is display-only (no field reference). So every field a v2-d-b chart can touch is already gated — there is no new restricted-leak vector in this slice. (Stated explicitly because every prior slice had a 🔴; this one's security work is "confirm nothing new," with a regression test that a denied `seriesByFieldId` still restricts in grouped/line/date modes.)

---

## 3. v2-d-b1 — grouped (side-by-side) bar

**Implementation status:** ✅ complete via #2312 (backend) + #2315 (frontend).

- **Types:** `ChartDisplayConfig += barMode?: 'stacked' | 'grouped'` (backend `charts.ts` + frontend `types.ts`).
- **Validation** (`assertSeriesConstraints`): when `seriesByFieldId` + `type==='bar'`, require additive **only if** `barMode !== 'grouped'`; `barMode==='grouped'` accepts any aggregation. (`barMode` without `seriesByFieldId` is inert — no error.)
- **Producer:** unchanged series math; the emit-guard's additive check becomes `(barMode === 'grouped' || additive)`.
- **Render** (`buildChartOption` bar branch): `barMode==='grouped'` → N bar series with **no `stack`** (ECharts renders side-by-side); else `stack:'total'` (today). Honors `orientation` in both.
- **Form** (`MetaDashboardView`): a `barMode` control (shown only for `bar`); the series picker's gating relaxes — offered for `bar` + (additive **or** `barMode==='grouped'`). Clear/keep logic mirrors v2-c/v2-d-a.
- **Tests:** grouped → series with no stack, non-additive (avg) accepted + produces series; stacked still additive-only (regression); validation accepts grouped+avg, rejects stacked+avg; render snapshot of `stack` presence per mode.

---

## 4. v2-d-b2 — multi-series line

**Implementation status:** ✅ complete via #2316 (backend) + #2323 (frontend).

- **Validation:** `assertSeriesConstraints` allows `type==='line'` with `seriesByFieldId` + `groupByFieldId` (any aggregation; line never stacks). Keep `type` ∈ {bar, line} as the only series-bearing types (pie/number/table still rejected).
- **Producer:** emit-guard `type ∈ {bar, line}` (was bar-only). Series math unchanged.
- **Render** (`buildChartOption` line branch): when `series` present → N `line` series (no `stack`; `variant:'area'` applies `areaStyle` to each line). x-axis = `dataPoints` labels; legend over series names (reuse the stacked-bar legend block — generalize `hasStackedSeries` to `hasSeriesLegend = (bar||line) && series.length`).
- **`variant` interaction (implemented):** v2-c `variant:'area'` + multi-series line preserves the existing area variant per series (each line keeps `areaStyle`). Stacked-area / 100%-stacked semantics remain deferred; overlaid area lines are the shipped b2 behavior.
- **Form:** series picker offered for `line` too (any aggregation); no `barMode` for line.
- **Tests:** line+series → N line series no stack; non-additive accepted; single-series line unchanged (regression); legend renders for multi-line.

---

## 5. v2-d-b3 — date-axis × series (the rules v2-d-a deferred)

**Implementation status:** ⏸ paused / demand-gated. Do not treat this as automatically next after b2. It should start only when a concrete dashboard use case needs time-series split by a second field.

Lifts constraint #3: a **date-bucket primary axis** (`dateFieldId + dateGrouping`) split by `seriesByFieldId`. Applies to `line` (the common time-series case) and grouped `bar`; **stacked bar over time stays additive-only** per §2.2.

The series math is the same two-dim grouping, but the primary axis is date buckets, which forces three rules:

### 5.1 Ordering — chronological; `sortBy`/`sortOrder` ignored for the date primary axis
In date-axis mode the primary axis is ordered **by bucket chronology (bucket key ascending)**. `dataSource.sortBy`/`sortOrder` are **ignored for the primary (date) axis** — they sort *categories* by label/value, which is meaningless for a time axis. (They are locked off here, not silently honored; a future "sort time axis descending" need would be an explicit later decision, not implicit reuse of `sortOrder`.) **Scope decision (locked): apply chronological ordering to *all* date-grouped charts, not just date+series** — today single-series date charts come out in record-encounter order unless `sortBy:'label'` is set, a latent quirk; fixing it for all date-grouped is the consistent choice. ⚠️ Impl must regression-check existing single-series date charts (small blast-radius: any test asserting today's encounter-order flips to chronological).

### 5.2 Zero-fill — two distinct sparsities, handled differently
1. **A series absent in an *existing* bucket** → `0`, dense alignment (identical to v2-d-a). Keep.
2. **A bucket with no records at all** (e.g. no rows in March) → **not generated.** This is **inherited from today's single-series date-line** (`groupByDate` only creates buckets that have records); b3 matching it is *consistent, not a new bug*. Honest limitation to state: a **line over time interpolates straight through a missing bucket** (misrepresenting the gap). Synthetic full-range bucket generation is a **separate deferred enhancement** that applies to single- and multi-series alike (§8) — do not silently imply the time axis is complete.

### 5.3 ✅ Limit (owner-confirmed) — primary-axis-bound; select newest-N, then render ascending
`dataSource.limit` stays **bound to the primary axis in every mode** — no polysemy. In groupBy modes it caps category count (today); in **date mode it selects the newest N date buckets**. **Series-count cap is deferred** (if too-many-lines readability bites, add a hard cap, e.g. 12, that *logs* the truncation — no silent cap). Option B (limit = series count in date mode) was rejected: it makes `limit` mode-dependent.

🔒 **Order-of-operations (the trap §5.1 + `limit` create together):**
1. **Select** the **newest N** buckets when `limit` is set — the N *most-recent* by bucket key, **not the first N**.
2. **Render** the selected buckets **chronological ascending** (oldest → newest, left to right).

Do **NOT** `sortAscending().slice(0, limit)` — that yields the *oldest* N. Use `sortDescending().slice(0, limit).reverse()` (equivalently `sortAscending().slice(-limit)`). A b3 test MUST assert that with `limit < bucketCount` the result is the **most-recent N in ascending order** (e.g. 5 monthly buckets, `limit:3` → the latest 3 months, displayed oldest→newest).

### 5.4 Validation / producer
- `assertSeriesConstraints`: for date-grouped + `seriesByFieldId`, allow `line` (any agg) and grouped `bar` (any agg); **reject stacked bar + date + non-additive** (the §2.2 rule still applies to stacked). Remove the blanket date-grouping rejection.
- Producer emit-guard: drop `!dateGrouped`; when date-grouped, sub-group each date bucket by `seriesByFieldId` (same dense alignment), buckets ordered per §5.1, `limit` per §5.3.

### 5.5 Tests
chronological bucket order; dense 0-fill per existing bucket; missing-bucket NOT synthesized (documents the gap); limit semantics per the chosen option; denied `seriesByFieldId` still restricts in date mode; line-over-time multi-series parity preview≡saved.

---

## 6. Impl plan & sequencing
Each sub-slice = a separate explicit opt-in, backend-first (type + validation + producer + real-DB tests green before frontend), mirroring v2-d-a.
- **b1** (grouped bar): ✅ complete. `barMode` type + conditional-additive validation + producer guard + render + form.
- **b2** (multi-line): ✅ complete. Extended series to `line` (validation + producer + render + legend + form), including area-variant preservation.
- **b3** (date×series): ⏸ demand-gated. Lift date rejection + ordering/zero-fill/limit rules only when product demand justifies the extra time-axis semantics. The §5.3 limit decision remains the prerequisite.
- No new security gate; each slice adds a "denied seriesByFieldId still restricts in this mode" regression test.
- Frozen / out of scope: `src/formula/engine.ts`, central RBAC/auth, integration-core, storage/migrations (series computed, only `barMode`/`seriesByFieldId` persist in existing jsonb). No OpenAPI change (chart-data endpoints un-modeled, same as v2-a..v2-d-a).

---

## 7. Deferred (later, separately-gated)
- **Synthetic full-range date buckets** (continuous time axis / explicit gap handling) — applies to single- and multi-series date charts alike; the honest fix for §5.2's line-gap limitation.
- **Series-count cap** if owner picks §5.3 option (A).
- **Advanced `variant` × multi-series** (stacked-area / 100%-stacked). Overlaid area multi-line shipped in b2.
- **Stacked line** (area-stacked time series) — additive, a distinct render.
- Multi-value-field series (two series = `sum(A)`, `sum(B)`) — still deferred from v2-d-a.
