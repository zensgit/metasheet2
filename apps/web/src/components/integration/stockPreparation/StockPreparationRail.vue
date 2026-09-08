<template>
  <!--
    THE RAIL IS STILL ONE TABLIST. 设计稿 §2.2 is a grouped, direction-flipping strip, not a different
    kind of navigation, so the widget that carries `role="tablist"` — now `.sp-rail__tablist`, an INNER
    `<div>` rather than `<nav>` itself (see the hardening-wave note below for why) — keeps its
    `data-testid="stock-prep-tabs"` and every tab keeps `role="tab"` + `data-testid="stock-prep-tab-${key}"`
    under its ORIGINAL key. That is the one invariant every existing suite reads by name, and it is
    unchanged by this file's restructuring.

    HARDENING WAVE (2026-09-08): `<nav>` used to BE the tablist. Two things nested under it turned out
    to leak into the tablist's ACCESSIBLE children despite living inside a `role="presentation"` group
    wrapper — presentation only prunes the WRAPPER's own box; a descendant that carries its own
    implicit role is re-parented UP to the nearest surviving ancestor, which was the tablist itself:

      * 深度工具's disclosure `<button>` has an implicit role of "button" (native, unremovable — ARIA
        forbids `role="presentation"` on a focusable element), so it was exposed as a tablist child
        that is not a tab. Fixed by making it a literal DOM sibling of the tablist rather than a
        descendant: `<nav>` is now a plain wrapper holding `.sp-rail__tablist` (the widget) and
        `.sp-rail__advanced` (the disclosure + its panel) SIDE BY SIDE, not one inside the other.
      * Each group heading `<p>` carries the HTML-AAM implicit role "paragraph", which is not
        presentational either, so it leaked the same way. Fixed by giving the heading its OWN explicit
        `role="presentation"` — it stays a visual DOM descendant of the tablist (for the CSS grouping),
        but is pruned from the accessibility tree individually rather than relying on its wrapper. The
        heading text is not lost: every tab in the group now points `aria-labelledby` at the heading's
        id AND its own, which is the same "borrow a presentational node's text" technique used to
        recover a caption after hiding it — see F-KB below for the reasoning this addresses.

    组标题不是 tab, twice over now: no `role="tab"`, no `stock-prep-tab-*` testid, AND (new) an explicit
    `role="presentation"` so it cannot leak into the tablist's accessible children the way a bare `<p>`
    would. `querySelectorAll('[data-testid^="stock-prep-tab-"]')` still enumerates only the real tabs.
  -->
  <nav
    ref="navEl"
    class="sp-rail"
    :aria-label="bi('备料视图', 'Stock preparation views')"
    @keydown="handleTablistKeydown"
  >
    <div
      class="sp-rail__tablist"
      role="tablist"
      :aria-orientation="orientation"
      data-testid="stock-prep-tabs"
      :aria-owns="advancedTabIdRefs || undefined"
    >
      <!--
        role="presentation" ON THE GROUP WRAPPERS remains the layout affordance it always was: it
        removes the wrapper's OWN box from the accessibility tree while leaving its `role="tab"`
        children owned by the tablist. What changed is that the heading inside each wrapper now ALSO
        carries its own `role="presentation"` (see the file header) rather than relying on the
        wrapper's alone — a `<p>` has its own implicit role and does not get pruned just because its
        parent is presentational.
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
        <button
          v-for="item in advancedGroup.advanced"
          :key="item.key"
          :id="`stock-prep-tab-${item.key}`"
          type="button"
          role="tab"
          class="sp-rail__tab sp-rail__tab--advanced"
          :class="{ 'sp-rail__tab--active': item.key === activeKey }"
          :data-testid="`stock-prep-tab-${item.key}`"
          :aria-selected="item.key === activeKey ? 'true' : 'false'"
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
// tabs — WAI-ARIA's tabs pattern, automatic-activation variant. Arrow-key movement both moves focus
// AND selects (the alternative the pattern allows, Enter/Space-to-activate, is not separately wired —
// it needs no code here, because every tab is a native `<button>`, and a native button already fires
// its `click` handler on Enter (keydown) and Space (keyup) with no listener of ours involved. So
// Enter/Space activate the FOCUSED tab either way; automatic activation is simply the model this file
// commits to for arrow-key movement itself.)
//
// F-KB — WHY BOTH ArrowUp/Down AND ArrowLeft/Right, AT EVERY WIDTH, RATHER THAN ONE PAIR PICKED BY
// `orientation`. The APG assigns Up/Down to a vertical tablist and Left/Right to a horizontal one, and
// this rail actually changes shape at the `@media (max-width: 899px)` breakpoint CSS decides — but the
// breakpoint is CSS-only and this component's own `orientation` ref is a best-effort mirror of it (see
// below), not a live readout of the cascade. Accepting all four arrow keys at every width is a strict
// SUPERSET of what either single pairing would cover, never a violation of it: a vertical layout that
// also answers Left/Right, or a horizontal one that also answers Up/Down, has not promised a reader
// anything the pattern forbids.
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
 *  while they live outside it in the DOM (see the template's file-header note on WHY). Native `hidden`
 *  already prunes them from the accessibility tree while folded, so this is inert-but-correct then and
 *  load-bearing once the panel opens. */
const advancedTabIdRefs = computed<string>(() => (
  advancedGroup.value ? advancedGroup.value.advanced.map((item) => `stock-prep-tab-${item.key}`).join(' ') : ''
))

/**
 * ROVING TABINDEX (F-KB). Exactly one tab is `tabindex="0"` at a time — the currently ACTIVE one,
 * which is what the automatic-activation model in this file collapses "focused" and "selected" into.
 * `activeKey` can legitimately name a tab this render is not currently showing (folded-and-collapsed,
 * most commonly), in which case nothing in the DOM may set `tabindex="0"` at all — and a tablist with
 * no roving stop is not reachable by Tab from outside it. The fallback is the FIRST tab in DOM order,
 * the same "nothing chosen yet" default the APG examples use.
 */
const rovingKey = computed<string | null>(() => {
  const flat: string[] = []
  for (const group of props.groups) {
    for (const item of group.items) flat.push(item.key)
  }
  if (advancedGroup.value && advancedOpen.value) {
    for (const item of advancedGroup.value.advanced) flat.push(item.key)
  }
  if (flat.length === 0) return null
  if (props.activeKey !== null && flat.includes(props.activeKey)) return props.activeKey
  return flat[0]
})

function selectTab(key: string): void {
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
 */
function handleTablistKeydown(event: KeyboardEvent): void {
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
  target.focus()
  const key = target.getAttribute('data-testid')?.replace('stock-prep-tab-', '')
  // AUTOMATIC ACTIVATION: moving focus selects. See the top-of-script note for why Enter/Space need
  // no separate handler here.
  if (key) selectTab(key)
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
