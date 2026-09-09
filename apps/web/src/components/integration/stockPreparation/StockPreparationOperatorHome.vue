<template>
  <div class="sp-home" data-testid="stock-prep-operator-home">
    <!-- G4 诚实态: while the FIRST directory read is still in flight this page knows nothing, so it
         says nothing about the world. Not an empty state — 「这里还没有您的项目」 is a positive claim,
         and making it here would be asserting something that has not been checked. -->
    <p
      v-if="!directorySettled"
      class="sp-home__loading"
      data-testid="stock-prep-operator-home-loading"
      role="status"
    >
      {{ bi('正在读取您的项目清单…', 'Reading your project list…') }}
    </p>

    <!-- 指引位 — the ONE guidance sentence this page ever shows at once (§3 wireframe A ③). Rendered
         only when something LIVE is actually waiting; when nothing is, the `nothing_today` empty state
         below carries that same sentence as its title instead of saying it twice. -->
    <p
      v-else-if="guidance"
      class="sp-home__guidance"
      data-testid="stock-prep-operator-home-guidance"
    >
      {{ guidance }}
    </p>

    <!-- U2 契约 (P0 补项 5) — at most ONE of three sentences, in this order, and ONLY when the
         directory explicitly says so (an older backend, or a directory that has not settled the union
         read yet, shows NONE of them — see `pullBanner`'s own comment for why `undefined` must never
         read as `false`). -->
    <p
      v-if="pullBanner"
      class="sp-home__pull-banner"
      data-testid="stock-prep-operator-home-pull-banner"
      :data-pull-banner="pullBanner.key"
    >
      {{ bi(pullBanner.text.zh, pullBanner.text.en) }}
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
        <button type="button" class="sp-home__link" @click="emit('focus-quick-open')">
          {{ bi('拉一个新项目', 'Pull a new project in') }}
        </button>
      </template>
    </EmptyState>

    <!-- 一级常驻筛选 — a row of five count buttons (§3 wireframe A ④), never a dropdown. -->
    <div v-if="cards.length > 0" class="sp-home__filters" data-testid="stock-prep-operator-home-filters">
      <button
        v-for="filter in filters"
        :key="filter.key"
        type="button"
        class="sp-home__filter"
        :class="{ 'sp-home__filter--active': activeFilter === filter.key }"
        :data-testid="`stock-prep-operator-home-filter-${filter.key}`"
        :aria-pressed="activeFilter === filter.key ? 'true' : 'false'"
        :title="filter.key === 'ready' ? bi(readyTooltip.zh, readyTooltip.en) : undefined"
        @click="toggleFilter(filter.key)"
      >
        {{ filter.label }} {{ filter.count }}
      </button>
    </div>

    <div v-if="cards.length > 0" class="sp-home__cards" data-testid="stock-prep-operator-home-cards">
      <!-- G2: pressing a chip whose count is 0 is a NEW empty condition, so it gets its own
           `data-empty-state` value and its own words rather than an empty box. -->
      <p
        v-if="visibleCards.length === 0"
        class="sp-home__filter-empty"
        data-testid="stock-prep-operator-home-filter-empty"
        data-empty-state="filter_empty"
      >
        {{ bi('这一类现在一个项目都没有。点上面的「全部」看回全部项目。', 'Nothing is in this group right now. Press 全部 above to see every project again.') }}
      </p>
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
        <p v-if="card.postureFromMemory" class="sp-home__card-note">
          {{ bi('这台电脑上最近开过的', 'Recently opened on this computer') }}
        </p>
        <p v-else-if="card.posture.key === 'unknown'" class="sp-home__card-note">
          {{ bi(
            '这台电脑还没打开过这个项目,进度看不到;打开一次就知道了。',
            'This computer has not opened this project yet, so its progress is not visible here — open it once to find out.',
          ) }}
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
          <!-- §3 wireframe A ⑥: the secondary 「打开」, present only where the primary does something
               ELSE. Where the primary already opens the project, a second button by that name would
               be two controls with one meaning. -->
          <button
            v-if="showsOpenButton(card)"
            type="button"
            class="sp-home__card-open"
            data-testid="stock-prep-operator-home-card-open"
            @click="emit('open-project', card.projectNo)"
          >
            {{ bi('打开', 'Open') }}
          </button>
        </div>
        <p
          v-if="exportNotice && exportNotice.projectNo === card.projectNo"
          class="sp-home__card-notice"
          :class="{ 'sp-home__card-notice--error': exportNotice.tone === 'error' }"
          :data-testid="exportNotice.tone === 'error'
            ? 'stock-prep-operator-home-card-error'
            : 'stock-prep-operator-home-card-export-empty'"
          role="status"
        >
          {{ bi(exportNotice.zh, exportNotice.en) }}
        </p>
      </article>
    </div>

    <!-- 兜底入口 (§3 wireframe A ⑦) — the HEADING AND THE HONEST SENTENCE only. The input itself is
         the workspace's own existing search box, which the parent renders immediately below this
         block instead of this component owning a second one: two boxes with byte-identical labels,
         placeholders and button text — which is what a private copy produced — is precisely the
         "不知道该点哪个" this redesign exists to remove. Its testids are therefore unchanged and the
         three existing specs that open a project through them keep working untouched. -->
    <div class="sp-home__quick-open" data-testid="stock-prep-operator-home-quick-open">
      <h3 class="sp-home__quick-open-title">{{ bi('拉一个新项目', 'Pull a new project in') }}</h3>
      <p class="sp-home__quick-open-hint">
        {{ bi(
          '找不到号码?列表里只有这台电脑最近开过的、和管理员归档过的项目。直接把号码打进去也一样能打开。',
          'Cannot find the number? The list only holds projects this computer recently opened, or that an administrator has archived — typing the number in directly always works too.',
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
// DATA SOURCE (D1=A). "目录 + 本机记忆两路并集" — both halves are HANDED to this component by the
// parent (which already loads the directory once and already owns the memory read, so a predread
// failure is absorbed exactly once, not doubled, and nothing here touches `localStorage` directly).
// See `operatorHomeCards.ts` for the per-field merge and why a directory row does NOT simply win.
//
// NO NEW READ ON THIS SCREEN, except the one action that IS a real write-shaped user click: exporting
// a 「可以导出」 card's materials directly from its card (H14 discipline — a button that says
// 导出物料清单 must actually export, not merely navigate to a page that could).
//
// G1 ON THIS SCREEN. §1.2's falsifiable criterion is "任一屏截图里 --ms-color-primary 填充的按钮 ≤ 1",
// while §3 wireframe A draws a ★ on every card. Rather than leave that contradiction for a reviewer
// to re-litigate, the card CTA is an OUTLINED accent button — emphasised, unmistakably the card's
// main action, and not a `--ms-color-primary` fill. The criterion then holds literally on this screen
// too (zero filled primaries), and the one filled primary in the whole tab stays where §3 wireframe C
// ③ puts it: the workspace's 「下一步」 bar.
import { computed, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import EmptyState from '../../status/EmptyState.vue'
import type { IntegrationScope } from '../../../services/integration/workbench'
import type { StockPreparationOperatorDirectory } from '../../../services/integration/stockPreparation/confirmationQueue'
import { exportStockPreparationPrepLines } from '../../../services/integration/stockPreparation/confirmationQueue'
import type { StockPrepRecentProjectEntry } from '../../../services/integration/stockPreparation/operatorHomeMemory'
import {
  buildOperatorHomeCards,
  countActionableOperatorHomeCards,
  countOperatorHomeCardsByFilter,
  filterOperatorHomeCards,
  resolveOperatorHomeEmptyState,
  sortOperatorHomeCards,
  stockPrepHomeStatusLabel,
  STOCK_PREP_HOME_FILTER_KEYS,
  type StockPrepHomeCard,
  type StockPrepHomeFilterKey,
} from '../../../services/integration/stockPreparation/operatorHomeCards'
import {
  resolveStockPrepPullBanner,
  STOCK_PREP_TOOLTIP_READY_TO_EXPORT,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(
  defineProps<{
    scope?: IntegrationScope
    /** Loaded once by the parent (StockPreparationProjectBoardView.vue) — this component fetches nothing. */
    directory?: StockPreparationOperatorDirectory | null
    /** False only while the parent's very first directory read is still in flight. True once it has
     *  settled either way — the two are different facts and this page says different things for them. */
    directoryLoaded?: boolean
    /** This browser's memory of projects it opened before, read ONCE by the parent (D1=A's local half). */
    memory?: readonly StockPrepRecentProjectEntry[]
  }>(),
  { scope: () => ({}), directory: null, directoryLoaded: false, memory: () => [] },
)

const emit = defineEmits<{
  /** Open this project's workspace — mirrors the board's own search box. */
  (e: 'open-project', projectNo: string): void
  /** Open the project AND land directly in the confirmation queue, seeded with its number. */
  (e: 'open-project-in-queue', projectNo: string): void
  /** Put the cursor in the fallback input the parent renders into this component's own slot. */
  (e: 'focus-quick-open'): void
}>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const directoryProjects = computed(() => {
  const list = props.directory?.projects
  return Array.isArray(list) ? list : []
})

const cards = computed<StockPrepHomeCard[]>(() => sortOperatorHomeCards(
  buildOperatorHomeCards(directoryProjects.value, props.memory ?? []),
))

const actionable = computed(() => countActionableOperatorHomeCards(cards.value))

const directorySettled = computed(() => props.directoryLoaded === true)
const directoryAvailable = computed(() => props.directory !== null)

const emptyState = computed(() => resolveOperatorHomeEmptyState({
  directorySettled: directorySettled.value,
  directoryAvailable: directoryAvailable.value,
  cardCount: cards.value.length,
  actionableCount: actionable.value.any,
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

/**
 * 指引位, worded as §4.1 I-1 words it: the badge phrase becomes a SENTENCE
 * (「有 2 件事等您拿主意」), not a label spliced into one. Driven by the LIVE actionable count only —
 * a remembered conclusion may have been resolved by a colleague on another machine, and 「今天有 N 个
 * 项目在等您」 is an assertion about right now.
 */
const guidance = computed<string | null>(() => {
  if (emptyState.value) return null
  const n = actionable.value.live
  if (n <= 0) return null
  const top = cards.value.find((card) => !card.postureFromMemory
    && (card.posture.key === 'pending_decision' || card.posture.key === 'blocked'))
  if (!top) return null
  const lead = top.posture.key === 'pending_decision'
    ? [
      `有 ${top.pendingDecisionCount ?? 0} 件事等您拿主意。`,
      `${top.pendingDecisionCount ?? 0} thing(s) need your call.`,
    ] as const
    : ['有零件在源系统里找不到,补齐之前写不进去。', 'Parts are missing in the source system; nothing can be written until they are fixed.'] as const
  return bi(
    `今天有 ${n} 个项目在等您。先处理最上面这个:${lead[0]}`,
    `${n} project(s) are waiting on you today. Start with the one on top: ${lead[1]}`,
  )
})

/** I-20: the 可以导出 filter chip's tooltip. */
const readyTooltip = STOCK_PREP_TOOLTIP_READY_TO_EXPORT

/**
 * U2 契约 (P0 补项 5)'s three-sentence priority chain — shared with 项目查询 (hardening wave, see
 * `resolveStockPrepPullBanner`'s own comment in plainLanguage.ts for the priority order and why every
 * check is `=== true` / `=== false` rather than a truthiness test, never restated here).
 */
const pullBanner = computed(() => resolveStockPrepPullBanner(props.directory))

const filters = computed(() => STOCK_PREP_HOME_FILTER_KEYS.map((key) => ({
  key,
  label: bi(...stockPrepHomeStatusLabel(key)),
  count: countOperatorHomeCardsByFilter(cards.value, key),
})))

const activeFilter = ref<StockPrepHomeFilterKey>('all')

function toggleFilter(key: StockPrepHomeFilterKey): void {
  activeFilter.value = activeFilter.value === key ? 'all' : key
}

const visibleCards = computed(() => filterOperatorHomeCards(cards.value, activeFilter.value))

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

/** True only where the card's own primary action goes somewhere OTHER than this project's workspace. */
function showsOpenButton(card: StockPrepHomeCard): boolean {
  return card.posture.key === 'pending_decision' || card.posture.key === 'ready'
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
const exportNotice = ref<{ projectNo: string; tone: 'error' | 'info'; zh: string; en: string } | null>(null)

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
  exportNotice.value = null
  exportingProjectNo.value = projectNo
  try {
    const result = await exportStockPreparationPrepLines({ ...props.scope, projectNo })
    triggerExportDownload(result.blob, result.filename)
    // The SAME sentence the workspace's own export uses for an empty result. A file that downloads
    // with nothing but headers, silently, is how somebody sends an empty sheet on to the next person.
    if (result.activeRowCount === 0) {
      exportNotice.value = {
        projectNo,
        tone: 'info',
        zh: '这个项目号下没有有效的物料行,已下载一份仅含表头的空白模板。',
        en: 'This project number has no active material rows — an empty, headers-only template was downloaded.',
      }
    }
  } catch {
    // A generic, values-free failure line — this button is a genuine write-shaped click (G3), so it
    // gets a visible answer, unlike the silent predreads elsewhere on this page.
    exportNotice.value = {
      projectNo,
      tone: 'error',
      zh: '文件没有下载成功,数据没有变化。稍后再点一次;还是不行就找管理员。',
      en: 'The file did not download; nothing changed. Try again shortly, or ask an administrator if it keeps failing.',
    }
  } finally {
    exportingProjectNo.value = null
  }
}
</script>

<style scoped>
.sp-home {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}

.sp-home__loading {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
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

/* U2 契约 (P0 补项 5): a diagnostic, not an alarm — same muted treatment as every other subordinate
   hint on this page (§4's 「不吓人」), never the danger/warning color used for a real blocker. */
.sp-home__pull-banner {
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
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

.sp-home__filter-empty {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
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
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

/* G1: an OUTLINED accent button, deliberately NOT a `--ms-color-primary` fill. See the script
   header for why the wireframe's per-card ★ is rendered this way. */
.sp-home__card-action {
  padding: 7px 14px;
  border: 1px solid var(--ms-color-primary);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-color-primary);
  font: inherit;
  font-weight: var(--ms-font-weight-title, 600);
  cursor: pointer;
}

.sp-home__card-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sp-home__card-open {
  padding: 7px 14px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
  font: inherit;
  cursor: pointer;
}

.sp-home__card-notice {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-home__card-notice--error {
  color: var(--ms-color-danger);
}

/* Open at the bottom on purpose: the parent renders the ONE project-number input directly beneath
   this block (see the template comment), and the two read as a single 「拉一个新项目」 card. */
.sp-home__quick-open {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  padding: var(--ms-space-3) var(--ms-space-3) var(--ms-space-2);
  border: 1px dashed var(--ms-border-light);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
}

.sp-home__quick-open-title {
  margin: 0;
  font-size: 13px;
  font-weight: var(--ms-font-weight-title, 600);
  color: var(--ms-text-1);
}

.sp-home__quick-open-hint {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
}
</style>
