<template>
  <div class="sp-home" data-testid="stock-prep-operator-home">
    <!-- 指引位 — the ONE guidance sentence this page ever shows at once (§3 wireframe A ③). Rendered
         only when something is actually waiting; when nothing is, the `nothing_today` empty state
         below carries that same sentence as its title instead of saying it twice. -->
    <p
      v-if="guidance"
      class="sp-home__guidance"
      data-testid="stock-prep-operator-home-guidance"
    >
      {{ guidance }}
    </p>

    <EmptyState
      v-if="emptyState"
      class="sp-home__empty"
      :data-testid="'stock-prep-operator-home-empty'"
      :data-empty-state="emptyState"
      :title="emptyStateText.title"
      :hint="emptyStateText.hint"
    >
      <template v-if="emptyState !== 'nothing_today'" #action>
        <button type="button" class="sp-home__link" @click="focusQuickOpen">
          {{ bi('拉一个新项目', 'Pull a new project in') }}
        </button>
      </template>
    </EmptyState>

    <!-- 一级常驻筛选 — a row of four count buttons (§3 wireframe A ④), never a dropdown. No chip
         pressed shows every card; pressing one narrows the grid to that state alone. -->
    <div v-if="cards.length > 0" class="sp-home__filters" data-testid="stock-prep-operator-home-filters">
      <button
        v-for="filter in filters"
        :key="filter.key"
        type="button"
        class="sp-home__filter"
        :class="{ 'sp-home__filter--active': activeFilter === filter.key }"
        :data-testid="`stock-prep-operator-home-filter-${filter.key}`"
        @click="toggleFilter(filter.key)"
      >
        {{ filter.label }} {{ filter.count }}
      </button>
    </div>

    <div v-if="cards.length > 0" class="sp-home__cards" data-testid="stock-prep-operator-home-cards">
      <article
        v-for="card in visibleCards"
        :key="card.projectNo"
        class="sp-home__card"
        data-testid="stock-prep-operator-home-card"
        :data-project-no="card.projectNo"
        :data-posture="card.posture.key"
      >
        <header class="sp-home__card-head">
          <span class="sp-home__card-no">{{ card.projectNo }}</span>
          <span v-if="card.projectName" class="sp-home__card-name">{{ card.projectName }}</span>
          <span
            class="sp-home__badge"
            :class="`sp-home__badge--${card.posture.tone}`"
            data-testid="stock-prep-operator-home-card-badge"
          >{{ bi(card.posture.zh, card.posture.en) }}</span>
        </header>
        <p v-if="card.source === 'memory'" class="sp-home__card-note">
          {{ bi('这台电脑上最近开过的', 'Recently opened on this computer') }}
        </p>
        <div class="sp-home__card-actions">
          <button
            type="button"
            class="sp-home__card-action"
            data-testid="stock-prep-operator-home-card-action"
            :disabled="exportingProjectNo === card.projectNo"
            @click="onCardAction(card)"
          >
            {{ cardActionLabel(card) }}
          </button>
        </div>
        <p
          v-if="exportError && exportError.projectNo === card.projectNo"
          class="sp-home__card-error"
          data-testid="stock-prep-operator-home-card-error"
        >
          {{ bi(exportError.zh, exportError.en) }}
        </p>
      </article>
    </div>

    <!-- 兜底输入框 — F1 means the two sources above can never be guaranteed complete; typing a number
         directly always works regardless of what the directory or this browser's own memory hold. -->
    <div class="sp-home__quick-open" data-testid="stock-prep-operator-home-quick-open">
      <label class="sp-home__field">
        <span>{{ bi('项目号(可按号码或名称搜)', 'Project no. (search by number or name)') }}</span>
        <input
          ref="quickOpenInputEl"
          v-model="quickOpenInput"
          type="text"
          list="stock-prep-board-directory-options"
          data-testid="stock-prep-operator-home-quick-open-input"
          :placeholder="bi('项目号或名称', 'Project number or name')"
          @keyup.enter="onQuickOpen"
        >
      </label>
      <button
        type="button"
        class="sp-home__quick-open-button"
        data-testid="stock-prep-operator-home-quick-open-button"
        :disabled="quickOpenInput.trim().length === 0"
        @click="onQuickOpen"
      >
        {{ bi('打开这个项目', 'Open this project') }}
      </button>
      <p class="sp-home__quick-open-hint">
        {{ bi(
          '找不到号码?列表里只有这台电脑最近开过的、和管理员归档过的项目。',
          'Cannot find the number? The list above only holds projects this computer recently opened, or that an administrator has archived.',
        ) }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
// 今天要处理 (P0-2) — the operator's task-oriented landing page, mounted by
// StockPreparationProjectBoardView.vue whenever no project number is open yet (§2.3: 寄生 in the
// existing `project-board` tab, ZERO tab-structure change).
//
// DATA SOURCE (D1=A). "目录 + 本机记忆两路并集" — the directory this component is HANDED (already
// loaded once by the parent; this component makes NO fetch of its own, so a predread failure there
// is silently absorbed exactly once, not doubled) unioned with `operatorHomeMemory.ts`'s per-browser
// memory of projects this computer has opened before. See `operatorHomeCards.ts` for the merge.
//
// NO NEW READ ON THIS SCREEN, except the one action that IS a real write-shaped user click: exporting
// a 「可以导出」 card's materials directly from its card (H14 discipline — a button that says
// 导出物料清单 must actually export, not merely navigate to a page that could).
import { computed, nextTick, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import EmptyState from '../../status/EmptyState.vue'
import type { IntegrationScope } from '../../../services/integration/workbench'
import type { StockPreparationOperatorDirectory } from '../../../services/integration/stockPreparation/confirmationQueue'
import { exportStockPreparationPrepLines } from '../../../services/integration/stockPreparation/confirmationQueue'
import { readStockPrepRecentProjects } from '../../../services/integration/stockPreparation/operatorHomeMemory'
import {
  buildOperatorHomeCards,
  countOperatorHomeCardsByFilter,
  resolveOperatorHomeEmptyState,
  sortOperatorHomeCards,
  STOCK_PREP_HOME_FILTER_KEYS,
  type StockPrepHomeCard,
  type StockPrepHomeFilterKey,
} from '../../../services/integration/stockPreparation/operatorHomeCards'

const props = withDefaults(
  defineProps<{
    scope?: IntegrationScope
    /** Loaded once by the parent (StockPreparationProjectBoardView.vue) — this component fetches nothing. */
    directory?: StockPreparationOperatorDirectory | null
    /** False only while the parent's very first directory read is still in flight (avoids a one-tick
     *  flash of `directory_unavailable` on every mount). True once that read has settled either way. */
    directoryLoaded?: boolean
  }>(),
  { scope: () => ({}), directory: null, directoryLoaded: false },
)

const emit = defineEmits<{
  /** Open this project's workspace — mirrors the board's own search box. */
  (e: 'open-project', projectNo: string): void
  /** Open the project AND land directly in the confirmation queue, seeded with its number. */
  (e: 'open-project-in-queue', projectNo: string): void
}>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const directoryProjects = computed(() => {
  const list = props.directory?.projects
  return Array.isArray(list) ? list : []
})

/** Read once per mount — the memory this browser has of projects opened before. */
const memory = ref(readStockPrepRecentProjects())

const cards = computed<StockPrepHomeCard[]>(() => sortOperatorHomeCards(
  buildOperatorHomeCards(directoryProjects.value, memory.value),
))

const actionableCount = computed(() => countOperatorHomeCardsByFilter(cards.value, 'pending_decision')
  + countOperatorHomeCardsByFilter(cards.value, 'blocked'))

const directoryAvailable = computed(() => !props.directoryLoaded || props.directory !== null)

const emptyState = computed(() => resolveOperatorHomeEmptyState({
  directoryAvailable: directoryAvailable.value,
  cardCount: cards.value.length,
  actionableCount: actionableCount.value,
}))

const EMPTY_STATE_TEXT: Record<string, { title: [string, string]; hint: [string, string] }> = {
  no_projects: {
    title: ['这里还没有您的项目', 'There is nothing here for you yet'],
    hint: [
      '备料从"把项目从 PLM 拉进来"开始。知道项目号就可以自己拉。',
      'Stock preparation starts by pulling a project in from PLM — if you know the number you can pull it in yourself.',
    ],
  },
  nothing_today: {
    title: ['今天没有等您的事', 'Nothing is waiting on you today'],
    hint: [
      '下面是您最近开过的项目,随时可以打开看看。',
      'Below are the projects you have opened recently — open any of them whenever you like.',
    ],
  },
  directory_unavailable: {
    title: ['项目清单暂时读不到', 'The project list could not be read right now'],
    hint: ['这不影响您用项目号直接打开。', 'That does not stop you from opening a project directly by its number.'],
  },
}

const emptyStateText = computed(() => {
  const state = emptyState.value
  const entry = state ? EMPTY_STATE_TEXT[state] : null
  if (!entry) return { title: '', hint: '' }
  return { title: bi(...entry.title), hint: bi(...entry.hint) }
})

/** 指引位: only rendered when there is something to say — the empty states above cover "nothing". */
const guidance = computed<string | null>(() => {
  if (emptyState.value) return null
  const top = cards.value.find((card) => card.posture.key === 'pending_decision' || card.posture.key === 'blocked')
  if (!top) return null
  const n = actionableCount.value
  return bi(
    `今天有 ${n} 个项目在等您。先处理最上面这个:${top.posture.zh}。`,
    `${n} project(s) are waiting on you today. Start with the one on top: ${top.posture.en}.`,
  )
})

const FILTER_LABELS: Record<StockPrepHomeFilterKey, [string, string]> = {
  pending_decision: ['等您拿主意', 'Waiting on you'],
  blocked: ['卡住了', 'Blocked'],
  ready: ['可以导出', 'Ready to export'],
  not_pulled: ['还没拉过', 'Not pulled yet'],
}

const filters = computed(() => STOCK_PREP_HOME_FILTER_KEYS.map((key) => ({
  key,
  label: bi(...FILTER_LABELS[key]),
  count: countOperatorHomeCardsByFilter(cards.value, key),
})))

const activeFilter = ref<StockPrepHomeFilterKey | null>(null)

function toggleFilter(key: StockPrepHomeFilterKey): void {
  activeFilter.value = activeFilter.value === key ? null : key
}

const visibleCards = computed(() => (activeFilter.value === null
  ? cards.value
  : cards.value.filter((card) => card.posture.key === activeFilter.value)))

function cardActionLabel(card: StockPrepHomeCard): string {
  if (card.posture.key === 'pending_decision') {
    const n = card.pendingDecisionCount
    return n && n > 0
      ? bi(`去处理这 ${n} 件事`, `Handle these ${n} now`)
      : bi('去处理这些事', 'Handle these now')
  }
  if (card.posture.key === 'blocked') return bi('看缺哪些件', 'See which parts are missing')
  if (card.posture.key === 'ready') return bi('导出物料清单(Excel)', 'Export materials (Excel)')
  return bi('打开这个项目', 'Open this project')
}

function onCardAction(card: StockPrepHomeCard): void {
  if (card.posture.key === 'pending_decision') {
    emit('open-project-in-queue', card.projectNo)
    return
  }
  if (card.posture.key === 'ready') {
    void exportCard(card.projectNo)
    return
  }
  emit('open-project', card.projectNo)
}

const exportingProjectNo = ref<string | null>(null)
const exportError = ref<{ projectNo: string; zh: string; en: string } | null>(null)

/** The same authenticated-Blob download trigger StockPreparationProjectBoardView.vue uses (#5437). */
function triggerExportDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function exportCard(projectNo: string): Promise<void> {
  exportError.value = null
  exportingProjectNo.value = projectNo
  try {
    const result = await exportStockPreparationPrepLines({ ...props.scope, projectNo })
    triggerExportDownload(result.blob, result.filename)
  } catch {
    // A generic, values-free failure line — this button is a genuine write-shaped click (G3), so it
    // gets a visible answer, unlike the silent predreads elsewhere on this page.
    exportError.value = {
      projectNo,
      zh: '文件没有下载成功,数据没有变化。稍后再点一次;还是不行就找管理员。',
      en: 'The file did not download; nothing changed. Try again shortly, or ask an administrator if it keeps failing.',
    }
  } finally {
    exportingProjectNo.value = null
  }
}

const quickOpenInput = ref('')
const quickOpenInputEl = ref<HTMLInputElement | null>(null)

function onQuickOpen(): void {
  const target = quickOpenInput.value.trim()
  if (!target) return
  emit('open-project', target)
}

async function focusQuickOpen(): Promise<void> {
  await nextTick()
  quickOpenInputEl.value?.focus()
}
</script>

<style scoped>
.sp-home {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}

.sp-home__guidance {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font-size: 13px;
  line-height: 1.7;
}

.sp-home__empty {
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.sp-home__link {
  border: none;
  background: none;
  padding: 0;
  color: var(--ms-color-primary, #1677ff);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}

.sp-home__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.sp-home__filter {
  padding: 6px 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-home__filter--active {
  border-color: var(--ms-color-primary);
  color: var(--ms-color-primary);
  font-weight: var(--ms-font-weight-title, 600);
}

.sp-home__cards {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-home__card {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.sp-home__card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
}

.sp-home__card-no {
  font-weight: var(--ms-font-weight-title, 600);
  color: var(--ms-text-1);
}

.sp-home__card-name {
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-home__badge {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: var(--ms-font-weight-title, 600);
}

.sp-home__badge--warning { background: color-mix(in srgb, var(--ms-color-warning) 16%, transparent); color: var(--ms-color-warning); }
.sp-home__badge--danger { background: color-mix(in srgb, var(--ms-color-danger) 16%, transparent); color: var(--ms-color-danger); }
.sp-home__badge--primary { background: color-mix(in srgb, var(--ms-color-primary) 16%, transparent); color: var(--ms-color-primary); }
.sp-home__badge--success { background: color-mix(in srgb, var(--ms-color-success) 16%, transparent); color: var(--ms-color-success); }
.sp-home__badge--info { background: color-mix(in srgb, var(--ms-color-info) 20%, transparent); color: var(--ms-color-info); }
.sp-home__badge--neutral { background: var(--ms-bg-page); color: var(--ms-text-3); }

.sp-home__card-note {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-home__card-actions {
  display: flex;
}

.sp-home__card-action {
  padding: 7px 14px;
  border: 1px solid var(--ms-color-primary);
  border-radius: 6px;
  background: var(--ms-color-primary);
  color: #fff;
  font: inherit;
  font-weight: var(--ms-font-weight-title, 600);
  cursor: pointer;
}

.sp-home__card-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sp-home__card-error {
  margin: 0;
  color: var(--ms-color-danger);
  font-size: 12px;
}

.sp-home__quick-open {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-3);
  padding: var(--ms-space-3);
  border: 1px dashed var(--ms-border-light);
  border-radius: 8px;
}

.sp-home__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.sp-home__field input {
  min-width: 240px;
  padding: 6px 8px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  font: inherit;
}

.sp-home__quick-open-button {
  padding: 7px 14px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
  font: inherit;
  cursor: pointer;
}

.sp-home__quick-open-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.sp-home__quick-open-hint {
  flex-basis: 100%;
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
}
</style>
