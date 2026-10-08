<template>
  <details class="scp-code-help" data-testid="stock-prep-code-help">
    <summary class="scp-code-help__summary" data-testid="stock-prep-code-help-summary">
      <h4 class="scp-code-help__title">{{ bi('错误码对照', 'Error code reference') }}</h4>
      <span class="scp-code-help__summary-hint">
        {{ bi(
          `手里有一个报错代码时再展开 —— 共收录 ${allEntries.length} 条`,
          `${allEntries.length} entries — open this when you have a code in hand`,
        ) }}
      </span>
    </summary>

    <p class="scp-code-help__intro" data-testid="stock-prep-code-help-intro">
      {{ bi(
        `这里把报错码、建表与源预检的阻断和提醒、拉取与试算的结果原因、管理员动作结果倒过来列了一遍,共 ${allEntries.length} 条:代码的意思、下一步该做什么。日常不用记这些码 —— 遇到一个报错时,把代码或那句话粘到下面的搜索框里就行。这不是全系统所有代码的全集。`,
        `The ${allEntries.length} codes this reference covers, listed the other way round — errors, install and source-readiness blockers and warnings, pull/plan outcome reasons, and admin action outcomes: what each means, and what to do next. You never need to memorise these — when one shows up, paste the code or the sentence into the search box below. This is not every code in the whole system.`,
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
        <!-- The CODE leads the row. §4.6 points at views/IntegrationHelpView.vue as the pattern, and
             that table puts the machine code in the first column for the same reason: this is a
             REVERSE lookup — the reader arrives holding the key, so the key is what they scan for. -->
        <div class="scp-code-help__row-head">
          <code class="scp-code-help__token">{{ entry.code }}</code>
          <em class="scp-code-help__tag">{{ bi(entry.groupZh, entry.groupEn) }}</em>
        </div>
        <strong class="scp-code-help__what">{{ bi(entry.zh, entry.en) }}</strong>
        <!-- 该怎么办 — present only where the source table carries one (StockPrepPlainEntry's own
             contract); rows without one (e.g. the three STOCK_PREP_ADMIN_ACTION_PLAIN outcomes) omit
             this line rather than render an empty one. The guard reads BOTH languages: a future entry
             with only an `enNext` would otherwise vanish from the English site too, and one with only
             a `zhNext` would render an empty line there. -->
        <small
          v-if="entry.zhNext || entry.enNext"
          class="scp-code-help__hint"
          data-testid="stock-prep-code-help-row-next"
        >
          {{ bi(entry.zhNext || '', entry.enNext || '') }}
        </small>
      </li>
    </ul>
    <!-- G4 诚实态: an empty result here means "not in THIS reference", never "no such code". The
         difference is the whole point — an admin who searches a real code from a support thread and
         reads "没有" would conclude they misread it. `data-empty-state` per G2. -->
    <p
      v-else
      class="scp-code-help__empty"
      data-testid="stock-prep-code-help-empty"
      data-empty-state="code-help-no-match"
    >
      {{ bi(
        '这份对照里没有代码或文案匹配这个搜索词 —— 这不代表这个代码不存在。没收录的码,请把整条报错原样交给管理员。',
        'Nothing in THIS reference matches that search — which does not mean the code does not exist. For a code not covered here, hand the whole error line to an administrator as-is.',
      ) }}
    </p>
  </details>
</template>

<script setup lang="ts">
// BOM备料 错误码对照抽屉 (P1-6, I-22) — the reverse-lookup drawer over the `plainLanguage.ts` tables
// whose codes actually reach a person as bare text (see codeHelp.ts for exactly which, and why).
//
// A DRAWER, COLLAPSED BY DEFAULT. §2.4 P-7 / §6.2 P1-6 / §4.1 I-22 all name it one, and G6 bans
// `el-drawer`, not the affordance — so it is a native <details>. Collapsed matters: the row list is
// long by design, and P1-7 spent this page's whole height budget folding 「即将安装的内容」. A closed
// <details> still renders every row into the DOM, so nothing a spec reads by testid is affected.
//
// THE COPY MAKES A BOUNDED CLAIM. An earlier draft opened with "把系统里能报的每一个代码" — falsifiable
// on sight, since `plainLanguage.ts` has 20+ tables and this drawer reads seven. The intro now names
// which surfaces it covers and its own count, and the empty state says "not in THIS reference" rather
// than "no such code" (G4): an admin who pastes a real code from a support thread and reads 「没有」
// concludes they misread the code, which is the same misjudgement 「未检查 ≠ 没有」exists to prevent.
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
/* A native <details>. §2.4 P-7, §6.2 P1-6 and §4.1 I-22 all call this thing a 抽屉; G6 forbids
   `el-drawer`, not the affordance. Collapsed by default so 74 rows cost one line of page height on a
   page P1-7 just spent its budget shortening. */
.scp-code-help {
  margin: 0;
}

.scp-code-help__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.scp-code-help__summary::-webkit-details-marker {
  display: none;
}

.scp-code-help__summary::before {
  content: '▸';
  display: inline-block;
  width: 1em;
  color: var(--ms-text-3);
  transition: transform 0.12s ease;
}

.scp-code-help[open] > .scp-code-help__summary::before {
  transform: rotate(90deg);
}

.scp-code-help__summary:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.scp-code-help__summary-hint {
  color: var(--ms-text-3);
  font-size: 12px;
}

.scp-code-help__title {
  display: inline;
  margin: 0;
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

.scp-code-help__row-head > .scp-code-help__token {
  margin-top: 0;
  color: var(--ms-text-1);
  font-size: 12px;
}

.scp-code-help__tag {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--ms-bg-page);
  color: var(--ms-text-3);
  font-size: 11px;
  font-style: normal;
}

.scp-code-help__what {
  display: block;
  margin-top: 2px;
  color: var(--ms-text-1);
  font-size: 13px;
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
