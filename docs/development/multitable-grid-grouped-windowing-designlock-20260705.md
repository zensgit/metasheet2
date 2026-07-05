# Multitable grid — GROUPED-path row windowing — DESIGN LOCK (PROPOSED)

- **Status**: PROPOSED — awaiting owner ratification. Docs-only PR; no runtime code ships here.
- **Provenance**: this is the design-lock the measure-first baseline (`docs/development/multitable-grid-perf-baseline-20260705.md`, PR #3582, squash `b891780bd`, merged 2026-07-05) called for. The flat-path half of audit gap Tier-B #4 shipped long ago (PR #3008, `085ce92be`, 2026-06-22); this lock covers the remaining half the baseline isolated: **the grouped rendering path has no windowing at all**.
- **Change surface when implemented** (single runtime PR after ratification): `apps/web/src/multitable/components/MetaGridTable.vue` only (grouped `<tbody>` branch + new windowing computeds + two spacer rows), plus tests. **No backend change, no API change, no data-shape change, no new env flag.**

## §1 Problem — verified against code, with one honest reframing of the baseline

1. **The mechanism gap is real.** `flatWindowEnabled` (`MetaGridTable.vue:622-627`) hard-requires `!groupedRows.value`, so grouping unconditionally disables windowing; the grouped `<tbody>` branch (`:35-163`) renders EVERY `groupRenderItems` entry. The baseline measured the consequence: 3,000 rows / 30 groups → **~9.7–11.6s jsdom mount, 3,000 DOM rows**, vs the flat path's constant ~33 DOM rows and 15–36ms across 1k→100k.
2. **Reframing (code truth the baseline under-weighted): grouped mode is pager-bounded in production today.** `infiniteScrollEnabled` (`:677`) ALSO excludes grouped mode — grouped views keep the classic footer pager (comment `:673`, prop doc `:458-464`), `useMultitableGrid` defaults to `DEFAULT_PAGE_SIZE = 50` and passes that as `loadView({ limit: pageSize, ... })`, while `MultitableWorkbench.vue` only feeds `load-more` when `gridIsFlatPath`/`gridCanLoadMore` are true. So the ordinary workbench grouped view renders ≤ ~50 data rows today and is NOT currently a 10-second production fire. **What the gap actually blocks**: (a) grouped views can never scale past one small page (no infinite-scroll accumulation parity with the flat path — and client-side `buildGroupTree(filteredRows)` `:794-824` groups only the loaded page, fragmenting groups across pages); (b) any caller passing a large `rows` prop (embedding surfaces, future page-size options, accumulated sets) hits the unwindowed cliff immediately. This lock is therefore **the prerequisite for scaling grouped views**, not a hotfix.
3. **Two simplifiers the design inherits (verified):**
   - **Subtotals cannot be corrupted by windowing**: per-group subtotal values are SERVER-computed over the full filtered set and read by composite path (`groupAggValueDisplay`, prop doc `:474-476` — "no local group aggregation"). Windowing changes what MOUNTS, never what a subtotal SAYS.
   - **Grouped mode has no expand-rows**: the expand button / expand-row `<tr>` exist only in the flat branch (`:181`, `:271`); the grouped branch renders zero expand affordances. One fewer variable-height concern.
4. **The flattened item stream already exists**: `groupRenderItems` (`:838-861`) is a flat, ordered, typed list — `header | data | subtotal` items with per-item `path`/`navIndex` — because `<tr>` cannot nest. The windowing model below is a windowed slice over THIS existing list, not a new render architecture.

## §2 LOCK-GW-A — the windowing model

**Window the existing flattened `groupRenderItems` list using a per-kind-height offset table (prefix sums) + top/bottom pixel spacers** — the direct extension of the flat path's architecture (`windowStart`/`windowEnd`/spacer rows) to a stream whose items have one of THREE near-constant heights instead of one.

- **A1 — item heights are per-KIND constants**: `H_data` = the existing `rowHeightPx` (measured, density-aware, `:614`); `H_header` and `H_subtotal` = measured once from the first mounted instance of each kind (same `measuredRowHeight` discipline), with sane CSS-derived defaults before first measure. Header indent is `padding-left` (`:40-46`) — level does NOT change height; if a future style makes heights level-dependent, the offset table gains per-level entries, not a new model.
- **A2 — offset table**: a prefix-sum array over `groupRenderItems` (`offset[i]` = pixel top of item i; rebuilt only when the items array or a height constant changes — O(N) rebuild, N = data rows + 2×group nodes). Scroll→index resolution by binary search; `windowStartItem`/`windowEndItem` = resolved index ± `OVERSCAN_ROWS` (reuse the existing constant `:601`).
- **A3 — spacers**: `topSpacerHeight = offset[windowStartItem]`, `bottomSpacerHeight = totalHeight − offset[windowEndItem]` — same two `<tr class="meta-grid__spacer">` elements the flat path uses (`:164`, `:293`), rendered inside the grouped `<tbody>`.
- **A4 — absolute indices are the keystone (same as flat's #3008 lesson)**: mounted items keep their ABSOLUTE `navIndex` / `path` / item identity; window position must never leak into row numbering (`startIndex + item.navIndex + 1`, `:63`), focus matching (`focusRow === item.navIndex`), selection, or subtotal path lookup.

**Rejected alternatives (recorded per lock discipline):**
1. **Per-group windowing** (window rows inside each group independently) — headers/spacers per group multiply bookkeeping, off-screen groups' headers still all mount (DOM not bounded by viewport), and nested scroll regions break the single-table/sticky-column layout. Rejected.
2. **Uniform-height approximation** (treat header/subtotal as data-height and reuse flat math verbatim) — offset error accumulates with group count; scrollbar height lies; focus scroll-into-view mis-lands. This is precisely why the original A1 comment says uniform spacer math "doesn't apply" (`:589-592`). Rejected.
3. **Fully dynamic per-row measurement** (ResizeObserver / vue-virtual-scroller-style arbitrary heights) — heaviest machinery for a stream with exactly three near-constant kinds; unnecessary reactivity cost. Rejected as overkill; noted as the fallback IF variable-height grouped rows ever appear.

## §3 LOCK-GW-B — activation predicate + forced-full-render states

- **B1**: new `groupedWindowEnabled = !printing && groupedRows !== null && groupRenderItems.length > VIRTUALIZE_MIN_ROWS` (reuse the existing `60` constant `:604`; the count is over ITEMS — headers and subtotals occupy viewport space exactly like rows do).
- **B2 — printing forces full render** — the existing `beforeprint`/`afterprint` flip (`:735-736`) covers grouped mode identically (a windowed table would print ~20 rows).
- **B3 — small sets render fully** (≤ threshold → zero spacers, byte-identical DOM to today).
- **B4 — flat path untouched**: `flatWindowEnabled` and its math are NOT modified; the two predicates stay disjoint (`grouped` vs `!grouped`). The grouped classic footer pager also stays — lifting grouped mode onto infinite-scroll accumulation is a NAMED FOLLOW-UP this lock unblocks, explicitly NOT part of this slice (§6).
- **B5 — jsdom/default-viewport fallback** identical to flat (`DEFAULT_VIEWPORT_HEIGHT = 600` `:605`): the initial render is already windowed under test.

## §4 LOCK-GW-C — invariants that must not regress

- **C1 scroll geometry**: `topSpacer + Σ(mounted item heights) + bottomSpacer === Σ(all item heights)` at every window position (scrollbar parity with a full render).
- **C2 keyboard-nav parity**: `displayRows` ordering (`:864-877`) and `navIndex` remain the single nav truth; focus scroll-into-view in grouped mode resolves the target's pixel offset through the OFFSET TABLE, not `focusRow * rowHeightPx` (that expression `:722` is flat-only and stays flat-only).
- **C3 selection integrity**: selection operates on record ids over the data model (`selectableRowIds`), never on mounted DOM — select-all / bulk actions produce identical sets windowed or not.
- **C4 collapse/expand correctness**: toggling a group rebuilds `groupRenderItems` (collapsed subtrees are already omitted `:831-832`); the window must clamp against the SHRUNK item count (the flat path's stale-`scrollTop` clamp lesson `:633-640`), and the toggled header must remain mounted and visible after the toggle.
- **C5 subtotal render parity**: mounted subtotal rows display exactly the server-tree values for their `path` — windowing changes mounting, never values (§1.3).
- **C6 group semantics untouched**: `buildGroupTree`, `GROUP_KEY_SEP` path composition, collapse persistence (`view.config.groupCollapse`), and server aggregation contracts are all out of scope and unmodified.

## §5 Golden matrix (fail-first)

| # | Scenario | Locked outcome |
|---|---|---|
| GW1 | grouped, 3,000 rows / 30 groups (the baseline's gap case) | mounted `<tr>` count (headers+data+subtotals) bounded by window+overscan — NOT ~3,060; this FLIPS the baseline spec's grouped test from "documents the gap" (asserts 3,000 mounted) to "locks the fix" (asserts bounded), in `apps/web/tests/multitable-grid-perf-baseline.spec.ts` |
| GW2 | fixed viewport+scrollTop, windowed vs unwindowed reference | identical visible item sequence (kind/order/labels/row ids/navIndex) |
| GW3 | every window position | spacer-sum invariant C1 holds exactly |
| GW4 | keyboard nav to an off-window record | correct record focused; scroll-into-view lands on its true offset (offset-table path) |
| GW5 | collapse/expand a group while scrolled deep | items rebuild, window clamps, no blank gap, toggled header mounted |
| GW6 | subtotal rows inside the window | values == server tree by path (C5) |
| GW7 | select-all + bulk action under windowing | selection sets identical to unwindowed |
| GW8 | `beforeprint` in grouped mode | full render, zero spacers |
| GW9 | flat path | existing flat goldens + baseline flat numbers unchanged (B4) |
| GW10 | ≤60 items grouped | full render, zero spacers (B3) |

**Real-browser acceptance (baseline doc's own caveat, made binding)**: the runtime PR's verification MD must include Playwright-driven before/after numbers (mount + scroll-frame timing) against a live dev server at a production-realistic grouped scale (≥5k rows / ≥50 groups), using `apps/web`'s existing `verify:browser` / `playwright.verification.config.ts` harness. jsdom mount numbers alone do not close this lock.

## §6 Explicitly OUT of scope (each a separate gated opt-in)

Grouped-mode infinite-scroll accumulation (pager → load-more parity with flat — the follow-up this lock UNBLOCKS); server-side grouping / cross-page group coalescing (today's client `buildGroupTree` groups the loaded page only — a real limitation, but a data-model question, not a rendering one); in-memory accumulation caps (baseline §4's secondary dimension); expand-rows in grouped mode; any flat-path change; any generic variable-height virtualization library adoption.

## §7 What this lock does NOT claim

- It does NOT claim grouped views are slow for today's default workbench users (they are pager-bounded to ~50 rows — §1.2). The claim is: the grouped path has no windowing, which (a) is a cliff for any large-`rows` caller today and (b) blocks ever scaling grouped views.
- It does NOT claim the baseline's ~11.6s is a production millisecond figure (jsdom amplifies per-node cost — baseline §2's own caveat). The DOM-count signal (3,000 mounted rows) is environment-independent; the timing is directional.
- It does NOT change what any user sees below the activation threshold — small grouped views render byte-identically.

## §8 Arc ledger

- ⬜ **GW-lock** (this doc) — awaiting ratification
- 🔒 **GW-runtime** — implement §2–§5 in `MetaGridTable.vue` + flip the baseline grouped test + Playwright before/after (single PR, after ratification)
- 🔒 **Grouped infinite-scroll accumulation** (separate design first; unblocked by GW-runtime)
- 🔒 **Server-side grouping / cross-page group coalescing** (data-model slice, independent)
