<template>
  <section class="scp-code-help" data-testid="stock-prep-code-help">
    <h4 class="scp-code-help__title">{{ bi('错误码对照', 'Error code reference') }}</h4>
    <p class="scp-code-help__intro" data-testid="stock-prep-code-help-intro">
      {{ bi(
        '把系统里能报的每一个代码倒过来列一遍:代码的意思、下一步该做什么。日常不用记这些码 —— 遇到一个报错时,把代码或那句话粘到下面的搜索框里就行。',
        'Every code this system can raise, listed the other way round: what it means, and what to do next. You never need to memorise these — when one shows up, paste the code or the sentence into the search box below.',
      ) }}
    </p>

    <input
      v-model="query"
      type="search"
      class="scp-code-help__search"
      data-testid="stock-prep-code-help-search"
      :placeholder="bi('按代码或文案搜索…', 'Search by code or text…')"
      :aria-label="bi('搜索错误码', 'Search error codes')"
    >
    <p class="scp-code-help__count" data-testid="stock-prep-code-help-count">
      {{ bi(
        `共 ${allEntries.length} 条,当前显示 ${filteredEntries.length} 条。`,
        `${allEntries.length} total, ${filteredEntries.length} shown.`,
      ) }}
    </p>

    <ul v-if="filteredEntries.length > 0" class="scp-code-help__list" data-testid="stock-prep-code-help-list">
      <li
        v-for="entry in filteredEntries"
        :key="`${entry.group}:${entry.code}`"
        class="scp-code-help__row"
        data-testid="stock-prep-code-help-row"
        :data-code="entry.code"
        :data-group="entry.group"
      >
        <div class="scp-code-help__row-head">
          <strong>{{ bi(entry.zh, entry.en) }}</strong>
          <em class="scp-code-help__tag">{{ bi(entry.groupZh, entry.groupEn) }}</em>
        </div>
        <!-- 该怎么办 — present only where the source table carries one (StockPrepPlainEntry's own
             contract); rows without one (the three STOCK_PREP_ADMIN_ACTION_PLAIN outcomes) omit this
             line rather than render an empty one. -->
        <small v-if="entry.zhNext" class="scp-code-help__hint" data-testid="stock-prep-code-help-row-next">
          {{ bi(entry.zhNext, entry.enNext || '') }}
        </small>
        <code class="scp-code-help__token">{{ entry.code }}</code>
      </li>
    </ul>
    <p v-else class="scp-code-help__empty" data-testid="stock-prep-code-help-empty">
      {{ bi('没有代码或文案匹配这个搜索词。', 'No code or text matches this search.') }}
    </p>
  </section>
</template>

<script setup lang="ts">
// BOM备料 错误码对照抽屉 (P1-6, I-22) — the reverse-lookup drawer over `plainLanguage.ts`'s six
// code-keyed tables (see codeHelp.ts for exactly which six, and why).
//
// PURELY PRESENTATIONAL AND SELF-CONTAINED. This panel takes no props and issues no fetch: every row
// it can ever render is `stockPrepCodeHelpEntries()`, a pure function over committed constants. That
// is what makes it mountable standalone (no scope, no auth context) and what makes it safe to mount
// twice on the same page in a later wave (design's own plan: this instance lives at the foot of the
// install page today; a P1-1 「帮助」rail entry reuses the SAME component later) — two instances share
// no state and cannot disagree.
//
// ZERO BACKEND, ZERO NEW VALUE SURFACE. Every field rendered here traces to a `plainLanguage.ts`
// constant or to the code/id key itself — both authored, committed strings. Nothing here reads a
// prop, a response body, or a store, so no customer value can reach this panel even by mistake.
import { computed, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { stockPrepCodeHelpEntries, stockPrepCodeHelpSearch } from '../../../services/integration/stockPreparation/codeHelp'

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

// Computed once — the source tables are `Object.freeze`d module-level constants, so this list never
// changes across the panel's lifetime; recomputing it on every keystroke would be pure waste.
const allEntries = stockPrepCodeHelpEntries()

const query = ref('')
const filteredEntries = computed(() => stockPrepCodeHelpSearch(allEntries, query.value))
</script>

<style scoped>
.scp-code-help {
  margin: 0;
}

.scp-code-help__title {
  margin: 0 0 var(--ms-space-2);
  font-size: 14px;
  color: var(--ms-text-1);
}

.scp-code-help__intro {
  margin: 0 0 var(--ms-space-2);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.scp-code-help__search {
  box-sizing: border-box;
  width: 100%;
  max-width: 360px;
  padding: 4px 8px;
  border: 1px solid var(--ms-border);
  border-radius: 4px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font-size: 13px;
}

.scp-code-help__count {
  margin: var(--ms-space-2) 0;
  color: var(--ms-text-3);
  font-size: 12px;
}

.scp-code-help__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.scp-code-help__row {
  padding: var(--ms-space-2) 0;
  border-top: 1px solid var(--ms-border-light);
}

.scp-code-help__row:first-child {
  border-top: none;
}

.scp-code-help__row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
}

.scp-code-help__row-head strong {
  color: var(--ms-text-1);
  font-size: 13px;
}

.scp-code-help__tag {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-3);
  font-size: 11px;
  font-style: normal;
}

.scp-code-help__hint {
  display: block;
  margin-top: 2px;
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.6;
}

.scp-code-help__token {
  display: block;
  margin-top: 2px;
  color: var(--ms-text-3);
  font-size: 11px;
  word-break: break-all;
}

.scp-code-help__empty {
  margin: var(--ms-space-2) 0 0;
  color: var(--ms-text-3);
  font-size: 13px;
}
</style>
