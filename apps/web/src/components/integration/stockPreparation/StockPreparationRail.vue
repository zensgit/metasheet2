<template>
  <!--
    THE RAIL IS STILL ONE TABLIST. 设计稿 §2.2 是把横条竖过来并分组,不是换一种导航:容器保留
    `data-testid="stock-prep-tabs"` 与 `role="tablist"`(加上 `aria-orientation="vertical"`),每个条目
    保留 `role="tab"` 与 `data-testid="stock-prep-tab-${key}"` 原名。这一条是让绝大多数既有断言不动的
    关键一招,也是"rail 本质仍是一组 tab"这句话在 DOM 上的兑现。

    组标题不是 tab:它没有 `role="tab"`,也没有 `stock-prep-tab-*` testid,因此
    `querySelectorAll('[data-testid^="stock-prep-tab-"]')` 数出来的仍然只有真正可点的视图。
  -->
  <nav
    class="sp-rail"
    role="tablist"
    aria-orientation="vertical"
    data-testid="stock-prep-tabs"
    :aria-label="bi('备料视图', 'Stock preparation views')"
  >
    <div
      v-for="group in groups"
      :key="group.group"
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

          * `hidden` is a real collapse — the browser does not paint them, they leave the tab order
            and they leave the accessibility tree — so 「默认收起」 is honest; and
          * every existing suite that reaches a legacy tab by testid keeps working unchanged. Making
            the fold a `v-if` would have meant either expanding the disclosure in a dozen unrelated
            specs or deleting their assertions, and 「不得为迁就 rail 而删断言」 is the rule this wave
            was given.
      -->
      <div v-if="group.advanced.length > 0" class="sp-rail__advanced">
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
import { ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'

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
