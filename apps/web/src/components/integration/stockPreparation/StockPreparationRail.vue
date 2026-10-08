<template>
  <!--
    THE RAIL IS STILL ONE TABLIST. 设计稿 §2.2 is a grouped, direction-flipping strip, not a different
    kind of navigation, so the widget that carries `role="tablist"` — now `.sp-rail__tablist`, an INNER
    `<div>` rather than `<nav>` itself (see the hardening-wave note below for why) — keeps its
    `data-testid="stock-prep-tabs"` and every tab keeps `role="tab"` + `data-testid="stock-prep-tab-${key}"`
    under its ORIGINAL key. That is the one invariant every existing suite reads by name, and it is
    unchanged by this file's restructuring.

    HARDENING WAVE (2026-09-08), AND THE FIX ROUND THAT FOLLOWED IT. `<nav>` used to BE the tablist.
    Two things nested under it leaked into the tablist's ACCESSIBLE children despite living inside a
    `role="presentation"` group wrapper — presentation only prunes the WRAPPER's own box:

      * 深度工具's disclosure `<button>` has an implicit role of "button" (native, unremovable — ARIA
        forbids `role="presentation"` on a focusable element), so it was exposed as a tablist child
        that is not a tab. Fixed by making it a literal DOM sibling of the tablist rather than a
        descendant: `<nav>` is now a plain wrapper holding `.sp-rail__tablist` (the widget) and
        `.sp-rail__advanced` (the disclosure + its panel) SIDE BY SIDE, not one inside the other.
      * Each group heading `<p>`. The first cut gave the heading its own `role="presentation"` and
        called the leak closed. IT DID NOT. `role="presentation"` drops the ELEMENT's semantics; its
        TEXT is re-parented up to the nearest surviving ancestor — the tablist — so 「工作 / 部署与接入
        / 帮助」 stayed inside the tablist's accessible content, which is precisely what pruning the
        `<p>` was supposed to remove. What removes it is `aria-hidden="true"`, which prunes the
        element AND its subtree. The heading now carries BOTH: `role="presentation"` (so a role
        census over this subtree still reads 「tab or presentational, nothing else」) and
        `aria-hidden="true"` (so the words themselves are gone from the tree).
        The heading text is not lost to the tabs that need it: every tab — permanent AND folded —
        points `aria-labelledby` at its group heading's id and then its own. Accname's rule for a
        node DIRECTLY referenced by `aria-labelledby` is to include it EVEN WHEN IT IS HIDDEN, which
        is exactly what makes 「borrow the presentational caption's words」 work here; and because the
        tab also references itself, the worst case if a UA disagreed is the tab's own visible text,
        never an empty name.

    组标题 IS STILL A DOM DESCENDANT OF THE TABLIST — it has to be, for the CSS grouping. What it is no
    longer is part of the tablist's ACCESSIBLE content. R-05 asserts that as TEXT rather than as a role
    census, because a role census structurally cannot see a stray text node — the exact way the first
    cut's guard was blind to the very failure it was written for.

    THE ACCESSIBLE NAME LIVES ON THE `role="tablist"` ELEMENT, not on `<nav>`. On main the two were one
    element and `aria-label="备料视图"` named the tablist; splitting them without moving the label left
    the tablist anonymous (APG requires a tablist to be named) and silently promoted `<nav>` to a
    landmark wearing the tablist's old name. Both elements are named now, with DIFFERENT words, so a
    screen reader announces a navigation landmark and a named tab list rather than the same phrase twice.
  -->
  <nav
    ref="navEl"
    class="sp-rail"
    :aria-label="bi('备料工作台导航', 'Stock preparation navigation')"
    @keydown="handleTablistKeydown"
  >
    <div
      class="sp-rail__tablist"
      role="tablist"
      :aria-label="bi('备料视图', 'Stock preparation views')"
      :aria-orientation="orientation"
      data-testid="stock-prep-tabs"
      :aria-owns="advancedOpen && advancedTabIdRefs ? advancedTabIdRefs : undefined"
    >
      <!--
        role="presentation" ON THE GROUP WRAPPERS remains the layout affordance it always was: it
        removes the wrapper's OWN box from the accessibility tree while leaving its `role="tab"`
        children owned by the tablist. What changed is the HEADING inside each wrapper: it carries
        `role="presentation"` AND `aria-hidden="true"` (see the file header for why the first alone
        left the heading's TEXT inside the tablist), and the tabs recover its words by reference.
      -->
      <div
        v-for="group in groups"
        :key="group.group"
        role="presentation"
        class="sp-rail__group"
        :data-testid="`stock-prep-rail-group-${group.group}`"
      >
        <p
          role="presentation"
          aria-hidden="true"
          :id="groupHeadingId(group.group)"
          class="sp-rail__group-title"
          :data-testid="`stock-prep-rail-group-title-${group.group}`"
        >
          {{ bi(group.zh, group.en) }}
        </p>

        <button
          v-for="item in group.items"
          :key="item.key"
          :id="`stock-prep-tab-${item.key}`"
          type="button"
          role="tab"
          class="sp-rail__tab"
          :class="{ 'sp-rail__tab--active': item.key === activeKey }"
          :data-testid="`stock-prep-tab-${item.key}`"
          :data-rail-key="item.key"
          :aria-selected="item.key === activeKey ? 'true' : 'false'"
          :aria-labelledby="`${groupHeadingId(group.group)} stock-prep-tab-${item.key}`"
          :tabindex="item.key === rovingKey ? 0 : -1"
          @click="selectTab(item.key)"
        >
          {{ bi(item.zh, item.en) }}
        </button>
      </div>
    </div>

    <!--
      深度工具 — MOVED OUT OF THE TABLIST (hardening wave). It is a nav-level sibling of
      `.sp-rail__tablist` now, never a descendant of the `role="tablist"` element, which is what keeps
      its disclosure `<button>` from being read as one of the tablist's accessible children (see the
      file header). `aria-controls` still names the panel and `aria-expanded` still tracks it —
      neither changed, only WHERE the pair lives.

      Folded, not retired (owner ruling: canUseLegacyMvpTabs unchanged, nothing goes offline). The
      seven legacy tabs render then get HIDDEN with the `hidden` attribute rather than dropped with
      `v-if`:
        * `hidden` collapses for real — not painted, out of the tab order, out of the accessibility
          tree — so 「默认收起」 is honest; and
        * every existing suite that reaches a legacy tab by testid keeps working unchanged.

      THE FIRST CUT OF THIS SHIPPED A FOLD THAT NEVER FOLDED. `hidden`'s entire effect comes from the
      UA stylesheet's `[hidden] { display: none }`, and the panel's own `.sp-rail__advanced-panel
      { display: flex }` — an AUTHOR-origin rule, and once Vue compiles the scope onto it a
      specificity-(0,2,0) one — beats it on both counts. The explicit `[hidden]` rule in the style
      block below is what makes the attribute mean what this comment says; it is asserted at source
      level in R-03, because jsdom runs no cascade and a DOM assertion structurally cannot see this
      class of defect.

      ONLY ONE GROUP CARRIES `advanced` TODAY (`deploy`), which is why the toggle/panel testids below
      stay singular (`stock-prep-rail-advanced-toggle` / `-panel`) rather than keyed per group — every
      existing suite reads them by that literal name. `advancedGroup` picks whichever group the
      manifest gave a non-empty `advanced` list, so this does not hard-code the group id.
    -->
    <div v-if="advancedGroup" role="presentation" class="sp-rail__advanced">
      <button
        type="button"
        class="sp-rail__disclosure"
        data-testid="stock-prep-rail-advanced-toggle"
        aria-controls="stock-prep-rail-advanced-panel"
        :aria-expanded="advancedOpen ? 'true' : 'false'"
        @click="advancedOpen = !advancedOpen"
      >
        {{ bi('深度工具', 'Advanced tools') }}
        <span aria-hidden="true">{{ advancedOpen ? '▴' : '▾' }}</span>
      </button>
      <div
        id="stock-prep-rail-advanced-panel"
        role="presentation"
        class="sp-rail__advanced-panel"
        data-testid="stock-prep-rail-advanced-panel"
        :hidden="!advancedOpen"
      >
        <!--
          SAME NAMING RULE AS THE PERMANENT TABS: `aria-labelledby` points at 【部署与接入】's heading
          and then at the tab itself. The first cut left these seven without it, so one tablist had two
          naming conventions in it — the eight above announced as 「组名 条目名」 and these seven as the
          bare item. `advancedGroup.group` is the group the manifest actually attached them to, so the
          id is not hard-coded to `deploy`.
        -->
        <button
          v-for="item in advancedGroup.advanced"
          :key="item.key"
          :id="`stock-prep-tab-${item.key}`"
          type="button"
          role="tab"
          class="sp-rail__tab sp-rail__tab--advanced"
          :class="{ 'sp-rail__tab--active': item.key === activeKey }"
          :data-testid="`stock-prep-tab-${item.key}`"
          :data-rail-key="item.key"
          :aria-selected="item.key === activeKey ? 'true' : 'false'"
          :aria-labelledby="`${groupHeadingId(advancedGroup.group)} stock-prep-tab-${item.key}`"
          :tabindex="item.key === rovingKey ? 0 : -1"
          @click="selectTab(item.key)"
        >
          {{ bi(item.zh, item.en) }}
        </button>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
// P1-1 (设计稿 §2.2 / §6.2) — 备料工作台的左栏。
//
// WHAT THIS COMPONENT DECIDES: nothing, about VISIBILITY. It receives groups that are ALREADY
// filtered and labelled and renders them. Item visibility is decided by the access module's
// predicates, in the shell — 「侧栏项的可见性只能调既有/新增谓词,不得在组件里重算权限」 — so this file
// imports no permission helper, calls no permission probe and touches no auth composable at all. The
// matrix suite's F-06 asserts exactly that, by reading this source.
//
// What it DOES decide (hardening wave, F-KB below): keyboard roving focus among the currently VISIBLE
// tabs — WAI-ARIA's tabs pattern, MANUAL-ACTIVATION variant. Arrow keys and Home/End move FOCUS ONLY;
// Enter and Space are what select, and they need no listener here because every tab is a native
// `<button>` that already fires its `click` handler on Enter (keydown) and Space (keyup).
//
// F-ACT — WHY MANUAL, NOT AUTOMATIC. The APG allows either, and the first cut of this wave chose
// automatic ("moving focus selects"). That turned out to be unsafe HERE specifically, because a rail
// selection is not a pure panel switch in this shell: `handleRailSelect('home')`
// (StockPreparationWorkspace.vue) also clears `selectedProjectNo` and strips `?projectNo=` from the
// URL. Under automatic activation a keyboard reader who is on 项目备料 with a project open and presses
// ArrowUp merely to LOOK at the neighbouring item closes that project — and cannot get back to it with
// the keyboard, because with no number open D3's fold bounces the highlight straight back to
// 今天要处理. A mouse reader never meets this: one click is one intent. Manual activation restores that
// property for the keyboard — arrowing PAST an item costs nothing, and Enter/Space is the deliberate
// act — and, as a second-order benefit, stops a single roam of the rail from firing every panel's
// data reads on the way through (the APG's own reason to prefer manual when panels are not cheap).
//
// F-KB — WHY BOTH ArrowUp/Down AND ArrowLeft/Right, AT EVERY WIDTH, RATHER THAN ONE PAIR PICKED BY
// `orientation`. The APG assigns Up/Down to a vertical tablist and Left/Right to a horizontal one, and
// this rail actually changes shape at the `@media (max-width: 899px)` breakpoint CSS decides — but the
// breakpoint is CSS-only and this component's own `orientation` ref is a best-effort mirror of it (see
// below), not a live readout of the cascade. Accepting all four arrow keys at every width is a strict
// SUPERSET of what either single pairing would cover, never a violation of it: a vertical layout that
// also answers Left/Right, or a horizontal one that also answers Up/Down, has not promised a reader
// anything the pattern forbids.
//
// AND THE NARROW LAYOUT IS NOT PURELY HORIZONTAL ANYWAY (pre-existing, unchanged by this wave, worth
// writing down where the arrow-key decision is made): the `@media` block below turns the GROUP ROW
// horizontal while the tabs INSIDE each group stay stacked, so 「horizontal」 is an approximation of a
// two-dimensional layout rather than a description of it. That is the second, independent reason this
// handler answers both pairs instead of trusting `orientation` to pick one — whichever pair a reader
// tries from whichever direction their eye says the next tab lies, it works.
import { computed, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useMobileViewport } from '../../../composables/useMobileViewport'

interface StockPreparationRailItem {
  key: string
  zh: string
  en: string
}

interface StockPreparationRailGroupView {
  /** Group id — `work` / `deploy` / `help`, mirrored from `STOCK_PREP_RAIL_GROUPS`. */
  group: string
  zh: string
  en: string
  items: StockPreparationRailItem[]
  /** 深度工具 members. Empty for every group that has none, so the template needs no optional chain. */
  advanced: StockPreparationRailItem[]
}

const props = defineProps<{
  groups: StockPreparationRailGroupView[]
  /** The key currently rendered by the panel — never the raw click state. */
  activeKey: string | null
}>()

const emit = defineEmits<{ (e: 'select', key: string): void }>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

function groupHeadingId(group: string): string {
  return `stock-prep-rail-group-title-${group}`
}

/** 默认收起 (设计稿 §2.2). Per-mount state: a fold is a view preference, not shared shell state. */
const advancedOpen = ref(false)

/** The one group (今天为止只有 `deploy`) whose manifest entry carries a non-empty `advanced` list. */
const advancedGroup = computed<StockPreparationRailGroupView | null>(() => (
  props.groups.find((group) => group.advanced.length > 0) ?? null
))

/** Space-separated ids for `aria-owns` — declares the folded tabs as logically the tablist's, even
 *  while they live outside it in the DOM (see the template's file-header note on WHY). Emitted ONLY
 *  while the disclosure is open: `hidden` already prunes those tabs from the accessibility tree when
 *  it is shut, so claiming ownership of them then was inert but said something untrue — a tablist that
 *  announces fifteen children while seven of them do not exist. The template gates it on
 *  `advancedOpen` so the declaration and the fold cannot disagree. */
const advancedTabIdRefs = computed<string>(() => (
  advancedGroup.value ? advancedGroup.value.advanced.map((item) => `stock-prep-tab-${item.key}`).join(' ') : ''
))

/** Every currently VISIBLE tab key, in DOM order: the permanent items group by group, then 深度工具's
 *  seven if and only if the disclosure is open. This is the roam order and the roving-stop domain. */
const visibleTabKeys = computed<string[]>(() => {
  const flat: string[] = []
  for (const group of props.groups) {
    for (const item of group.items) flat.push(item.key)
  }
  if (advancedGroup.value && advancedOpen.value) {
    for (const item of advancedGroup.value.advanced) flat.push(item.key)
  }
  return flat
})

/**
 * WHERE THE ROVING STOP SITS, under manual activation (F-ACT). Focus and selection are two different
 * facts now, so the tablist's single `tabindex="0"` follows the LAST KEYBOARD-OR-POINTER-VISITED tab
 * when there is one — that is the APG's rule, and it is what lets a reader Tab away and come back to
 * where they were rather than to where the panel is.
 *
 * Per-mount, deliberately: it is a focus memory, not shell state.
 */
const focusedKey = ref<string | null>(null)

/**
 * ROVING TABINDEX (F-KB). Exactly one tab is `tabindex="0"` at a time, resolved in this order:
 * the last visited tab, else the ACTIVE one, else the first tab in DOM order. Both of the first two
 * can legitimately name a tab this render is not showing (`activeKey` most often — a folded-and-
 * collapsed legacy key; `focusedKey` after the disclosure shuts under the reader's own focus), and a
 * tablist with NO roving stop is not reachable by Tab from outside it at all, which is why the final
 * fallback is unconditional — the same "nothing chosen yet" default the APG examples use.
 */
const rovingKey = computed<string | null>(() => {
  const flat = visibleTabKeys.value
  if (flat.length === 0) return null
  if (focusedKey.value !== null && flat.includes(focusedKey.value)) return focusedKey.value
  if (props.activeKey !== null && flat.includes(props.activeKey)) return props.activeKey
  return flat[0]
})

/** A tab was ACTIVATED — by a pointer click, or by Enter/Space on the focused tab, which a native
 *  `<button>` turns into the very same click with no listener of ours involved. */
function selectTab(key: string): void {
  focusedKey.value = key
  emit('select', key)
}

const navEl = ref<HTMLElement | null>(null)

/** Every `role="tab"` currently reachable — i.e. NOT inside a `[hidden]` ancestor. A folded-and-closed
 *  深度工具 tab lives behind exactly one `[hidden]` (the panel), so `closest` is enough; nothing in this
 *  rail nests `[hidden]` two deep. */
function focusableTabs(): HTMLButtonElement[] {
  if (!navEl.value) return []
  return Array.from(navEl.value.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
    .filter((tab) => !tab.closest('[hidden]'))
}

const ROVING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/**
 * The tablist's roving-focus keydown handler, bound on `<nav>` rather than on `.sp-rail__tablist`
 * itself — deliberately, because it has to catch keydown bubbling up from 深度工具's folded tabs too,
 * and those now live in a DOM sibling of the tablist (see the template's file-header note), not a
 * descendant of it. Bubbling reaches a common ancestor either way; `<nav>` is the nearest one both
 * subtrees share.
 *
 * WHICH IS WHY THE FIRST THING IT DOES IS CHECK WHERE THE EVENT CAME FROM. `<nav>` also contains
 * 深度工具's disclosure `<button>` — the control this wave deliberately moved OUT of the tablist
 * precisely so it would stop being part of the tab widget. Without this gate that move only took
 * effect in the accessibility tree, never in behaviour: a reader who Tabs off the roving stop lands on
 * the disclosure (it is the very next thing in the tab order), presses ArrowDown to open it — the most
 * natural gesture there is — and instead has focus yanked into the tablist, with `preventDefault()`
 * eating the scroll on the way. The disclosure pattern does not allow a disclosure to swallow those
 * keys, and neither does anything else in `<nav>`.
 */
function handleTablistKeydown(event: KeyboardEvent): void {
  const source = event.target instanceof Element ? event.target : null
  if (!source || !source.closest('button[role="tab"]')) return
  if (!ROVING_KEYS.has(event.key)) return
  const tabs = focusableTabs()
  if (tabs.length === 0) return
  const currentIndex = tabs.findIndex((tab) => tab === document.activeElement)
  let nextIndex: number
  if (event.key === 'Home') {
    nextIndex = 0
  } else if (event.key === 'End') {
    nextIndex = tabs.length - 1
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
    nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % tabs.length
  } else {
    // ArrowUp / ArrowLeft
    nextIndex = currentIndex < 0 ? tabs.length - 1 : (currentIndex - 1 + tabs.length) % tabs.length
  }
  // A key this handler claims must not also scroll the page (Up/Down/Home/End all do, natively).
  event.preventDefault()
  const target = tabs[nextIndex]
  // MANUAL ACTIVATION (F-ACT): move the focus and the roving stop, select NOTHING. `data-rail-key`
  // carries the business key rather than the handler re-deriving it from `data-testid` — a test id is
  // a test id, and having production keyboard behaviour silently depend on its spelling is how a
  // rename becomes a dead key that only the keyboard path notices.
  const key = target.getAttribute('data-rail-key')
  if (key) focusedKey.value = key
  target.focus()
}

/**
 * `aria-orientation` FOLLOWS THE BREAKPOINT rather than being asserted once.
 *
 * The first cut hard-coded 「vertical」 while the `@media (max-width: 899px)` block below lays the
 * same tablist out as a horizontal strip — so on a narrow screen the page announced an orientation
 * it did not have, and a screen reader would offer the wrong arrow keys for it. The width query is
 * the SAME one the stylesheet uses; keeping the two literals side by side is deliberate, since a
 * breakpoint that moved in only one of them is exactly the drift this fixes.
 *
 * `useMobileViewport` is the repo's existing guarded wrapper: `window.matchMedia` is undefined under
 * jsdom and SSR, and it answers 「not narrow」 there, so the default stays 「vertical」 — which is what
 * every existing assertion reads.
 */
const RAIL_NARROW_QUERY = '(max-width: 899px)'
const { isMobile: railIsNarrow } = useMobileViewport(RAIL_NARROW_QUERY)
const orientation = computed<'vertical' | 'horizontal'>(() => (railIsNarrow.value ? 'horizontal' : 'vertical'))
</script>

<style scoped>
.sp-rail {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  padding: var(--ms-space-2) var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.sp-rail__tablist {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-rail__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sp-rail__group-title {
  margin: 0 0 2px;
  padding: 0 var(--ms-space-2);
  color: var(--ms-text-3);
  font-size: 12px;
  font-weight: var(--ms-font-weight-title);
  letter-spacing: 0.04em;
}

.sp-rail__tab {
  display: block;
  width: 100%;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0 6px 6px 0;
  background: transparent;
  padding: var(--ms-space-2) var(--ms-space-2);
  color: var(--ms-text-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sp-rail__tab:hover {
  color: var(--ms-text-1);
  background: var(--ms-bg-page);
}

.sp-rail__tab--active {
  color: var(--ms-color-primary);
  border-left-color: var(--ms-color-primary);
  font-weight: var(--ms-font-weight-title);
}

.sp-rail__advanced {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sp-rail__disclosure {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  border: none;
  background: transparent;
  padding: var(--ms-space-2);
  color: var(--ms-text-3);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.sp-rail__disclosure:hover {
  color: var(--ms-text-1);
}

.sp-rail__advanced-panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: var(--ms-space-2);
}

/* 默认收起, FOR REAL. The rule above is author-origin and scoped, so it outranks the UA stylesheet's
   `[hidden] { display: none }` on both origin and specificity — without this line the `hidden`
   attribute on the panel is inert and the seven folded tabs stay painted, focusable and announced.
   Written as an explicit `[hidden]` branch of the SAME class rather than as a forced override, so
   the layout declaration and its off state live one line apart and cannot drift. */
.sp-rail__advanced-panel[hidden] {
  display: none;
}

.sp-rail__tab--advanced {
  font-size: 13px;
}

/* 窄屏:左栏折成顶部横排。DOM 不变 —— 仍是同一个 tablist、同一批 tab；深度工具的折叠区留在下面一整行。 */
@media (max-width: 899px) {
  .sp-rail__tablist {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--ms-space-2);
  }

  .sp-rail__group {
    flex: 1 1 auto;
  }

  .sp-rail__tab {
    border-left: none;
    border-bottom: 2px solid transparent;
    border-radius: 6px 6px 0 0;
  }

  .sp-rail__tab--active {
    border-left-color: transparent;
    border-bottom-color: var(--ms-color-primary);
  }
}
</style>
