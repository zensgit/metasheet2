# 多维表 UI-P2-2c · 响应式工作台左侧栏（窄屏折叠 + 抽屉）· 设计（IMPLEMENTED）

> 状态：**IMPLEMENTED**（#4290 merged `a52f55845`，2026-07-15；Opus ×2 轮门禁 + 真浏览器验证）。断点语义统一勘误（owner Low）：**`window.innerWidth <= 768` 为窄**（768 含在窄内），文中一切「>= 768」为误写应读作「>= 769/> 768」。Parent lock
> `multitable-ui-p2-2-left-rail-detail-designlock-20260707.md` §5 lists `🔒 P2-2c 响应式折叠（窄屏抽屉/图标条）—
> P2-2b 后` as a pending gate with no further detail; the P2-2b design MD (§8.4) explicitly defers all
> viewport/media-query behavior to this slice ("2b 不加任何视口 media query"). Neither doc specifies a
> breakpoint, a collapse pattern, or keyboard/ARIA behavior for the narrow case — this document fills
> that gap so the implementation has a written contract, per this task's fallback instruction ("if NO or
> partial: write a short design section first"). Recommend Opus/adversarial review before merge, same as
> P2-2b (§4.6 of the parent lock frames the rail as structural), since the drawer overlay is new runtime
> behavior even though its net diff is small.
> Baseline: `origin/main` @ `6a10d08c7` (P2-2b #4264 landed: `MetaSheetViewRail.vue` vertical tree +
> `MultitableWorkbench.vue`'s collapsible `<aside>` rail, `railCollapsed` ref, T7 collapse tests).

## 0. One-liner

At viewport widths above the breakpoint, nothing changes (pinned by tests). Below it, the rail
auto-collapses to the *same* 36px icon-strip P2-2b already built (no new DOM there — it was already an
escape hatch, now it also self-triggers). If the user re-expands the rail while narrow, it becomes a
floating overlay ("drawer") over the main content instead of squeezing it — one new CSS class, driven by
one new JS boolean, closed by the *same* `rail-collapse-toggle` button that already exists, plus Escape.
Zero new props/emits/testids on `MetaSheetViewRail.vue`; zero new i18n strings; all state lives in
`MultitableWorkbench.vue` (consistent with where P2-2b already put `railCollapsed`, and for the same
reason it gave: the rail-level chrome is a workbench concern, not the tree component's).

## 1. Breakpoint

`apps/web/src/styles/tokens.css` has no `--ms-bp-*` / width-breakpoint family (confirmed by reading the
full 143-line file — only color/spacing/radius/typography/container-width/shadow tokens exist). P2-2b hit
the same gap for the rail's own 240px/36px widths and explicitly carved out "raw px, don't invent a new
token vocabulary" (§6 of its design MD). This slice follows the same carve-out for the breakpoint:

```ts
const RAIL_NARROW_BREAKPOINT = 768 // px, window.innerWidth
```

768px is not arbitrary — it is the single most common threshold already used across `apps/web/src`
(`App.vue`, `PageShell.vue`, `CalendarView.vue`, `SpreadsheetsView.vue`, `FormView.vue`,
`AttendanceView.vue`, `AttendanceImportWorkflowSection.vue`, `AttendanceRequestCenterSection.vue`,
`TemplateDetailView.vue`, `GalleryView.vue`, `PlmProductView.vue`, and — most relevantly —
`AttendanceAdminRail.vue`'s own `useAttendanceAdminRailNavigation.ts`, a structurally analogous
"persistent left nav for a big workbench" that already does exactly this pattern: a
`window.innerWidth <= 768` check on mount + `resize`, driving a `isCompactAdminNav` boolean). That
component is this slice's closest precedent and its logic shape is deliberately mirrored below.

The threshold is a **JS-only constant** — deliberately **not** duplicated into a CSS `@media` query, so
there is exactly one source of truth and no risk of the two drifting apart over time. The narrow/wide
CSS states are entirely driven by the JS-computed class bindings (same idiom P2-2b already used for
`.mt-workbench__rail--collapsed`, which also isn't behind a media query).

## 2. State model

Three refs/computed, all in `MultitableWorkbench.vue` (`<script setup>`, near the existing
`railCollapsed`):

| name | kind | meaning |
|---|---|---|
| `railCollapsed` | `ref<boolean>` (pre-existing, P2-2b) | user-togglable; unchanged semantics |
| `isRailNarrow` | `ref<boolean>` (new) | viewport-derived, **not** user-writable; `window.innerWidth <= 768` |
| `isRailDrawerOpen` | `computed<boolean>` (new) | `isRailNarrow && !railCollapsed` |

`syncRailViewportState()` (called on mount + on every `resize`, mirroring
`syncAdminNavViewportState` in `useAttendanceAdminRailNavigation.ts`):

```ts
function syncRailViewportState(): void {
  if (typeof window === 'undefined') return
  const narrow = window.innerWidth <= RAIL_NARROW_BREAKPOINT
  const wasNarrow = isRailNarrow.value
  isRailNarrow.value = narrow
  if (!narrow) return                     // wide: NEVER touches railCollapsed — see §4 desktop-invariance
  if (!wasNarrow) railCollapsed.value = true // just crossed into narrow: auto-collapse once
}
```

Two deliberate asymmetries, both testable:

1. **Entering narrow auto-collapses; staying narrow never re-collapses.** A user who manually re-expands
   the rail (opens the drawer) at, say, 600px and then resizes to 500px does not get slammed shut by a
   second `resize` tick — `wasNarrow` is already `true` so the `if (!wasNarrow)` branch is skipped. This
   matches `useAttendanceAdminRailNavigation.ts`'s own asymmetry (it only forces the flyout shut on
   *actions* like `scrollToAdminSection`, not on every resize tick while already compact).
2. **Leaving narrow does not force-expand.** Crossing back over the breakpoint does not reset
   `railCollapsed` — the user's manual toggle state (set at any width, before or during the narrow visit)
   is left alone. This is a scope-minimizing choice: it keeps `syncRailViewportState`'s wide branch a true
   no-op (see §4), and avoids a surprise "the sidebar reopens itself" resize side effect. A user who wants
   it back just clicks the (always-visible) toggle — unchanged control surface.

Neither the auto-collapse nor `isRailNarrow` is persisted (no localStorage/server write) — consistent
with P2-2b's §3.1 owner-decision-A default ("not persisted") and P2-2b's design lock language ("component
remount resets"); a fresh mount always re-runs `syncRailViewportState()` from the real viewport.

## 3. Narrow-width behavior (the two states below the breakpoint)

| state | condition | visual | in-flow or overlay | new DOM/CSS |
|---|---|---|---|---|
| **icon-strip** (already existed) | `isRailNarrow && railCollapsed` | 36px strip, only the toggle button visible (rail content `v-show`-hidden) | in-flow (same as P2-2b's desktop-collapsed state) | none — this is literally P2-2b's `.mt-workbench__rail--collapsed`, just auto-entered instead of requiring a click |
| **drawer** (new) | `isRailNarrow && !railCollapsed` (= `isRailDrawerOpen`) | full rail (base-bar + tree) floats over `.mt-workbench__main` instead of squeezing it | `position: absolute` overlay, `z-index: 5`, `box-shadow: var(--ms-shadow-pop)`, opaque `background: var(--ms-bg-card)`, `width: min(240px, calc(100vw - 32px))` | one new CSS class `.mt-workbench__rail--drawer` on the existing `<aside>` |

At width **> 768px**（即 >= 769）: neither state can be entered (`isRailNarrow` is `false`, so `isRailDrawerOpen` is
always `false` and the auto-collapse branch never runs) — behavior is **exactly** the pre-2c P2-2b rail,
unconditionally.

Taking the rail out of flow via `position: absolute` is what frees the width for `.mt-workbench__main`
(which is `flex: 1` and therefore expands to fill the space the rail no longer reserves) — no separate
CSS change to `.mt-workbench__main` was needed. `.mt-workbench__content` gains `position: relative`
(inert for every other child) purely to give the drawer a local positioning anchor instead of the
viewport, so it respects the toolbar/actions bar above it rather than floating over them too.

The drawer's own close affordance is the **same** `rail-collapse-toggle` button, no new testid: clicking
it still just flips `railCollapsed`, which (since `isRailNarrow` is still `true`) lands back in the
icon-strip state. `MetaSheetViewRail.vue` itself is untouched — 0 lines changed, 0 new props/emits, per
the parent lock's emit/consumer-parity constraints (§4.1/§4.2), which this slice doesn't need to touch at
all since all the new logic is chrome around the existing component, not inside it.

## 4. Desktop-width invariance (the thing tests must pin)

Claim: at any point in time where `window.innerWidth > RAIL_NARROW_BREAKPOINT`, the rail's behavior is
identical to the pre-2c P2-2b build.

This isn't just "looks the same" — it's structurally true from the code: `syncRailViewportState`'s wide
branch is `isRailNarrow.value = narrow; if (!narrow) return` — a pure read-then-return with **zero**
writes to `railCollapsed`. The only other new code that reads `railCollapsed` is the `isRailDrawerOpen`
computed and the `Escape` branch in `onGlobalKeydown`, both of which are gated on `isRailNarrow` (false at
desktop) before touching anything, so they're no-ops too. The pre-existing `rail-collapse-toggle` click
handler (`railCollapsed = !railCollapsed`) is untouched — same line, same behavior.

Test evidence for this claim: (a) all of P2-2b's existing T7 tests
(`apps/web/tests/multitable-workbench-view.spec.ts`, `describe('UI-P2-2b — rail collapse (T7)')`) continue
to pass **unmodified** — jsdom's default `window.innerWidth` (1024) is already above 768, so those tests
were unknowingly already exercising the "wide" path; their continuing to pass with the 2c code present is
itself a desktop-regression check. (b) A new explicit test sets the viewport to 1280px and re-asserts the
same invariants defensively (see §6).

## 5. Keyboard / ARIA

- **Toggle button**: unchanged — same `data-testid="rail-collapse-toggle"`, same `aria-expanded`/
  `aria-label`/`title` bindings (`rail.collapse`/`rail.expand`, already-existing i18n keys in
  `workbench-labels.ts` — no new strings needed since the button's role, whether it's opening the
  icon-strip or the drawer, is still accurately described as "expand/collapse sidebar").
- **Escape closes the drawer**, scoped: only fires when `isRailDrawerOpen` is true AND the event's
  `target` is inside `.mt-workbench__rail` (`(e.target as HTMLElement)?.closest('.mt-workbench__rail')`).
  This reuses the workbench's existing single `@keydown="onGlobalKeydown"` root listener (bubbling — no
  new `addEventListener`) and mirrors the scoping style already used by that function's `?` shortcut
  branch (`!(e.target as HTMLElement)?.closest('input, textarea, select')`). The scoping is a deliberate,
  documented choice: an unscoped global Escape would risk stealing the key from an unrelated in-progress
  interaction elsewhere in the workbench (e.g. a cell editor's own Escape-to-cancel) that happens to be
  open at the same time the drawer is open. Pressing Escape closes the drawer (`railCollapsed = true`)
  and returns focus to the toggle button (`railToggleRef`).
- **What is explicitly NOT implemented** (honesty section, same spirit as P2-2b's §5.3/§10): no focus
  trap, no backdrop/scrim, no outside-click-to-dismiss. The drawer is a **non-modal** overlay — background
  content (`.mt-workbench__main`) stays fully focusable and readable by assistive tech throughout, which
  is why no `aria-hidden`/`inert` is applied to it either. This is a scope-minimizing choice for a first
  slice, not an oversight; a follow-up could add a proper modal treatment if narrow-width usage in
  practice shows it's needed, but that would be its own small design decision (new interaction surface),
  not a hidden default the way P2-2b's §5.3 already treats "don't claim behavior you didn't build."
- The rail's internal tree keyboard nav (`role="tree"`/`treeitem`/roving tabindex, P2-2b §5) is completely
  untouched — the drawer only changes the *outer* `<aside>`'s CSS positioning, not anything inside
  `MetaSheetViewRail.vue`.

## 6. Test plan

All new tests are **state** assertions (refs/classes/attributes), not CSS/layout assertions — per this
task's constraint that jsdom cannot be trusted for real style/layout claims. They extend the existing
`describe('MultitableWorkbench view wiring', ...)` suite in
`apps/web/tests/multitable-workbench-view.spec.ts` (already in `multitable-web-guard.yml`'s path-filter
and run-token list — no CI wiring changes needed, avoiding the "skip-shaped green" trap of adding a new
spec file and forgetting to wire it in). A `setViewportWidth(width)` helper is added, copied verbatim in
shape from `apps/web/tests/useAttendanceAdminRailNavigation.spec.ts`'s own helper
(`Object.defineProperty(window, 'innerWidth', ...)` + `window.dispatchEvent(new Event('resize'))`).

New `describe('UI-P2-2c — responsive rail (narrow-width auto-collapse + drawer)', ...)`:

1. **Desktop invariance**: mount at 1280px — default expanded, no `--collapsed`/`--drawer` class, toggle
   `aria-expanded="true"` (defensive re-statement of §4's claim; the unmodified T7 block already covers
   this at jsdom's default width).
2. **Narrow at mount**: mount at 600px — auto-collapses (`aria-expanded="false"`, `--collapsed` class
   present, `--drawer` absent).
3. **Resize after mount, round trip**: mount at 1280px, resize to 600px (auto-collapses), resize back to
   1280px (stays collapsed — pins the "leaving narrow does not force-expand" asymmetry from §2).
4. **Drawer open/close**: mount at 600px (auto-collapsed), click toggle → `--drawer` class present,
   `aria-expanded="true"`; click toggle again → `--drawer` gone, `--collapsed` back (pins the toggle
   double-duty as both icon-strip-opener and drawer-closer).
5. **Escape scoped-in**: open the drawer, dispatch `Escape` from the toggle button (inside
   `.mt-workbench__rail`) — drawer closes, `document.activeElement` is the toggle button.
6. **Escape scoped-out**: open the drawer, dispatch `Escape` from `.mt-workbench__main` — drawer stays
   open (pins the scoping decision in §5, not just that Escape "works").

Diff whitelist for this slice: `apps/web/src/multitable/views/MultitableWorkbench.vue` (script: 3 new
refs/computed + 1 function + 2 event-listener lines + 1 `onGlobalKeydown` branch; template: 1 class
binding + 1 template ref; style: 1 property added to an existing rule + 1 new rule) and
`apps/web/tests/multitable-workbench-view.spec.ts` (1 new helper + 1 new `describe`). Nothing else —
`MetaSheetViewRail.vue`, `meta-sheet-view-rail-labels.ts`, `workbench-labels.ts`, and
`multitable-web-guard.yml` are all untouched (no new i18n strings, no CI path-filter/run-list changes
needed since both changed files are already covered).

## 7. Verification honesty (read before trusting a "done")

- **State logic**: verified by the vitest suite above, run for real in this environment (see PR body for
  the actual command + output).
- **CSS positioning / shadow / z-index / actual visual overlay-vs-push behavior**: **not** verified in a
  real browser in this environment. Per this task's instructions and this repo's standing rule that
  jsdom cannot be trusted for style claims (`feedback_css_verify_in_real_browser_not_jsdom.md`), no claim
  is made here that the drawer visually renders correctly, that `--ms-shadow-pop`/`--ms-bg-card` resolve
  to the expected computed values, or that it looks correct in dark mode. This is flagged explicitly as a
  **coordinator verification gap** — the P2-2b PR (#4264) used a vite-harness + Playwright
  `getComputedStyle` pattern for exactly this kind of claim; the same pattern should be applied here
  before treating the CSS leg as proven, not just the state-machine leg.
- **No new hardcoded hex**: every new/changed CSS declaration in this slice uses an existing `--ms-*`
  token (`--ms-bg-card`, `--ms-shadow-pop`, `--ms-radius-lg`) or a unitless/px layout value in the same
  "raw px for sizing, not color" carve-out P2-2b already used (§6 of the 2b MD) — grep-checkable:
  `rg '#[0-9a-fA-F]{3,8}' apps/web/src/multitable/views/MultitableWorkbench.vue` on just the diff hunk
  shows zero new matches (pre-existing hex elsewhere in this large file is out of this slice's scope to
  fix).
