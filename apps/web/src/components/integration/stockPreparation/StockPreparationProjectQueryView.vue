<template>
  <div class="sp-pq" data-testid="stock-prep-project-query">
    <!-- G4 诚实态,同首页:第一次目录读还在路上时,这一屏对世界一无所知,所以什么都不断言。
         「这里还没有您的项目」是一句正面主张,现在说它就是在替一个还没查过的事实背书。 -->
    <p
      v-if="!directorySettled"
      class="sp-pq__loading"
      data-testid="stock-prep-project-query-loading"
      role="status"
    >
      {{ bi('正在读取项目清单…', 'Reading the project list…') }}
    </p>

    <!-- U2 契约的三句中性提示,沿用首页那一份文案与优先级(见 pullBanner 的注释)。 -->
    <p
      v-if="pullBanner"
      class="sp-pq__banner"
      data-testid="stock-prep-project-query-pull-banner"
      :data-pull-banner="pullBanner.key"
    >
      {{ bi(pullBanner.text.zh, pullBanner.text.en) }}
    </p>

    <div class="sp-pq__split">
      <!-- ─── 左栏:两级筛选 + 搜索 + 清单 ─────────────────────────────────────────── -->
      <section class="sp-pq__list-pane" :aria-label="bi('项目清单', 'Project list')">
        <div class="sp-pq__filters">
          <div
            class="sp-pq__chips"
            role="group"
            :aria-label="bi('按状态筛选', 'Filter by status')"
            data-testid="stock-prep-project-query-status-filters"
          >
            <button
              v-for="chip in statusChips"
              :key="chip.key"
              type="button"
              class="sp-pq__chip"
              :class="{ 'sp-pq__chip--active': status === chip.key }"
              :data-testid="`stock-prep-project-query-status-${chip.key}`"
              :aria-pressed="status === chip.key ? 'true' : 'false'"
              @click="selectStatus(chip.key)"
            >
              {{ chip.label }} {{ chip.count }}
            </button>
          </div>

          <div class="sp-pq__second-level">
            <label class="sp-pq__field">
              <span class="sp-pq__field-label">{{ bi('来源', 'Source') }}</span>
              <select
                v-model="source"
                class="sp-pq__select"
                data-testid="stock-prep-project-query-source"
                :disabled="!sourceAvailable"
                @change="writeUrlState()"
              >
                <option v-for="option in sourceOptions" :key="option.key" :value="option.key">
                  {{ option.label }}
                </option>
              </select>
            </label>
            <!-- G4:控件禁用了就得说为什么。「后端没提供来源」不是「所有项目都没有来源」。 -->
            <p
              v-if="!sourceAvailable"
              class="sp-pq__hint"
              data-testid="stock-prep-project-query-source-unavailable"
            >
              {{ bi(
                '后端未提供来源,这一项筛选用不了;清单本身不受影响。',
                'The backend did not report a source, so this filter is unavailable — the list itself is unaffected.',
              ) }}
            </p>

            <label class="sp-pq__field sp-pq__field--grow">
              <span class="sp-pq__field-label">{{ bi('搜索', 'Search') }}</span>
              <input
                v-model="search"
                type="search"
                class="sp-pq__input"
                data-testid="stock-prep-project-query-search"
                :placeholder="bi('项目号或名称的一部分', 'Part of a project number or name')"
                @input="writeUrlState()"
              />
            </label>
          </div>
        </div>

        <EmptyState
          v-if="listEmptyState"
          class="sp-pq__empty"
          data-testid="stock-prep-project-query-empty"
          :data-empty-state="listEmptyState"
          :title="listEmptyText.title"
          :hint="listEmptyText.hint"
        />

        <ul v-else class="sp-pq__list" data-testid="stock-prep-project-query-list">
          <li v-for="row in visibleRows" :key="row.projectNo" class="sp-pq__row-item">
            <button
              type="button"
              class="sp-pq__row"
              :class="{ 'sp-pq__row--selected': row.projectNo === selection }"
              data-testid="stock-prep-project-query-row"
              :data-project-no="row.projectNo"
              :data-posture="row.posture.key"
              :data-selected="row.projectNo === selection ? 'true' : 'false'"
              :aria-pressed="row.projectNo === selection ? 'true' : 'false'"
              @click="selectRow(row.projectNo)"
            >
              <span class="sp-pq__row-head">
                <span class="sp-pq__row-no">{{ row.projectNo }}</span>
                <span v-if="row.projectName" class="sp-pq__row-name">{{ row.projectName }}</span>
                <span
                  class="sp-pq__badge"
                  :class="`sp-pq__badge--${row.posture.tone}`"
                  data-testid="stock-prep-project-query-row-badge"
                >{{ bi(row.posture.zh, row.posture.en) }}</span>
              </span>
              <span class="sp-pq__row-meta">
                <span data-testid="stock-prep-project-query-row-source">
                  {{ bi('来源:', 'Source: ') }}{{ sourceLabel(row) }}
                </span>
                <span data-testid="stock-prep-project-query-row-export">
                  {{ bi('最近导出:', 'Last export: ') }}{{ lastExportLabel(row) }}
                </span>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <!-- ─── 右栏:选中项目的摘要 ───────────────────────────────────────────────── -->
      <section
        class="sp-pq__detail-pane"
        data-testid="stock-prep-project-query-detail"
        :aria-label="bi('项目摘要', 'Project summary')"
      >
        <EmptyState
          v-if="!selection"
          class="sp-pq__empty"
          data-testid="stock-prep-project-query-detail-empty"
          data-empty-state="no_selection"
          :title="bi('左边点一个项目', 'Pick a project on the left')"
          :hint="bi(
            '选中之后这里读一次那个项目的看板,显示行数、待确认和最近变更。',
            'Selecting one reads that project\'s board once and shows its row count, pending decisions and latest change.',
          )"
        />

        <template v-else>
          <h3 class="sp-pq__detail-title" data-testid="stock-prep-project-query-detail-title">
            {{ selection }}
            <span v-if="detailName" class="sp-pq__detail-name">{{ detailName }}</span>
          </h3>

          <p
            v-if="detailLoading"
            class="sp-pq__hint"
            data-testid="stock-prep-project-query-detail-loading"
            role="status"
          >
            {{ bi('正在读这个项目的看板…', 'Reading this project\'s board…') }}
          </p>

          <!-- G3:选中一行是人主动点的,所以它的失败要看得见 —— 与页面自己发起的预读不同。 -->
          <p
            v-else-if="detailError"
            class="sp-pq__error"
            data-testid="stock-prep-project-query-detail-error"
            role="status"
          >
            {{ bi(detailError.zh, detailError.en) }}
          </p>

          <dl v-else-if="detail" class="sp-pq__metrics">
            <div class="sp-pq__metric" data-testid="stock-prep-project-query-metric-rows">
              <dt>{{ bi('表里有多少行', 'Rows in the table') }}</dt>
              <dd>{{ rowCountText }}</dd>
            </div>
            <div class="sp-pq__metric" data-testid="stock-prep-project-query-metric-pending">
              <dt>{{ bi('等您拿主意', 'Waiting on a decision') }}</dt>
              <dd>{{ detail.pendingDecisionCount }}</dd>
            </div>
            <div class="sp-pq__metric" data-testid="stock-prep-project-query-metric-held">
              <dt>{{ bi('存档里卡着的行', 'Rows held in the archive') }}</dt>
              <dd>{{ heldText }}</dd>
            </div>
            <div class="sp-pq__metric" data-testid="stock-prep-project-query-metric-changed">
              <dt>{{ bi('最近变更(来自 PLM)', 'Latest change (from PLM)') }}</dt>
              <dd>{{ lastChangedText }}</dd>
            </div>
          </dl>

          <!-- G1:整页唯一的 --ms-color-primary 填充按钮就是这一个。「去确认队列」是次操作,
               所以它是描边的 —— 一排两个填充主按钮就是本次重设计要去掉的那种「卡片堆」。 -->
          <div class="sp-pq__actions">
            <button
              type="button"
              class="sp-pq__primary"
              data-testid="stock-prep-project-query-open-board"
              @click="emit('navigate-stage', 'project-board', selection)"
            >
              {{ bi('打开项目备料', 'Open project board') }}
            </button>
            <button
              type="button"
              class="sp-pq__secondary"
              data-testid="stock-prep-project-query-open-queue"
              @click="emit('navigate-stage', 'confirmation-queue', selection)"
            >
              {{ bi('去确认队列', 'Go to the confirmation queue') }}
            </button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
// 项目查询 (P2-1 · 设计稿 §6.3 第一行「项目查询面板」) — 两级筛选 + 主从视图 + URL 状态位。
//
// WHY THIS EXISTS AND WHY ONLY NOW. 设计稿 §6.3 lists this panel as P2 with a HARD precondition:
// 「必须先落 N1」. F1 (§0.2) is why — the operator directory reads the MVP project table, which only a
// platform-admin `mvp-persist` run writes, so before U2's union a query panel would have been
// systematically blind to exactly the projects a self-service floor operator pulled in themselves. A
// search box that cannot find half the projects is worse than no search box: it answers 「没有这个
// 项目」 with confidence. U2 (#5540, `?includePullTargets=1`) is the precondition, and this panel is
// built on that union and on nothing else.
//
// WHAT IT READS, AND WHAT IT DOES NOT.
//   * The directory — through `readStockPreparationOperatorHomeDirectory`, the SAME opted-in,
//     5-second-throttled wrapper 今天要处理 uses. Not a second client and not a second throttle: a
//     reader who flicks between 今天要处理 and 项目查询 must not pay for the full-sheet union scan
//     twice, and the throttle is keyed on the scope rather than on the component, so this is free.
//   * This browser's memory — `readStockPrepRecentProjects`, once, at setup. Same local half of the
//     D1=A union the home page reads; the merge itself is `projectQuery.ts`'s, which calls the home
//     page's own `buildOperatorHomeCards` rather than restating it.
//   * ONE project board, and only when a row is actually SELECTED. No polling, no prefetch, nothing
//     on hover. `?sel=` in a shared link counts as a selection (that is what the link asked for), and
//     re-selecting the row already open reads nothing.
// NO NEW ENDPOINT. Both reads already existed; this panel adds a surface, not a contract.
//
// VALUES-FREE, AND THE SEARCH BOX. Project numbers/names are this panel's subject and are already
// this tier's to see. The SEARCH TERM is a value a person typed, so it is held in a ref, compared in
// memory, and mirrored into the URL — the reader's own address bar, the one place D8/§1 allows — and
// nowhere else: no `localStorage`, no `console`, and no request (the directory read takes no search
// parameter, the board read takes only a project number).
//
// G1 ON THIS SCREEN. Exactly one `--ms-color-primary`-filled button exists: 打开项目备料, in the
// detail pane. 去确认队列 sits beside it as an outlined secondary, the chips are pills, and the rows
// are plain buttons — so §1.2's falsifiable criterion (「任一屏截图里 --ms-color-primary 填充的按钮
// ≤ 1」) holds literally, counted from resolved styles in the browser lane.
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { useLocale } from '../../../composables/useLocale'
import EmptyState from '../../status/EmptyState.vue'
import type { IntegrationScope } from '../../../services/integration/workbench'
import type { StockPreparationOperatorDirectory } from '../../../services/integration/stockPreparation/confirmationQueue'
import { readStockPreparationOperatorHomeDirectory } from '../../../services/integration/stockPreparation/operatorHomeDirectory'
import { readStockPrepRecentProjects } from '../../../services/integration/stockPreparation/operatorHomeMemory'
import {
  readStockPreparationProjectBoard,
  type StockPreparationProjectBoard,
} from '../../../services/integration/stockPreparation/projectBoard'
import {
  buildStockPrepProjectQueryRows,
  countStockPrepProjectQueryRowsByStatus,
  filterStockPrepProjectQueryRows,
  resolveStockPrepProjectQueryEmptyState,
  stockPrepLastExportDisplay,
  stockPrepProjectQuerySearchFromQuery,
  stockPrepProjectQuerySelectionFromQuery,
  stockPrepProjectQuerySourceAvailable,
  stockPrepProjectQuerySourceFromQuery,
  stockPrepProjectQueryStatusFromQuery,
  stockPrepProjectQueryUrlState,
  STOCK_PREP_PROJECT_QUERY_SOURCE_KEYS,
  STOCK_PREP_PROJECT_QUERY_STATUS_KEYS,
  type StockPrepProjectQueryRow,
  type StockPrepProjectQuerySourceKey,
  type StockPrepProjectQueryStatusKey,
} from '../../../services/integration/stockPreparation/projectQuery'
import {
  STOCK_PREP_HOME_DIRECTORY_MAY_BE_INCOMPLETE,
  STOCK_PREP_HOME_PULL_TARGET_SCAN_CAPPED,
  STOCK_PREP_HOME_PULL_TARGET_UNREADABLE,
  type StockPrepPlainText,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(defineProps<{ scope?: IntegrationScope }>(), { scope: () => ({}) })

const emit = defineEmits<{
  /** The shell's own `handleNavigateStage(viewKey, projectNo)` — one nav surface, not a second one. */
  (e: 'navigate-stage', viewKey: string, projectNo?: string): void
}>()

const { locale } = useLocale()
const route = useRoute()
const router = useRouter()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

// ---------------------------------------------------------------------------
// URL 状态位 — 进入时恢复,操作时回写
// ---------------------------------------------------------------------------
//
// SEEDED SYNCHRONOUSLY, at setup, from `route.query`. A shared `?tab=project-query&status=…&sel=…`
// link must paint its own state on the FIRST frame rather than painting the default list and then
// swapping under the reader. Every clamp lives in `projectQuery.ts`, so an unknown enum value is
// IGNORED (falls back to 「全部」) instead of erroring or rendering a filter nobody can name.
const search = ref<string>(stockPrepProjectQuerySearchFromQuery(route.query?.q))
const status = ref<StockPrepProjectQueryStatusKey>(stockPrepProjectQueryStatusFromQuery(route.query?.status))
const source = ref<StockPrepProjectQuerySourceKey>(stockPrepProjectQuerySourceFromQuery(route.query?.source))
const selection = ref<string>(stockPrepProjectQuerySelectionFromQuery(route.query?.sel))

/**
 * Mirror the four bits back — `replace`, never `push`.
 *
 * Typing in a search box, pressing a chip and picking a row are not history steps: a reader who
 * pressed 返回 after refining a filter five times expects to leave this page, not to unwind five
 * keystrokes. (`?projectNo=` is mirrored the same way, for the same stated reason, in the shell.)
 *
 * `tab: 'project-query'` RIDES ALONG, and it is the one key here the shell also owns. The shell
 * deliberately does not mirror `?tab=` on a rail click, so without this the four bits below would be
 * written into a URL that reopens on somebody else's landing tab and ignores every one of them —
 * 「刷新/分享可复现」 would be false for exactly the reader who bothered to filter. The shell drops
 * all five again the moment a rail click or a `navigate-stage` leaves this panel, so a stale
 * `tab=project-query` cannot outlive the visit (see `stockQueryStateKeys` there).
 *
 * A DEFAULT VALUE REMOVES ITS KEY rather than writing an empty one: `?q=&status=all` is a longer
 * link that says nothing, and 「回到默认」 should leave no litter in an address bar somebody pastes.
 */
function writeUrlState(): void {
  const query: LocationQueryRaw = { ...route.query, tab: 'project-query' }
  const next = stockPrepProjectQueryUrlState({
    status: status.value,
    source: source.value,
    search: search.value,
    selection: selection.value,
  })
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete query[key]
    else query[key] = value
  }
  void router.replace({ query })
}

function selectStatus(key: StockPrepProjectQueryStatusKey): void {
  // Pressing the active chip returns to 全部 — the same toggle the home page's chips have, so the
  // two filter rows do not behave differently while looking identical.
  status.value = status.value === key ? 'all' : key
  writeUrlState()
}

function selectRow(projectNo: string): void {
  if (selection.value === projectNo) return
  selection.value = projectNo
  writeUrlState()
}

// ---------------------------------------------------------------------------
// 目录 ∪ 本机记忆 — the list
// ---------------------------------------------------------------------------

const directory = ref<StockPreparationOperatorDirectory | null>(null)
/** True once the FIRST directory read has SETTLED either way — 「还没读完」 and 「读不到」 differ. */
const directorySettled = ref(false)
const memory = ref(readStockPrepRecentProjects(props.scope))

async function loadDirectory(): Promise<void> {
  try {
    directory.value = await readStockPreparationOperatorHomeDirectory(props.scope)
  } catch {
    // G3: a predread nobody asked for degrades to an empty state, never to a red banner. The
    // `directory_unavailable` state below is that degradation, and it says 「读不到」, not 「没有」.
    directory.value = null
  } finally {
    directorySettled.value = true
  }
}

onMounted(() => {
  void loadDirectory()
})

const rows = computed<StockPrepProjectQueryRow[]>(() => buildStockPrepProjectQueryRows(
  directory.value,
  memory.value,
))

const visibleRows = computed<StockPrepProjectQueryRow[]>(() => filterStockPrepProjectQueryRows(rows.value, {
  status: status.value,
  source: source.value,
  search: search.value,
}))

const sourceAvailable = computed<boolean>(() => stockPrepProjectQuerySourceAvailable(directory.value))

const STATUS_LABELS: Record<StockPrepProjectQueryStatusKey, [string, string]> = {
  all: ['全部', 'All'],
  pending_decision: ['等您拿主意', 'Waiting on you'],
  blocked: ['卡住了', 'Blocked'],
  ready: ['可以导出', 'Ready to export'],
  not_pulled: ['还没拉过', 'Not pulled yet'],
}

const statusChips = computed(() => STOCK_PREP_PROJECT_QUERY_STATUS_KEYS.map((key) => ({
  key,
  label: bi(...STATUS_LABELS[key]),
  count: countStockPrepProjectQueryRowsByStatus(rows.value, key),
})))

const SOURCE_LABELS: Record<StockPrepProjectQuerySourceKey, [string, string]> = {
  all: ['全部', 'All'],
  mvp: ['归档过', 'Archived'],
  pull_target: ['自助拉取', 'Pulled in-house'],
  both: ['两者都有', 'Both'],
}

const sourceOptions = computed(() => STOCK_PREP_PROJECT_QUERY_SOURCE_KEYS.map((key) => ({
  key,
  label: bi(...SOURCE_LABELS[key]),
})))

function sourceLabel(row: StockPrepProjectQueryRow): string {
  // 「看不到」 gets its own rendering, and it is NOT 「没有来源」 — see projectQuery.ts's `sources`.
  if (row.sources === null) return bi('看不到', 'Not visible')
  const mvp = row.sources.includes('mvp')
  const pull = row.sources.includes('pull_target')
  if (mvp && pull) return bi('归档过 + 自助拉取', 'Archived + pulled in-house')
  if (mvp) return bi('归档过', 'Archived')
  if (pull) return bi('自助拉取', 'Pulled in-house')
  return '—'
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US')
}

/**
 * 最近导出. 「—」 unless the directory itself said its export window was COMPLETE — see
 * `stockPrepLastExportDisplay`. Rendering an unknown as 「从未导出过」 is how somebody re-sends a
 * file that already went out, or tells a customer nobody ever received one.
 */
function lastExportLabel(row: StockPrepProjectQueryRow): string {
  const display = stockPrepLastExportDisplay(row.lastExportAt, directory.value?.lastExportAtMayBeIncomplete)
  if (display === 'timestamp') return formatTimestamp(row.lastExportAt as string)
  if (display === 'never') return bi('从未导出过', 'Never exported')
  return '—'
}

const listEmptyState = computed(() => resolveStockPrepProjectQueryEmptyState({
  directorySettled: directorySettled.value,
  directoryAvailable: directory.value !== null,
  rowCount: rows.value.length,
  visibleRowCount: visibleRows.value.length,
}))

const LIST_EMPTY_TEXT: Record<string, { title: [string, string]; hint: [string, string] }> = {
  directory_unavailable: {
    title: ['项目清单暂时读不到', 'The project list could not be read right now'],
    hint: [
      '这不是「没有项目」,是这一次没读到。可以稍后再试,或者直接用项目号在「项目备料」里打开。',
      'That is not the same as "there are no projects" — this read simply did not come back. Try again shortly, or open a project by its number on 项目备料.',
    ],
  },
  no_projects: {
    title: ['这里还没有项目可查', 'There is nothing here to search yet'],
    hint: [
      '备料从「把项目从 PLM 拉进来」开始。拉过一个之后,它就会出现在这份清单里。',
      'Stock preparation starts by pulling a project in from PLM — once one has been pulled, it appears in this list.',
    ],
  },
  filter_empty: {
    title: ['这组条件下一个项目都没有', 'No project matches these filters'],
    hint: [
      '清单里是有项目的,只是没有一个同时符合现在这几个条件。把「全部」按回去就能看回全部。',
      'The list is not empty — nothing in it matches all of the current filters at once. Press 全部 to see every project again.',
    ],
  },
}

const listEmptyText = computed(() => {
  const state = listEmptyState.value
  const entry = state ? LIST_EMPTY_TEXT[state] : null
  if (!entry) return { title: '', hint: '' }
  return { title: bi(...entry.title), hint: bi(...entry.hint) }
})

/** U2 契约 (P0 补项 5) — at most ONE of three sentences, same order and same words as 今天要处理.
 *  Every check is `=== true` / `=== false`: an older backend OMITS these fields, and 「不知道」 must
 *  never read as 「否」 (which would show the most alarming sentence on every pre-U2 deployment). */
const pullBanner = computed<{ key: string; text: StockPrepPlainText } | null>(() => {
  const dir = directory.value
  if (!dir) return null
  if (dir.pullTargetReady === false) return { key: 'pull_target_unreadable', text: STOCK_PREP_HOME_PULL_TARGET_UNREADABLE }
  if (dir.pullTargetScanCapped === true) return { key: 'pull_target_scan_capped', text: STOCK_PREP_HOME_PULL_TARGET_SCAN_CAPPED }
  if (dir.directoryMayBeIncomplete === true) return { key: 'directory_may_be_incomplete', text: STOCK_PREP_HOME_DIRECTORY_MAY_BE_INCOMPLETE }
  return null
})

// ---------------------------------------------------------------------------
// 右栏 — ONE board read per selection, never a poll
// ---------------------------------------------------------------------------

const detail = ref<StockPreparationProjectBoard | null>(null)
const detailLoading = ref(false)
const detailError = ref<{ zh: string; en: string } | null>(null)
let detailGeneration = 0

/**
 * `immediate: true` so a `?sel=` deep link reads the board it names on arrival — the link asked for
 * that project, and making the reader click the row they already linked to would be the URL and the
 * page disagreeing about what is open.
 *
 * A generation counter guards the race: clicking three rows quickly fires three reads, and only the
 * newest one may write. Without it the slowest response wins and the pane shows a project the reader
 * has already moved off.
 */
watch(selection, (projectNo) => {
  const mine = ++detailGeneration
  detailError.value = null
  if (!projectNo) {
    detail.value = null
    detailLoading.value = false
    return
  }
  detail.value = null
  detailLoading.value = true
  void readStockPreparationProjectBoard({ ...props.scope, projectNo })
    .then((board) => {
      if (mine !== detailGeneration) return
      detail.value = board
    })
    .catch((error: unknown) => {
      if (mine !== detailGeneration) return
      detail.value = null
      // 404 是一个正常形状,不是故障:这个号在这个租户里没有数据(或者根本不是这个租户的),
      // 服务端按设计分不出这两者。其余失败是另一句话 —— 值面一律不出现在文案里。
      const code = (error as { code?: unknown })?.code
      detailError.value = code === 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND'
        ? {
          zh: '这个项目号在您这里还没有数据。可以在「项目备料」里把它从 PLM 拉进来。',
          en: 'This project number has no data here yet — pull it in from PLM on 项目备料.',
        }
        : {
          zh: '这个项目的摘要没读出来,数据没有变化。稍后再点一次;还是不行就找管理员。',
          en: 'This project\'s summary could not be read; nothing changed. Try again shortly, or ask an administrator.',
        }
    })
    .finally(() => {
      if (mine !== detailGeneration) return
      detailLoading.value = false
    })
}, { immediate: true })

/** The name comes from the LIST when it has one — the board's own is used only as the fallback. */
const detailName = computed<string | null>(() => {
  const row = rows.value.find((candidate) => candidate.projectNo === selection.value)
  return row?.projectName ?? detail.value?.projectName ?? null
})

const rowCountText = computed<string>(() => {
  const board = detail.value
  if (!board) return '—'
  const rowsText = board.pulledRowCountBounded
    ? bi(`至少 ${board.pulledRowCount} 行`, `at least ${board.pulledRowCount} row(s)`)
    : bi(`${board.pulledRowCount} 行`, `${board.pulledRowCount} row(s)`)
  return bi(
    `${rowsText}(在用 ${board.activePulledRowCount})`,
    `${rowsText} (${board.activePulledRowCount} active)`,
  )
})

/**
 * 存档里卡着的行. THE ARCHIVE'S number, and it says so.
 *
 * `heldLineCount` is written by the platform-admin `mvp-persist` archive (F1), so for a project a
 * floor operator pulled themselves there is no archive at all and `0` would be a fabrication in the
 * reassuring direction. `archivedSnapshotPresent === false` is exactly that case, and it renders
 * §4.4's third state (「看不到」) rather than a green zero.
 */
const heldText = computed<string>(() => {
  const board = detail.value
  if (!board) return '—'
  if (!board.archivedSnapshotPresent) return bi('看不到(没有管理员存档)', 'Not visible (no administrator archive)')
  return String(board.heldLineCount)
})

/** 最近变更(来自 PLM) — the same three states the board's own card renders, worded the same way. */
const lastChangedText = computed<string>(() => {
  const board = detail.value
  if (!board) return '—'
  if (board.lastChangedFromPlmBounded) return bi('行数超过看板上限,未统计', 'Row count exceeds the board scan limit — not counted')
  const at = board.lastChangedFromPlmAt
  if (!at) return '—'
  return formatTimestamp(at)
})
</script>

<style scoped>
.sp-pq {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-pq__loading {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
}

/* 诊断,不是警报 —— 与首页那三句同样的静音处理,绝不用 danger/warning 色。 */
.sp-pq__banner {
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}

/* 主从视图。窄屏折成上下两段 —— 同一份 DOM,只有一条媒体查询,没有第二个容器。 */
.sp-pq__split {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: var(--ms-space-3);
  align-items: start;
}

.sp-pq__list-pane,
.sp-pq__detail-pane {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.sp-pq__filters {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.sp-pq__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.sp-pq__chip {
  padding: 6px 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-pq__chip--active {
  border-color: var(--ms-color-primary);
  color: var(--ms-color-primary);
  font-weight: var(--ms-font-weight-title, 600);
}

.sp-pq__second-level {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-2);
}

.sp-pq__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sp-pq__field--grow {
  flex: 1 1 200px;
}

.sp-pq__field-label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-pq__select,
.sp-pq__input {
  padding: 6px 10px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
  font: inherit;
  font-size: 13px;
}

.sp-pq__select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sp-pq__hint {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}

.sp-pq__error {
  margin: 0;
  color: var(--ms-color-danger);
  font-size: 13px;
  line-height: 1.6;
}

.sp-pq__empty {
  border: 1px dashed var(--ms-border-light);
  border-radius: 8px;
}

.sp-pq__list {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.sp-pq__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-left: 2px solid transparent;
  border-radius: 6px;
  background: var(--ms-bg-page);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sp-pq__row:hover {
  border-color: var(--ms-color-primary);
}

.sp-pq__row--selected {
  border-left-color: var(--ms-color-primary);
  background: var(--ms-bg-card);
}

.sp-pq__row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
}

.sp-pq__row-no {
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title, 600);
}

.sp-pq__row-name {
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-pq__row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-3);
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-pq__badge {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: var(--ms-font-weight-title, 600);
}

.sp-pq__badge--warning { background: color-mix(in srgb, var(--ms-color-warning) 16%, transparent); color: var(--ms-color-warning); }
.sp-pq__badge--danger { background: color-mix(in srgb, var(--ms-color-danger) 16%, transparent); color: var(--ms-color-danger); }
.sp-pq__badge--primary { background: color-mix(in srgb, var(--ms-color-primary) 16%, transparent); color: var(--ms-color-primary); }
.sp-pq__badge--success { background: color-mix(in srgb, var(--ms-color-success) 16%, transparent); color: var(--ms-color-success); }
.sp-pq__badge--info { background: color-mix(in srgb, var(--ms-color-info) 20%, transparent); color: var(--ms-color-info); }
.sp-pq__badge--neutral { background: var(--ms-bg-page); color: var(--ms-text-3); }

.sp-pq__detail-title {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  font-size: 14px;
  color: var(--ms-text-1);
}

.sp-pq__detail-name {
  color: var(--ms-text-2);
  font-size: 13px;
  font-weight: 400;
}

.sp-pq__metrics {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin: 0;
}

.sp-pq__metric {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--ms-space-2);
  font-size: 13px;
}

.sp-pq__metric dt {
  color: var(--ms-text-3);
}

.sp-pq__metric dd {
  margin: 0;
  color: var(--ms-text-1);
}

.sp-pq__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

/* G1: THE one filled primary on this screen. Nothing else here may take this fill. */
.sp-pq__primary {
  padding: 7px 14px;
  border: 1px solid var(--ms-color-primary);
  border-radius: 6px;
  background: var(--ms-color-primary);
  color: #fff;
  font: inherit;
  font-weight: var(--ms-font-weight-title, 600);
  cursor: pointer;
}

.sp-pq__secondary {
  padding: 7px 14px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
  font: inherit;
  cursor: pointer;
}

@media (max-width: 899px) {
  .sp-pq__split {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
