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
        <!-- WITH NOTHING TO FILTER THERE IS NO FILTER ROW — the same `v-if` 今天要处理 puts on its
             chip row. A row of controls over an empty union is not merely useless: its 「后端未提供
             来源」 note is a positive claim ABOUT THE SERVER, and it is the sentence a brand-new
             tenant with zero projects would be shown — where it is false. §4.3's empty state is the
             only thing this case gets. -->
        <div v-if="rows.length > 0" class="sp-pq__filters">
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

          <!-- G4 在 chip 行上的那一格:目录只带得回「等您拿主意」的实时计数,别的三档只有这台电脑
               自己记得的项目才进得去。不说这句,三个恒为 0 的 chip 会被读成「没有卡住的项目」。 -->
          <p
            v-if="memoryOnlyChipsNote"
            class="sp-pq__hint"
            data-testid="stock-prep-project-query-chips-note"
          >
            {{ bi(
              '「卡住了 / 可以导出 / 还没拉过」只认这台电脑打开过的项目 —— 清单本身带得回来的只有「等您拿主意」。别的项目在「全部」里。',
              '“Blocked / Ready to export / Not pulled yet” only cover projects this computer has opened — the list itself can report only “Waiting on you”. Everything else sits under 全部 (All).',
            ) }}
          </p>

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
            <!-- G4:控件禁用了就得说为什么,而且得说对是哪一种。「后端没提供来源」不是「所有项目都
                 没有来源」,也不是「清单这次没读到」—— 后者不许被说成前者。 -->
            <p
              v-if="sourceHint"
              class="sp-pq__hint"
              data-testid="stock-prep-project-query-source-unavailable"
              :data-source-hint="sourceHint.key"
            >
              {{ bi(sourceHint.zh, sourceHint.en) }}
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

        <!-- THE EMPTY STATE IS A BANNER, NOT A REPLACEMENT — 今天要处理's shape, and the reason is
             `directory_unavailable`: this browser's own memory rows survive a failed directory read,
             and swapping the list out for 「读不到」 would DELETE from the screen the very projects
             the same reader can still see on 今天要处理. 「读不到」 and 「这里是我还记得的」 are both
             true at once, so both are on screen at once. -->
        <EmptyState
          v-if="listEmptyState"
          class="sp-pq__empty"
          data-testid="stock-prep-project-query-empty"
          :data-empty-state="listEmptyState"
          :title="listEmptyText.title"
          :hint="listEmptyText.hint"
        />

        <ul v-if="visibleRows.length > 0" class="sp-pq__list" data-testid="stock-prep-project-query-list">
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

          <!-- `?sel=` 与筛选是两件事:链接指名的项目可以恰好不在当前这组条件里。左栏说「一个都没
               有」、右栏摆着一个项目的摘要,这不矛盾 —— 但得说破,否则读者会以为筛选没生效。 -->
          <p
            v-if="selectionOutsideFilter"
            class="sp-pq__hint"
            data-testid="stock-prep-project-query-detail-outside-filter"
          >
            {{ bi(
              '这个项目不在当前的筛选结果里 —— 它是链接指名的那一个。',
              'This project is not in the current filter results — it is the one the link named.',
            ) }}
          </p>

          <p
            v-if="detailLoading"
            class="sp-pq__hint"
            data-testid="stock-prep-project-query-detail-loading"
            role="status"
          >
            {{ bi('正在读这个项目的看板…', 'Reading this project\'s board…') }}
          </p>

          <!-- G3:选中一行是人主动点的,所以它的失败要看得见 —— 与页面自己发起的预读不同。
               两行 (P0-5):第一行说发生了什么,第二行说该做什么,外加那个可以交给管理员的码。文案
               取自 `stockPrepBoardErrorPlain`,与项目备料页同一张表 —— 手写第三种说法正是错误码抽屉
               和页面对不上的来源。 -->
          <p
            v-else-if="detailError"
            class="sp-pq__error"
            data-testid="stock-prep-project-query-detail-error"
            role="status"
          >
            {{ bi(detailError.text.zh, detailError.text.en) }}
            <code v-if="detailError.code" class="sp-pq__token">{{ detailError.code }}</code>
            <span
              v-if="detailError.text.zhNext"
              class="sp-pq__hint"
              data-testid="stock-prep-project-query-detail-error-next"
            >
              {{ bi(detailError.text.zhNext, detailError.text.enNext ?? '') }}
            </span>
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
// ≤ 1」) holds literally. It is counted TWICE, and the two counts prove different things: the jsdom
// suite counts the `.sp-pq__primary` CLASS (cheap, and it catches a second button being given the
// class), and the browser lane counts buttons whose RESOLVED background equals the token's own
// resolved value over the whole panel subtree — the only one of the two that can see a rule from
// some other stylesheet painting a chip or a row primary.
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
import { stockPrepHomeStatusLabel } from '../../../services/integration/stockPreparation/operatorHomeCards'
import {
  resolveStockPrepPullBanner,
  stockPrepBoardErrorPlain,
  type StockPrepPlainEntry,
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
 * `tab=project-query` cannot outlive the visit — INCLUDING the case where the four filter keys are
 * back at their defaults and `tab` is the only key left, which is two clicks away (filter once, then
 * press the same chip again). See `PROJECT_QUERY_STATE_KEYS` / `hasStaleProjectQueryState` in
 * StockPreparationWorkspace.vue, which counts `tab=project-query` as one of the stale bits.
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

const sourceAvailable = computed<boolean>(() => stockPrepProjectQuerySourceAvailable(directory.value))

/**
 * The 来源 value the LIST is actually filtered by — clamped to 「全部」 whenever the control is
 * disabled, and NOT the raw ref.
 *
 * `?source=mvp` is a legal enum, so nothing rejects it; but on a deployment that answers no `sources`
 * at all (an older backend, or a directory read that failed and left only this browser's memory) every
 * row's `sources` is `null` and `matchesSource` refuses all of them. The reader would then see 「这组
 * 条件下一个项目都没有」 over a full list, with the 来源 dropdown greyed out and the empty state
 * telling them to press a 「全部」 that is not the one that would help. A shared link into a dead end.
 *
 * The URL keeps its `source=` (it is the reader's own link, and it becomes meaningful again the
 * moment they open it against a deployment that answers), and `sourceHint` says out loud that it did
 * not apply here. Silently honouring it, or silently deleting it, are both worse than saying so.
 */
const effectiveSource = computed<StockPrepProjectQuerySourceKey>(() => (
  sourceAvailable.value ? source.value : 'all'
))

const activeFilter = computed(() => ({
  source: effectiveSource.value,
  search: search.value,
}))

const visibleRows = computed<StockPrepProjectQueryRow[]>(() => filterStockPrepProjectQueryRows(rows.value, {
  status: status.value,
  ...activeFilter.value,
}))

/**
 * The chip row. EVERY COUNT IS TAKEN UNDER THE OTHER TWO FILTERS — see
 * `countStockPrepProjectQueryRowsByStatus`.
 *
 * A chip reads 「等您拿主意 3」 and a reader presses it expecting three rows. Counting over the
 * unfiltered union makes that a lie the moment a search term or a source is set: 「3」 above 「这组
 * 条件下一个项目都没有」, on one screen, at the same time. 今天要处理 gets this for free (one filter
 * level, one predicate); this panel has two levels and has to arrange it deliberately.
 *
 * The WORDS themselves are `stockPrepHomeStatusLabel` (operatorHomeCards.ts, hardening wave) — the
 * same map 今天要处理's own filter row reads, not a second copy of the five labels. See that map's
 * comment for why: `StockPrepProjectQueryStatusKey` is a straight alias of `StockPrepHomeFilterKey`.
 */
const statusChips = computed(() => STOCK_PREP_PROJECT_QUERY_STATUS_KEYS.map((key) => ({
  key,
  label: bi(...stockPrepHomeStatusLabel(key)),
  count: countStockPrepProjectQueryRowsByStatus(rows.value, key, activeFilter.value),
})))

/**
 * 为什么另外三个 chip 常年是 0(G4 在 chip 行上的一格).
 *
 * `buildOperatorHomeCards` can only give a DIRECTORY row `pending_decision` (live, from the ledger)
 * or `unknown` — 卡住了 / 可以导出 / 还没拉过 arrive only from this browser's own memory of a board
 * it opened. So on a machine that has never opened a project, three of the five chips are honestly
 * but confusingly 0, and 0 reads as 「一个卡住的都没有」. This sentence is the difference between a
 * count and a claim. Shown only when it is actually the case: with remembered rows in the list the
 * chips do cover them, and the sentence would then be over-stated in the other direction.
 */
const memoryOnlyChipsNote = computed<boolean>(() => rows.value.length > 0
  && !rows.value.some((row) => row.postureFromMemory || row.origin === 'memory'))

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

/**
 * WHY THE 来源 CONTROL IS GREYED OUT — one sentence, and it has to name the RIGHT reason.
 *
 * Three states hide behind a single `sourceAvailable === false`, and only one of them is a statement
 * about the backend:
 *   * the directory came back and its rows carry no `sources` — 「后端未提供来源」, true;
 *   * the directory read FAILED and the rows on screen are this browser's memory — the backend said
 *     nothing at all, so claiming it 「未提供来源」 puts words in the mouth of a server that was never
 *     reached (and the list very much IS affected, contradicting the same sentence's second half);
 *   * there is nothing to filter yet — the whole control row is unrendered, so no sentence at all.
 *
 * A `?source=` that could not be applied is appended in the first two cases: the reader can see the
 * value in their own address bar, and a filter that is in the URL but not in effect must not be
 * silent about it.
 */
const sourceHint = computed<{ key: string; zh: string; en: string } | null>(() => {
  if (sourceAvailable.value) return null
  if (!directorySettled.value || rows.value.length === 0) return null
  const ignored = source.value !== 'all'
  const ignoredZh = ignored ? '链接里带的来源筛选这次没有生效。' : ''
  const ignoredEn = ignored ? ' The source filter carried in the link did not take effect here.' : ''
  if (directory.value === null) {
    return {
      key: 'directory_unavailable',
      zh: `项目清单这次没读到,所以按来源筛不了;下面是这台电脑记得的项目。${ignoredZh}`,
      en: `The project list could not be read this time, so filtering by source is unavailable — below are the projects this computer remembers.${ignoredEn}`,
    }
  }
  return {
    key: 'not_reported',
    zh: `后端未提供来源,这一项筛选用不了;清单本身不受影响。${ignoredZh}`,
    en: `The backend did not report a source, so this filter is unavailable — the list itself is unaffected.${ignoredEn}`,
  }
})

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

/** U2 契约 (P0 补项 5)'s three-sentence priority chain — `resolveStockPrepPullBanner`
 *  (plainLanguage.ts, hardening wave), the SAME function 今天要处理 calls, not a second copy of the
 *  chain. See that function's own comment for the priority order and the `=== true` / `=== false`
 *  reasoning. */
const pullBanner = computed(() => resolveStockPrepPullBanner(directory.value))

// ---------------------------------------------------------------------------
// 右栏 — ONE board read per selection, never a poll
// ---------------------------------------------------------------------------

const detail = ref<StockPreparationProjectBoard | null>(null)
const detailLoading = ref(false)
const detailError = ref<{ code: string | null; text: StockPrepPlainEntry } | null>(null)
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
      // 服务端按设计分不出这两者。文案取自看板自己那张表 —— 同一个失败在仓库里已经有一种说法,
      // 手写第二种只会让错误码抽屉与页面对不上,并且丢掉 P0-5 的两行结构。值面不进文案。
      const raw = (error as { code?: unknown })?.code
      const code = typeof raw === 'string' && raw.length > 0 ? raw : null
      detailError.value = { code, text: stockPrepBoardErrorPlain(code ?? '') }
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

/** A `?sel=` the current filters exclude. Not an error — but the two panes must not look at odds. */
const selectionOutsideFilter = computed<boolean>(() => selection.value.length > 0
  && rows.value.some((row) => row.projectNo === selection.value)
  && !visibleRows.value.some((row) => row.projectNo === selection.value))

/**
 * 表里有多少行 — WORD FOR WORD 项目备料页's `rowsText`, branches included.
 *
 * Same label, same field, same three-way answer, because a reader who checks one screen against the
 * other must not be given two different sentences about one number. The two branches that matter:
 *
 *   * `pullTargetReady === false` — the bound sheet is missing, unprovisioned, or not this tenant's,
 *     and the server sets `pulledRowCount: 0` alongside it (PULL_TARGET_NOT_READY). Rendering that
 *     as 「0 行」 turns 「读不到那张表」 into 「拉过了,只是空的」 — G4's failure in its most expensive
 *     direction, since the reader's next move is to re-pull 1,240 rows or to tell somebody nothing
 *     was pulled.
 *   * `pulledRowCount === 0` with the table ready — that IS 「还没有行」, and it deserves the words
 *     rather than a bare zero.
 */
const rowCountText = computed<string>(() => {
  const board = detail.value
  if (!board) return '—'
  if (!board.pullTargetReady) return bi('备料主表还没建好', 'The stock-preparation table is not set up yet')
  if (board.pulledRowCount === 0) return bi('还没有行', 'No rows yet')
  const total = board.pulledRowCountBounded
    ? bi(`超过 ${board.pulledRowCount} 行`, `more than ${board.pulledRowCount} row(s)`)
    : bi(`${board.pulledRowCount} 行`, `${board.pulledRowCount} row(s)`)
  if (board.activePulledRowCount === board.pulledRowCount) return total
  return bi(
    `${total},其中 ${board.activePulledRowCount} 行还有效`,
    `${total}, ${board.activePulledRowCount} of them still active`,
  )
})

/**
 * 存档里卡着的行. THE ARCHIVE'S number, and it says so.
 *
 * `heldLineCount` is written by the platform-admin `mvp-persist` archive (F1), so for a project a
 * floor operator pulled themselves there is no archive at all and `0` would be a fabrication in the
 * reassuring direction. `archivedSnapshotPresent === false` is exactly that case, and it renders a
 * third state rather than a green zero.
 *
 * IT DOES NOT SAY 「看不到」. §4.4 reserves that word for 「权限不够,判断不了」, and this is not that:
 * absence of an archive is a KNOWN, ordinary fact about an operator's own pull, and it is what 项目
 * 备料页 says in its own words (「管理员还没有为这个项目留存快照」). Same fact, same vocabulary.
 */
const heldText = computed<string>(() => {
  const board = detail.value
  if (!board) return '—'
  if (!board.archivedSnapshotPresent) return bi('管理员还没有留存快照', 'No administrator snapshot yet')
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

/* P0-5 的第二行:该做什么、找谁。跟着第一行走,自己成一行,不用 danger 色喊第二遍。 */
.sp-pq__error .sp-pq__hint {
  display: block;
}

.sp-pq__token {
  margin-left: 6px;
  font-size: 12px;
  color: var(--ms-text-3);
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
