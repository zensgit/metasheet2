<template>
  <!--
    THE RAIL IS STILL ONE TABLIST. 设计稿 §2.2 是把横条竖过来并分组,不是换一种导航:容器保留
    `data-testid="stock-prep-tabs"` 与 `role="tablist"`(并宣告 aria 方向,见下方 `orientation` —— 竖排
    时 vertical,窄屏折成横排时 horizontal),每个条目保留 `role="tab"` 与
    `data-testid="stock-prep-tab-${key}"` 原名。这一条是让绝大多数既有断言不动的关键一招,也是
    "rail 本质仍是一组 tab"这句话在 DOM 上的兑现。

    组标题不是 tab:它没有 `role="tab"`,也没有 `stock-prep-tab-*` testid,因此
    `querySelectorAll('[data-testid^="stock-prep-tab-"]')` 数出来的仍然只有真正可点的视图。
  -->
  <nav
    class="sp-rail"
    role="tablist"
    :aria-orientation="orientation"
    data-testid="stock-prep-tabs"
    :aria-label="bi('备料视图', 'Stock preparation views')"
  >
    <!--
      role="presentation" ON THE GROUP WRAPPERS. A `tablist` owns `tab`s; the grouping this rail
      introduces puts two levels of `<div>` between them, and an un-neutralised wrapper makes the
      screen reader's enumeration of the tablist wrong (「1 of 3 groups」 instead of 「1 of 14 tabs」).
      `presentation` removes the box from the accessibility tree while leaving its children owned by
      the tablist, which is the whole point: the grouping is a VISUAL affordance, not a semantic one.
    -->
    <div
      v-for="group in groups"
      :key="group.group"
      role="presentation"
      class="sp-rail__group"
      :data-testid="`stock-prep-rail-group-${group.group}`"
    >
      <p class="sp-rail__group-title" :data-testid="`stock-prep-rail-group-title-${group.group}`">
        {{ bi(group.zh, group.en) }}
      </p>

      <button
        v-for="item in group.items"
        :key="item.key"
        type="button"
        role="tab"
        class="sp-rail__tab"
        :class="{ 'sp-rail__tab--active': item.key === activeKey }"
        :data-testid="`stock-prep-tab-${item.key}`"
        :aria-selected="item.key === activeKey ? 'true' : 'false'"
        @click="emit('select', item.key)"
      >
        {{ bi(item.zh, item.en) }}
      </button>

      <!--
        深度工具 — the legacy MVP tabs, FOLDED rather than retired (owner ruling: canUseLegacyMvpTabs
        unchanged, nothing goes offline). They are rendered and then HIDDEN with the `hidden`
        attribute rather than dropped with `v-if`, and that choice is load-bearing twice over:

          * `hidden` collapses for real — not painted, out of the tab order, out of the accessibility
            tree — so 「默认收起」 is honest; and
          * every existing suite that reaches a legacy tab by testid keeps working unchanged. Making
            the fold a `v-if` would have meant either expanding the disclosure in a dozen unrelated
            specs or deleting their assertions, and 「不得为迁就 rail 而删断言」 is the rule this wave
            was given.

        THE FIRST CUT OF THIS SHIPPED A FOLD THAT NEVER FOLDED. `hidden`'s entire effect comes from
        the UA stylesheet's `[hidden] { display: none }`, and the panel's own
        `.sp-rail__advanced-panel { display: flex }` — an AUTHOR-origin rule, and once Vue compiles
        the scope onto it a specificity-(0,2,0) one — beats it on both counts. Nothing in this repo
        supplies a forced global `[hidden]` reset as a backstop either. So the seven legacy tabs
        stayed painted, stayed in the tab order and stayed in the a11y tree while the toggle did
        nothing but flip ▾/▴. The explicit `[hidden]` rule in the style block below is what makes the
        attribute mean what this comment says; it is asserted at source level in R-03, because jsdom
        runs no cascade and a DOM assertion structurally cannot see this class of defect.
      -->
      <div v-if="group.advanced.length > 0" role="presentation" class="sp-rail__advanced">
        <button
          type="button"
          class="sp-rail__disclosure"
          data-testid="stock-prep-rail-advanced-toggle"
          :aria-expanded="advancedOpen ? 'true' : 'false'"
          @click="advancedOpen = !advancedOpen"
        >
          {{ bi('深度工具', 'Advanced tools') }}
          <span aria-hidden="true">{{ advancedOpen ? '▴' : '▾' }}</span>
        </button>
        <div
          role="presentation"
          class="sp-rail__advanced-panel"
          data-testid="stock-prep-rail-advanced-panel"
          :hidden="!advancedOpen"
        >
          <button
            v-for="item in group.advanced"
            :key="item.key"
            type="button"
            role="tab"
            class="sp-rail__tab sp-rail__tab--advanced"
            :class="{ 'sp-rail__tab--active': item.key === activeKey }"
            :data-testid="`stock-prep-tab-${item.key}`"
            :aria-selected="item.key === activeKey ? 'true' : 'false'"
            @click="emit('select', item.key)"
          >
            {{ bi(item.zh, item.en) }}
          </button>
        </div>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
// P1-1 (设计稿 §2.2 / §6.2) — 备料工作台的左栏。
//
// WHAT THIS COMPONENT DECIDES: nothing. It receives groups that are ALREADY filtered and labelled
// and renders them. Item visibility is decided by the access module's predicates, in the shell —
// 「侧栏项的可见性只能调既有/新增谓词,不得在组件里重算权限」 — so this file imports no permission
// helper, calls no permission probe and touches no auth composable at all. The matrix suite's F-06
// asserts exactly that, by reading this source.
//
// 窄屏 (§6.2 / R11): the fold to a horizontal strip is CSS-only (`@media (max-width: 899px)`).
// The container renders UNCONDITIONALLY in both shapes, which is exactly what R11 warns about —
// ApprovalCenterView shipped a conditionally-rendered split container that became a no-op div on
// narrow screens. A media query cannot do that, and it keeps `role="tablist"` true at every width.
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

defineProps<{
  groups: StockPreparationRailGroupView[]
  /** The key currently rendered by the panel — never the raw click state. */
  activeKey: string | null
}>()

const emit = defineEmits<{ (e: 'select', key: string): void }>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

/** 默认收起 (设计稿 §2.2). Per-mount state: a fold is a view preference, not shared shell state. */
const advancedOpen = ref(false)

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
  gap: var(--ms-space-3);
  padding: var(--ms-space-2) var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
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
  margin-top: 2px;
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

/* 窄屏:左栏折成顶部横排。DOM 不变 —— 仍是同一个 tablist、同一批 tab。 */
@media (max-width: 899px) {
  .sp-rail {
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
