# Multitable grid performance — measure-first baseline (2026-07-05)

Tier-B gap #4 from `docs/research/multitable-feishu-refresh-audit-20260629.md`: *"Grid performance/virtualization — 100k+ rows. (Scale, not feature; measure-first.)"*

**This is a measurement report, not a virtualization implementation.** Per the audit's own discipline, this establishes an actual baseline before anyone attempts a rewrite. Bottom line: **the gap as originally framed is largely stale for the flat/ungrouped path** (already solved, 2026-06-22) — but measuring surfaced a real, more specific, more urgent bottleneck the audit didn't name: **the grouped-view rendering path has no windowing at all and degrades severely at a far lower row count than 100k.**

## 1. What already exists (code-grounded, not assumed)

`apps/web/src/multitable/components/MetaGridTable.vue` already implements row-windowing on the **flat (ungrouped, non-expanded, non-printing)** path — shipped in `085ce92be` / PR #3008, **feat(multitable): A1 grid row virtualization — windowing + infinite-scroll activation (FUNCTIONAL)**, merged **2026-06-22, seven days before** the 06-29 audit that lists this gap. The mechanism:

- `flatWindowEnabled` gates the whole thing: only active when not printing, not grouped, no expanded rows, and the row count exceeds `VIRTUALIZE_MIN_ROWS = 60`.
- `windowStart`/`windowEnd` compute a scroll-driven visible range with `OVERSCAN_ROWS = 8` rows of margin on each side, clamped so a stale `scrollTop` after the set shrinks (search/filter) can't blank the grid.
- `windowRows` mounts only that range, but carries each row's **absolute** index — explicitly to avoid desyncing row-number/focus/selection/keyboard-nav (the component's own comment calls this out as "the keystone bug").
- Top/bottom `<tr class="meta-grid__spacer">` elements reserve the unmounted rows' vertical space so scrollbar height and scroll position match a fully-rendered table.
- An infinite-scroll trigger (`maybeLoadMore`, `LOAD_MORE_THRESHOLD_PX = 400`) asks the parent to fetch the next page as the user nears the bottom, so an accumulating flat set climbs past `VIRTUALIZE_MIN_ROWS` and windowing engages on its own — default page size is 50/page, below the 60-row threshold, so accumulation (not the first page alone) is what triggers it.

**The component's own comment is explicit about the boundary**: *"Windowing is active only on the flat path... Otherwise the template renders every row exactly as before."* Grouped and expanded-row rendering fall back to unwindowed, full-array rendering (`groupRenderItems`, a separate computed with no window slicing).

## 2. Measurement method

Real Vue + jsdom render via this repo's own established component-test convention (`createApp`/`h`/`mount` into a detached `<div>`, following the pattern in the sibling `apps/web/tests/multitable-grid-databar.spec.ts`). New file: `apps/web/tests/multitable-grid-perf-baseline.spec.ts`. Synthetic `MetaRecord[]` arrays at increasing scale are mounted and two real signals are captured: wall-clock mount time (`performance.now()`) and actual DOM row count (`querySelectorAll('tbody tr.meta-grid__row').length`).

**What this does and doesn't prove:**
- ✅ Real signal for DOM node count vs. row count (the core "is it windowed" question) — this is environment-independent; a bounded query result is a bounded query result.
- ✅ Real signal for *relative* mount-cost scaling (flat vs. grouped) — the ratio between the two is meaningful even though jsdom's absolute numbers are not.
- ⚠️ **NOT** a real-browser paint/scroll-jank/frame-timing measurement. jsdom has no real layout/paint pipeline — `clientHeight` reads 0, so the windowing math falls back to `DEFAULT_VIEWPORT_HEIGHT = 600px`, an environment artifact, not a real screen's visible-row count. jsdom's DOM implementation is also known to be considerably slower per-node than a real browser's, especially at scale — so **absolute grouped-path timing below should be read as "dramatically more expensive," not as a literal production millisecond count.** A real-browser measurement (Playwright against a live dev server with a seeded large dataset) would be needed to get production-representative absolute numbers and real scroll-frame timing; that was out of scope for this pass (no live dev server / seeded large dataset in this environment) — flagged here as follow-up work, not silently skipped.

Run: `pnpm exec vitest run tests/multitable-grid-perf-baseline.spec.ts` in `apps/web`.

## 3. Results

### Flat (windowed) path — the audit's stated "100k+ rows" scenario

| Rows | Mount time | DOM `<tr class="meta-grid__row">` count |
|---|---|---|
| 1,000 | 35.9ms | 33 |
| 10,000 | 15.3ms | 33 |
| **100,000** | **17.8ms** | **33** |
| 50,000 → 50,050 (simulated infinite-scroll page-append) | 19.2ms | 33 → 33 |

**Mount time and DOM row count are flat across two orders of magnitude of row count.** This is the expected, correct signature of working windowing — the grid is doing O(visible-window) work, not O(n), exactly as the code's design intends. The audit's "100k+ rows" framing for the flat/ungrouped case reads as **stale**: the feature was already shipped a week before that audit was written. (The DOM-row-count-of-33 figure itself is a jsdom-environment artifact of the 600px viewport fallback, not a claimed real-screen row count — the meaningful result is that it stays constant, not the specific number.)

### Grouped path — NOT windowed, and this is the real finding

| Rows / groups | Mount time | DOM row count |
|---|---|---|
| 3,000 rows / 30 groups | **11,590.6ms (~11.6s)** | 3,000 |

Every row rendered into the DOM — confirming the code comment empirically, not just by reading it. At **3,000 rows** (two orders of magnitude below the audit's "100k+" framing), mount cost is already ~**300–700× worse** than the flat path handles at 100,000 rows. This did not need 100k rows to become a real problem — a moderate grouped view with moderate row counts is already in a different cost regime entirely.

## 4. Bottleneck mechanism

Not the flat path — that's solved. The bottleneck is structural: `flatWindowEnabled` requires `!groupedRows.value`, so **grouping unconditionally disables windowing**, regardless of scale. Any customer view with grouping enabled (a very ordinary configuration, not an edge case) gets zero windowing benefit no matter how many rows exist under the hood — the group-header/subtotal interleaving (`groupRenderItems`) was never given a windowed counterpart.

A secondary, untested-here dimension: infinite-scroll accumulation grows the **in-memory** `rows`/`filteredRows` array (not just DOM nodes) as a user scrolls further — this baseline's 50,000→50,050 append test showed no mount-time or DOM-count regression at that scale, but a full long-session growth curve (e.g., scrolling to accumulate 200k+ rows in memory over one session) was not measured here and is a distinct question from DOM windowing (JS heap / Vue reactivity dependency-tracking cost over a very large reactive array, independent of how many DOM nodes are mounted).

## 5. What a future virtualization design-lock should reference from this baseline

- **Scope it narrowly**: the real gap is "windowing for grouped/expanded-row rendering," not "grid virtualization" generically — the flat path is done.
- **Confirm with a real browser before committing to an approach**: get Playwright-driven paint/scroll-frame numbers at production-realistic scale (this baseline's jsdom numbers establish *relative* severity and the *qualitative* finding, not literal production timing).
- **Design question to resolve**: can grouped rendering apply a per-group windowed range (eagerly render group headers/subtotals, windowed rows within each expanded group) rather than requiring windowing to be an all-or-nothing, ungroup-only feature?
- **Separately size the in-memory-accumulation question**: whether the infinite-scroll-accumulated array itself needs a cap/eviction strategy independent of DOM windowing, at a scale beyond what this baseline tested (50k→50,050).
- Re-run `multitable-grid-perf-baseline.spec.ts` (or its successor) as the acceptance check for whatever grouped-windowing approach is chosen — it already has the flat-path numbers to compare against, and can gain a grouped-path assertion once a fix exists.
