<template>
  <div class="sp-board" data-testid="stock-prep-project-board" data-control="stock-prep-operator-project-board">
    <p class="sp-board__lede" data-testid="stock-prep-project-board-lede">
      {{ bi(
        '一个项目,一页做完:先把 BOM 从 PLM 拉过来,再到多维表里填采购和仓库的进度,填完通知下一步,需要给别人时导出成 Excel。',
        'One project, one page: pull the BOM in from PLM, fill in purchasing and warehouse progress in the multitable, tell the next person when you are done, and export to Excel when someone needs a copy.',
      ) }}
    </p>

    <!-- ── 1. 搜项目 ────────────────────────────────────────────────────────────────────────────
         The SAME native datalist #5445 built for the confirmation queue: option VALUE is the number
         and option LABEL is the name, so the browser's own type-ahead filters on either. An operator
         who only remembers 「注射水缓冲罐」 finds 230920006 without being told it, and the trained
         operator who types the number keeps the path they already use. -->
    <div class="sp-board__search">
      <label class="sp-board__field">
        <span>{{ bi('项目号(可按号码或名称搜)', 'Project no. (search by number or name)') }}</span>
        <input
          v-model="projectNoInput"
          type="text"
          list="stock-prep-board-directory-options"
          data-testid="stock-prep-project-board-input"
          :placeholder="bi('项目号或名称', 'Project number or name')"
          @keyup.enter="openProject"
        >
        <datalist id="stock-prep-board-directory-options" data-testid="stock-prep-project-board-datalist">
          <option
            v-for="project in directoryProjects"
            :key="project.projectId"
            :value="project.projectNo ?? ''"
          >{{ project.projectName ?? '' }}</option>
        </datalist>
      </label>
      <button
        type="button"
        class="sp-board__open"
        data-testid="stock-prep-project-board-open"
        :disabled="busy || refreshing || projectNoInput.trim().length === 0"
        @click="openProject"
      >
        {{ busy ? bi('正在打开…', 'Opening…') : bi('打开这个项目', 'Open this project') }}
      </button>
    </div>

    <!-- The clamped enum code stays on screen — it is what a person quotes when they ask for help —
         subordinate to a sentence that says what actually happened.

         TWO THINGS THIS BANNER NOW GETS RIGHT.
         (1) READ-SHAPED COPY. This page writes nothing, so a failed board read must not say
             「这一步没有保存成功」 — that answers a question nobody asked and implies lost work that
             never existed. The board's own failures resolve through `stockPrepBoardErrorPlain`,
             which falls back to a READ generic. The two controls here that really do write or
             download (通知下一步, 导出) keep the write-shaped table, chosen per action rather than
             per page.
         (2) IT DOES NOT DOUBLE UP WITH THE EMPTY STATE. A 404 used to render this banner AND the
             empty state below, saying two different things about one fact. When the empty state is
             already explaining the miss, the banner stays out of the way. -->
    <p v-if="visibleErrorCode" class="sp-board__error" data-testid="stock-prep-project-board-error">
      {{ bi(errorText.zh, errorText.en) }}
      <code class="sp-board__token">{{ visibleErrorCode }}</code>
    </p>

    <!-- THREE-WAY EMPTY STATE, reused verbatim from #5445 rather than re-derived: it is the one
         place that can tell 「号码打错了」 from 「这台系统里还没有任何项目」 from 「表还没建好」. -->
    <p v-if="emptyPlain" class="sp-board__empty" data-testid="stock-prep-project-board-empty">
      {{ bi(emptyPlain.zh, emptyPlain.en) }}
      <span v-if="emptyPlain.zhNext" class="sp-board__empty-next">
        {{ bi(emptyPlain.zhNext, emptyPlain.enNext ?? '') }}
      </span>
    </p>

    <!-- ── 2'. 从PLM拉取, OUTSIDE the board ────────────────────────────────────────────────────────
         THE BUG THIS FIXES. The pull panel used to live inside `v-if="board"`, and the board 404s
         for a project number this tenant has no data for. So the ONE control that creates that data
         was reachable only after the data existed: an operator could never pull a NEW project from
         the page built for them to pull projects.

         The panel is now rendered whenever a project number has been opened, board or no board, and
         it is SEEDED with that number so nobody retypes it. Nothing about the tenant boundary moves:
         the board still answers a foreign tenant's project number with a 404 byte-identical to the
         one an unknown number gets (the server decides that, and its suite asserts it) — what
         changed is only what this tab renders around that refusal. -->
    <section v-if="openedProjectNo" class="sp-board__pull" data-testid="stock-prep-project-board-pull">
      <!-- H14: this page's step 1 is 从PLM拉取数据, and its empty state already sends people to a
           button by that name. `run-variant` makes the button actually carry it. See the panel. -->
      <StockPreparationProjectSyncPanel
        :scope="scope"
        :project-no="openedProjectNo"
        run-variant="pull"
        :api="syncApi"
        :large-bom-api="largeBomApi"
        :large-bom-poll-wait="largeBomPollWait"
        @navigate-stage="(key: string) => emit('navigate-stage', key)"
        @open-multitable="openFillTarget"
        @synced="reloadBoard"
      />
    </section>

    <template v-if="board">
      <!-- ── 2. 状态条 ──────────────────────────────────────────────────────────────────────────
           Everything an operator needs to know before deciding what to press, in one line each. No
           row values: a name, a number, counts, a step key and two timestamps. -->
      <section class="sp-board__status" data-testid="stock-prep-project-board-status">
        <h3 class="sp-board__title" data-testid="stock-prep-project-board-title">
          <span class="sp-board__no">{{ board.projectNo }}</span>
          <span v-if="board.projectName" class="sp-board__name">{{ board.projectName }}</span>
        </h3>
        <dl class="sp-board__facts">
          <div class="sp-board__fact" data-testid="stock-prep-project-board-rows">
            <dt>{{ bi('表里有多少行', 'Rows in the table') }}</dt>
            <dd>{{ rowsText }}</dd>
          </div>
          <div class="sp-board__fact" data-testid="stock-prep-project-board-pull-state">
            <dt>{{ bi('拉取状态', 'Pull status') }}</dt>
            <dd>{{ pullStateText }}</dd>
          </div>
          <div class="sp-board__fact" data-testid="stock-prep-project-board-turn">
            <dt>{{ bi('轮到谁', 'Whose turn') }}</dt>
            <dd>{{ turnText }}</dd>
          </div>
          <div class="sp-board__fact" data-testid="stock-prep-project-board-last-changed-from-plm">
            <dt :title="bi(
              '该项目最近一次同步中有行发生变更(新增/更新/失效)的时间;同步无变更时不更新,不代表最近一次同步的时间。',
              'The last time a sync for this project actually changed a row (added/updated/inactivated). It does not update on a sync with no changes, so it is NOT the last sync time.',
            )">{{ bi('最近变更(来自 PLM)', 'Last change (from PLM)') }}</dt>
            <dd>{{ lastChangedFromPlmText }}</dd>
          </div>
          <div class="sp-board__fact" data-testid="stock-prep-project-board-last-export">
            <dt>{{ bi('最近导出', 'Last export') }}</dt>
            <dd>{{ lastExportText }}</dd>
          </div>
        </dl>
        <!-- THE ADMINISTRATOR'S ARCHIVE, said to be exactly that. These numbers come from the MVP
             snapshot tables, which mvp-persist writes and mvp-persist is platform-admin — so on an
             operator's own run they are legitimately absent, and a bare 「0 次」 above the fold read
             as 「还没拉过」 when the rows were sitting in the sheet the whole time. Subordinate,
             labelled, and never the answer to 「拉过了吗?」. -->
        <p class="sp-board__archive" data-testid="stock-prep-project-board-archive">
          {{ bi(archiveText.zh, archiveText.en) }}
        </p>
        <p v-if="board.pendingDecisionCount > 0" class="sp-board__pending" data-testid="stock-prep-project-board-pending">
          {{ bi(
            `这个项目有 ${board.pendingDecisionCount} 件事等您在「确认队列」里拿主意。`,
            `${board.pendingDecisionCount} thing(s) on this project are waiting for your decision in the confirmation queue.`,
          ) }}
          <button
            type="button"
            class="sp-board__link"
            data-testid="stock-prep-project-board-goto-queue"
            @click="emit('navigate-stage', 'confirmation-queue')"
          >{{ bi('去确认队列', 'Open the confirmation queue') }}</button>
        </p>
      </section>

      <!-- ── 3. 四个动作 ────────────────────────────────────────────────────────────────────────
           从PLM拉取 / 通知下一步 / 导出Excel / 推送宜搭. Every control that renders is one the
           server answers for this caller (R-11); the ones that do not render say why in words. -->
      <section class="sp-board__actions" data-testid="stock-prep-project-board-actions">
        <!-- 从PLM拉取 lives ABOVE, outside `v-if="board"` — see the section that renders it. It is
             ONE instance either way: mounting a second copy here would give the operator two panels
             that disagree about which run is in flight. -->
        <div class="sp-board__buttons">
          <!-- 通知下一步 — the #5442 contract. ABSENT, not disabled, when the deployment has no
               handoff chain: a disabled button still tells the operator the capability exists here. -->
          <button
            v-if="handoff"
            type="button"
            class="sp-board__button"
            data-testid="stock-prep-project-board-notify-next"
            :disabled="busy || !handoff.isCurrentHandler || handoff.terminal"
            :title="notifyTitle"
            @click="notifyNext"
          >
            {{ bi('通知下一步', 'Tell the next person') }}
          </button>

          <!-- 导出Excel — the #5437 client, reused. Same route, same gate, same download trigger. -->
          <button
            type="button"
            class="sp-board__button"
            data-testid="stock-prep-project-board-export"
            :disabled="busy || !board.projectNo"
            @click="exportMaterials"
          >
            {{ bi('导出物料清单(Excel)', 'Export materials (Excel)') }}
          </button>

          <!-- 推送宜搭 — a PLACEHOLDER, and it says so in the words a factory uses. It is deliberately
               present-and-disabled rather than absent: 宜搭 is on the customer's own roadmap, and an
               operator who is looking for it deserves「还没接入」rather than silence that reads as
               「这个系统不支持」. It is not a permission gate, so it is not an R-11 decoy. -->
          <button
            type="button"
            class="sp-board__button sp-board__button--placeholder"
            data-testid="stock-prep-project-board-yida"
            disabled
            :title="bi('宜搭推送暂未接入', 'Pushing to Yida is not connected yet')"
          >
            {{ bi('推送宜搭(暂未接入)', 'Push to Yida (not connected yet)') }}
          </button>
        </div>

        <p v-if="handoffNotice" class="sp-board__notice" data-testid="stock-prep-project-board-handoff-notice" role="status">
          {{ handoffNotice }}
        </p>
        <p v-if="exportEmptyNotice" class="sp-board__notice" data-testid="stock-prep-project-board-export-empty">
          {{ bi(
            '这个项目号下没有有效的物料行,已下载一份仅含表头的空白模板。',
            'This project number has no active material rows — an empty, headers-only template was downloaded.',
          ) }}
        </p>
      </section>

      <!-- ── 4. 填写区 ──────────────────────────────────────────────────────────────────────────
           Filling happens in the multitable grid, not here — this page has no editable cell by
           design. What it offers is the shortest path to the right sheet. -->
      <section class="sp-board__fill" data-testid="stock-prep-project-board-fill">
        <template v-if="board.fillTarget">
          <button
            type="button"
            class="sp-board__fill-cta"
            data-testid="stock-prep-project-board-open-multitable"
            @click="openFillTarget"
          >
            {{ bi('到多维表填写这个项目', 'Open the multitable to fill this project in') }}
          </button>
          <p class="sp-board__fill-hint">
            {{ bi(
              '打开的是备料主表。表里是这台系统上所有项目的行,请按项目号找您这一个 —— 目前还不能只显示一个项目。',
              'This opens the stock-preparation table. It holds the rows for every project on this system, so find yours by project number — filtering it down to a single project is not available yet.',
            ) }}
          </p>
        </template>
        <template v-else>
          <!-- NO HANDLE IS NOT NO DESTINATION. The board only issues a `fillTarget` when the server
               has proved the bound sheet exists AND is this tenant's own; without one there is still
               the plain multitable workbench, which is exactly where the legacy tab's own button
               goes. So the control stays, says plainly that it cannot land on the right sheet, and
               opens the workbench — never nothing, which is what a no-op button teaches an operator
               to expect from every other button too. -->
          <button
            type="button"
            class="sp-board__fill-cta sp-board__fill-cta--fallback"
            data-testid="stock-prep-project-board-open-multitable-fallback"
            @click="openFillTarget"
          >
            {{ bi('打开多维表', 'Open the multitable') }}
          </button>
          <p class="sp-board__fill-hint" data-testid="stock-prep-project-board-no-fill-target">
            {{ bi(
              '填写用的备料主表还没建好,所以没法直接跳到那张表 —— 这个按钮只会打开多维表首页。请管理员在「安装 / 体检」里把表建出来。',
              'The stock-preparation table you would fill in has not been created yet, so there is no direct jump to it — this button opens the multitable home instead. Ask an administrator to create it on the Install / Health tab.',
            ) }}
          </p>
        </template>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
// 项目备料页 — THE PAGE THAT STRINGS THE FOUR STEPS TOGETHER.
//
// WHAT THIS COMPONENT IS, AND WHAT IT DELIBERATELY IS NOT.
//
// It is COMPOSITION. Every part of the operator's flow already shipped and none of it is reimplemented
// here: the project search is #5445's directory and its three-way empty state, the pull is the
// existing 项目接入 panel (with #5435's large-BOM progress inside it, unforked), the export is
// #5437's client and the same download trigger, and the 通知下一步 button is #5442's contract. What
// this file adds is the ONE read that lets those four sit on a page in an order that matches the job,
// and the sentences that say which one to press next.
//
// IT HAS NO EDITABLE CELL, on purpose. Filling stays in the multitable grid, where the column-level
// write permissions and the human-field wall already live. A cell here would be a second write path
// into the same rows with none of that behind it.
//
// THE DEEP LINK IS A LINK, NOT A PERMISSION CHECK. The board returns a handle only when the sheet
// exists; whether this operator may open it is multitable's answer, given when they land. The page
// says nothing to the contrary, and the fill-area copy says plainly that the sheet holds every
// project's rows — because a transient per-project filter turned out to need changes across the
// multitable view model and ACL layers, and promising a filter we did not build would be worse than
// the honest sentence.
import { computed, onMounted, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import StockPreparationProjectSyncPanel from './StockPreparationProjectSyncPanel.vue'
import {
  readStockPreparationOperatorDirectory,
  exportStockPreparationPrepLines,
  type StockPreparationOperatorDirectory,
  type StockPreparationOperatorProject,
} from '../../../services/integration/stockPreparation/confirmationQueue'
import {
  advanceStockPreparationHandoff,
  readStockPreparationHandoff,
  readStockPreparationProjectBoard,
  type StockPreparationHandoffCursor,
  type StockPreparationProjectBoard,
} from '../../../services/integration/stockPreparation/projectBoard'
import type { StockPreparationProjectSyncApi } from '../../../services/integration/stockPreparation/projectSync'
import type { StockPreparationLargeBomJobApi } from '../../../services/integration/stockPreparation/largeBomPull'
import {
  stockPrepBoardErrorPlain,
  stockPrepErrorPlain,
  type StockPrepPlainEntry,
  type StockPrepPlainText,
} from '../../../services/integration/stockPreparation/plainLanguage'
import { canRunStockPrepProjectSync } from '../../../services/integration/stockPreparation/workbenchAccess'
import { useAuth } from '../../../composables/useAuth'

const props = withDefaults(
  defineProps<{
    scope?: IntegrationScope
    /** Seeded from the shell's `?projectNo=` query so a reload or a shared link keeps the project. */
    projectNo?: string
    /** Test seam ONLY — forwarded to the composed sync panel so specs never hit a real endpoint. */
    syncApi?: StockPreparationProjectSyncApi | null
    /** Test seam ONLY — forwarded to the large-BOM sub-panel. */
    largeBomApi?: StockPreparationLargeBomJobApi | null
    /** Test seam ONLY — forwarded so specs never wait on a real timer. */
    largeBomPollWait?: ((ms: number) => Promise<void>) | null
  }>(),
  { scope: () => ({}), projectNo: '', syncApi: null, largeBomApi: null, largeBomPollWait: null },
)

const emit = defineEmits<{
  /** Reuses the shell's ONE tab-nav surface. */
  (e: 'navigate-stage', viewKey: string): void
  /**
   * The shell owns routing; this view composes no route. `null` means "no handle — open the plain
   * multitable workbench", which is what the legacy tab's own button does. It is never "do nothing".
   */
  (e: 'open-multitable', target: { sheetId: string; viewId: string } | null): void
  /** Mirrors the opened project into the shell's `?projectNo=` query. */
  (e: 'select-project-no', projectNo: string): void
}>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const projectNoInput = ref<string>(props.projectNo ?? '')
const busy = ref(false)
/**
 * A RE-READ IS NOT A TEARDOWN. `busy` covers a first load, where there is nothing on screen to
 * protect; `refreshing` covers a re-read of a board the operator is already looking at. Keeping the
 * two apart is the whole fix for the report that used to vanish the instant a run finished.
 */
const refreshing = ref(false)
const errorCode = ref<string | null>(null)
/**
 * WHICH VOCABULARY THE LAST FAILURE BELONGS TO. This page mixes a read (the board) with two actions
 * that genuinely write or download (通知下一步, 导出), and 「这一步没有保存成功」 is right for one of
 * those and wrong for the other. The shape is recorded per ACTION rather than assumed per page.
 */
const errorShape = ref<'read' | 'write'>('read')
/**
 * REQUEST GENERATION. Every load takes a ticket; only the newest ticket may write to the page.
 *
 * THE BUG. A refresh triggered by a finishing pull is in flight for a network round trip, and the
 * operator can open a DIFFERENT project inside that window — the 「打开这个项目」 button was not
 * disabled during a refresh, and the refresh branch did not re-check which project it was for. Its
 * response then landed on top of the project they had just opened: the wrong board, silently, with
 * no error and nothing on screen to suggest the numbers belonged to another job.
 */
let loadGeneration = 0
const board = ref<StockPreparationProjectBoard | null>(null)
const handoff = ref<StockPreparationHandoffCursor | null>(null)
const handoffNotice = ref<string>('')
const exportEmptyNotice = ref(false)
const directory = ref<StockPreparationOperatorDirectory | null>(null)
/** The number a load actually asked for — frozen at request time, decoupled from the live input. */
const openedProjectNo = ref<string>('')

const directoryProjects = computed<StockPreparationOperatorProject[]>(() => {
  // `Array.isArray` rather than a truthiness check: a degraded or partial payload must leave the
  // operator with an empty list, never a blank page from a thrown computed.
  const projects = directory.value && Array.isArray(directory.value.projects) ? directory.value.projects : []
  return projects.filter((project) => typeof project.projectNo === 'string' && project.projectNo.length > 0)
})

/**
 * MAY THIS CALLER PRESS 从PLM拉取数据 — the same predicate the composed panel gates its own control
 * on, so the empty state below can never point at a button this caller does not have.
 */
const canRunPull = computed<boolean>(() => canRunStockPrepProjectSync((permission) => auth.hasPermission(permission)))

const projectKnown = computed<boolean>(() =>
  directoryProjects.value.some((project) => project.projectNo === openedProjectNo.value))

/**
 * WHICH empty state, if any — decided by #5445's pure helper rather than inline, so the copy and the
 * condition it belongs to cannot drift apart. `pendingRowCount` is 1 when a board is in hand, which
 * is how the helper is told "there is something to show, render no empty state at all".
 */
const emptyPlain = computed<StockPrepPlainEntry | null>(() => {
  if (board.value) return null
  if (openedProjectNo.value === '') return null

  // THE ANSWER IS RIGHT BELOW THIS SENTENCE, so say so.
  //
  // The directory's three-way empty state was written for the CONFIRMATION QUEUE, where there is no
  // pull button and 「请管理员先把项目同步进来」 is genuinely the next step. On this page that is a
  // dead end pointing away from the fix: 从PLM拉取数据 renders directly underneath, and this operator
  // may press it. Sending them to find an administrator when the control is six inches below is the
  // same class of wrong answer as 「都清了」 for a project nobody has ever heard of.
  //
  // So the board says the honest thing FIRST — this number has no data here yet — and names the
  // control. The administrator sentence is kept for the one case where it is true: the pull panel is
  // absent because this caller may not press it.
  if (canRunPull.value) {
    return {
      zh: `这个项目号在您这里还没有数据。`,
      en: 'There is no data for this project number here yet.',
      zhNext: '可以直接用下面的「从PLM拉取数据」把它拉进来。如果号码是打错的,改一下再打开。',
      enNext: 'Use 从PLM拉取数据 just below to pull it in. If the number was a typo, correct it and open again.',
    }
  }
  return {
    zh: '这个项目号在您这里还没有数据,而拉取数据不是您能做的一步。',
    en: 'There is no data for this project number here yet, and pulling it in is not a step you can run.',
    zhNext: '请找有备料操作权限的同事或平台管理员把它拉进来;也请顺便核对一下号码有没有打错。',
    enNext: 'Ask a colleague with the stock-preparation operator permission, or a platform administrator, to pull it in — and check the number for a typo while you are at it.',
  }
})

/**
 * THE FAILURE SENTENCE, and which table it comes from. A board read that failed says so as a READ;
 * an export or a handoff that failed keeps the write vocabulary the rest of this workbench uses.
 */
const errorText = computed<StockPrepPlainText>(() => {
  const code = errorCode.value
  if (!code) return stockPrepBoardErrorPlain('')
  return errorShape.value === 'write' ? stockPrepErrorPlain(code) : stockPrepBoardErrorPlain(code)
})

/**
 * The banner is suppressed when the empty state below is already explaining the SAME fact. A 404 on
 * a project number is one event, and rendering it twice — once as "that did not save" and once as
 * "this project has no data yet" — was two answers to one question, one of which was false.
 */
const visibleErrorCode = computed<string | null>(() => {
  const code = errorCode.value
  if (!code) return null
  if (emptyPlain.value && code === 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND') return null
  return code
})

/**
 * 表里有多少行 — THE OPERATOR'S OWN EVIDENCE. Counted in the sheet `apply` writes, not in the MVP
 * snapshot tables an administrator archives, because those two answer different questions and only
 * this one answers 「我刚才拉进来了吗?」.
 */
const rowsText = computed<string>(() => {
  const current = board.value
  if (!current) return '—'
  if (!current.pullTargetReady) return bi('备料主表还没建好', 'The stock-preparation table is not set up yet')
  if (current.pulledRowCount === 0) return bi('还没有行', 'No rows yet')
  const atLeast = current.pulledRowCountBounded
  const total = atLeast
    ? bi(`超过 ${current.pulledRowCount} 行`, `more than ${current.pulledRowCount} row(s)`)
    : bi(`${current.pulledRowCount} 行`, `${current.pulledRowCount} row(s)`)
  if (current.activePulledRowCount === current.pulledRowCount) return total
  return bi(
    `${total},其中 ${current.activePulledRowCount} 行还有效`,
    `${total}, ${current.activePulledRowCount} of them still active`,
  )
})

const pullStateText = computed<string>(() => {
  const current = board.value
  if (!current) return '—'
  // THE ROWS DECIDE, not the archive's runId. `lastSyncRunId` is written by mvp-persist, which is
  // platform-admin — so on an operator's own successful pull it stays null, and reading it here was
  // what made the bar say 「还没从 PLM 拉过这个项目」 over a table full of rows they had just
  // imported. If there are rows for this project, it has been pulled. That is not an inference.
  if (current.pulledRowCount > 0) {
    if (current.activePulledRowCount < current.pulledRowCount) {
      return bi(
        `已拉进来,${current.activePulledRowCount} 行可以用(另有 ${current.pulledRowCount - current.activePulledRowCount} 行已失效)`,
        `Pulled in — ${current.activePulledRowCount} row(s) usable (${current.pulledRowCount - current.activePulledRowCount} no longer active)`,
      )
    }
    return bi(`已拉进来,${current.activePulledRowCount} 行可以用`, `Pulled in, ${current.activePulledRowCount} row(s) usable`)
  }
  if (!current.pullTargetReady) {
    return bi(
      '看不到备料主表,所以说不准拉没拉过',
      'The stock-preparation table cannot be read, so whether it was pulled is unknown',
    )
  }
  return bi('还没从 PLM 拉过这个项目', 'This project has not been pulled from PLM yet')
})

/**
 * 管理员留存的快照 — subordinate, and labelled as somebody else's numbers. Absent is the NORMAL
 * shape for an operator's own run (mvp-persist stayed platform-admin), so absence is stated as
 * "nobody has archived it", never as "nothing was pulled".
 */
const archiveText = computed<StockPrepPlainEntry>(() => {
  const current = board.value
  if (!current || !current.archivedSnapshotPresent) {
    return {
      zh: '管理员还没有为这个项目留存快照 —— 这不影响您上面的数据,只影响「差异对比」。',
      en: 'An administrator has not archived a snapshot of this project — that does not affect your data above, only the diff view.',
    }
  }
  return {
    zh: `管理员留存的快照:${current.snapshotBatchCount} 批,${current.heldLineCount} 行卡着、${current.readyLineCount} 行就绪,${current.openExceptionCount} 个未处理的问题。`,
    en: `Administrator's archived snapshot: ${current.snapshotBatchCount} batch(es), ${current.heldLineCount} row(s) held and ${current.readyLineCount} ready, ${current.openExceptionCount} open issue(s).`,
  }
})

/**
 * 轮到谁. Three honest answers, and the first one is the important one: a deployment with no handoff
 * chain must not be told a turn it does not have.
 */
const turnText = computed<string>(() => {
  const cursor = handoff.value
  if (!cursor) return bi('这台系统没有设置流转顺序', 'No handoff order is set up on this system')
  if (cursor.completed || cursor.terminal) return bi('已经走完最后一步', 'The last step is done')
  const step = cursor.currentStepKey ?? ''
  const position = cursor.stepIndex !== null && cursor.stepCount > 0
    ? bi(`(第 ${cursor.stepIndex + 1}/${cursor.stepCount} 步)`, ` (step ${cursor.stepIndex + 1} of ${cursor.stepCount})`)
    : ''
  if (!step) return bi('还没开始', 'Not started yet')
  return cursor.isCurrentHandler
    ? bi(`轮到您了${position}`, `It is your turn${position}`)
    : bi(`${step}${position}`, `${step}${position}`)
})

const lastExportText = computed<string>(() => {
  const at = board.value?.lastExportAt
  if (!at) return bi('还没导出过', 'Never exported')
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime())) return bi('还没导出过', 'Never exported')
  return parsed.toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US')
})

/**
 * 最近变更(来自 PLM) — the latest `lastPlmRefreshAt` the board saw across this project's pulled rows.
 *
 * NOT "上次同步". `lastPlmRefreshAt` is written by the conflict planner's `runPatch`, which only rides
 * along an add/update/inactive DECISION (stock-preparation-conflict-planner.cjs makeAddDecision /
 * makeUpdateDecision / makeInactiveDecision). `makeSkipDecision` — the decision an UNCHANGED row gets
 * — calls no `runPatch` at all, so a sync where nothing changed leaves every row's stamp exactly where
 * the LAST sync that changed something left it. A BOM that has been stable for a week and pulled
 * every day since would show a week-old timestamp here even though the pull ran (and answered
 * "nothing changed") every single day. The label and this tooltip say so; do not read this as
 * "拉取成功的时间" anywhere this value is surfaced.
 *
 * THREE STATES, and the middle one exists only because the scan behind it can be TRUNCATED:
 *   * `lastChangedFromPlmBounded` — the row scan hit its page bound before it could see every row, and
 *     an unordered, offset-paged scan cannot safely report a partial max (a row past the bound could
 *     carry a NEWER stamp than anything seen). This is deliberately NOT the same message as "never
 *     changed" — the data may have changed recently, the page just could not prove it.
 *   * `lastChangedFromPlmAt === null` (not bounded) — no rows carry the stamp yet, or the bound target
 *     does not bind the (optional) `lastPlmRefreshAt` column. `—`, same as every other absent
 *     timestamp on this card.
 *   * otherwise — the timestamp, formatted exactly like `lastExportText`.
 */
const lastChangedFromPlmText = computed<string>(() => {
  const current = board.value
  if (!current) return '—'
  if (current.lastChangedFromPlmBounded) {
    return bi(
      '行数超过看板上限,未统计',
      'Row count exceeds the board scan limit — not counted',
    )
  }
  const at = current.lastChangedFromPlmAt
  if (!at) return '—'
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US')
})

const notifyTitle = computed<string>(() => {
  const cursor = handoff.value
  if (!cursor) return ''
  if (cursor.terminal) return bi('已经是最后一步了', 'This is already the last step')
  if (!cursor.isCurrentHandler) return bi('现在不是轮到您,所以不用您来通知', 'It is not your turn, so this is not yours to send')
  return ''
})

async function run(work: () => Promise<void>, shape: 'read' | 'write' = 'read'): Promise<void> {
  busy.value = true
  errorCode.value = null
  errorShape.value = shape
  try {
    await work()
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    // The fallback code differs by shape for the same reason the copy does: an unlabelled read
    // failure must not borrow the confirm surface's "nothing was saved" identity.
    errorCode.value = typeof code === 'string'
      ? code
      : (shape === 'write' ? 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED' : 'STOCK_PREPARATION_PROJECT_BOARD_READ_FAILED')
  } finally {
    busy.value = false
  }
}

/**
 * The directory is loaded ONCE, on mount, for the search box. It is loaded independently of any
 * board read: an operator arriving with nothing typed must still see their own projects in the
 * type-ahead, and a directory failure must not stop a board read that was going to work.
 */
async function loadDirectory(): Promise<void> {
  try {
    directory.value = await readStockPreparationOperatorDirectory(props.scope)
  } catch {
    directory.value = null
  }
}

/**
 * READ ONE PROJECT'S BOARD.
 *
 * `mode: 'refresh'` is the load that happens UNDER the operator — after a pull finishes, while they
 * are reading the four-step report that just appeared. It must not unmount anything.
 *
 * THE BUG THIS FIXES. `@synced="reloadBoard"` fires inside the sync panel's emit, and the first
 * statement of the old loader was `board.value = null`. Vue therefore tore the whole
 * `v-if="board"` subtree down — the composed sync panel with it — BEFORE it had ever rendered the
 * finished report, and rebuilt a fresh panel with empty state once the re-read resolved. The
 * operator watched their own run's result flash out of existence at the moment it succeeded.
 *
 * A refresh now keeps the current board on screen, swaps on success, and — critically — leaves it
 * alone on failure: a background re-read that 500s must not take away numbers that were correct a
 * second ago. A FIRST load still clears, because there is nothing to protect and stale numbers from
 * a different project would be worse than none.
 */
async function loadBoard(projectNo: string, mode: 'open' | 'refresh' = 'open'): Promise<void> {
  const mine = ++loadGeneration
  const target = projectNo.trim()
  const refresh = mode === 'refresh' && board.value !== null && openedProjectNo.value === target
  openedProjectNo.value = target
  if (!refresh) {
    board.value = null
    handoff.value = null
    handoffNotice.value = ''
    exportEmptyNotice.value = false
  }
  if (!target) return
  if (refresh) {
    refreshing.value = true
    errorCode.value = null
    errorShape.value = 'read'
    try {
      const next = await readStockPreparationProjectBoard({ ...props.scope, projectNo: target })
      const nextHandoff = await readStockPreparationHandoff({ ...props.scope, projectNo: target })
      // STALE RESPONSES ARE DROPPED, not rendered. If a newer load started while this one was in
      // flight — the operator opened another project — this answer is about a project nobody is
      // looking at any more, and writing it would silently show them the wrong board.
      if (mine !== loadGeneration || openedProjectNo.value !== target) return
      board.value = next
      handoff.value = nextHandoff
    } catch {
      // A BACKGROUND re-read that fails says nothing. The operator did not ask for it, the numbers
      // on screen are still the ones that were correct a moment ago, and an error banner about a
      // request they never made is noise that outlives the failure.
    } finally {
      if (mine === loadGeneration) refreshing.value = false
    }
    return
  }
  await run(async () => {
    const next = await readStockPreparationProjectBoard({ ...props.scope, projectNo: target })
    // The handoff route may not exist on this deployment. `null` means "render no button", and only
    // an absent/unconfigured route produces it — a real failure still surfaces as an error code.
    const nextHandoff = await readStockPreparationHandoff({ ...props.scope, projectNo: target })
    if (mine !== loadGeneration || openedProjectNo.value !== target) return
    board.value = next
    handoff.value = nextHandoff
  })
}

async function openProject(): Promise<void> {
  const target = projectNoInput.value.trim()
  if (!target) return
  emit('select-project-no', target)
  await loadBoard(target)
}

/**
 * The sync panel's `@synced`. A REFRESH, never a reload: the panel that emitted this is still on
 * screen showing the run it just finished, and the operator is reading it.
 */
async function reloadBoard(): Promise<void> {
  if (!openedProjectNo.value) return
  await loadBoard(openedProjectNo.value, 'refresh')
}

async function notifyNext(): Promise<void> {
  const current = board.value
  const cursor = handoff.value
  if (!current || !current.projectNo || !cursor || !cursor.isCurrentHandler || cursor.terminal) return
  handoffNotice.value = ''
  // A WRITE: 「这一步没有保存成功」 is the right sentence when this one fails.
  await run(async () => {
    const result = await advanceStockPreparationHandoff({ ...props.scope, projectNo: current.projectNo as string })
    handoff.value = await readStockPreparationHandoff({ ...props.scope, projectNo: current.projectNo as string })
    // The three outcomes are said as three different sentences because they are three different
    // facts. "已经通知" on a deployment whose notifier is not configured would be a claim we cannot
    // back — the turn moved, and nobody was told.
    if (result.notifyOutcome === 'sent') {
      handoffNotice.value = bi('已经交给下一步,并且通知到了。', 'Handed to the next step, and they were notified.')
    } else if (result.changed) {
      handoffNotice.value = bi(
        '已经交给下一步。这台系统没有配通知渠道,所以没有发出提醒 —— 记得口头知会一声。',
        'Handed to the next step. This system has no notification channel configured, so no alert was sent — tell them yourself.',
      )
    } else {
      handoffNotice.value = bi('这一步已经交出去了,没有重复交。', 'This step had already been handed on; it was not handed on twice.')
    }
  }, 'write')
}

async function exportMaterials(): Promise<void> {
  const projectNo = board.value?.projectNo
  if (!projectNo) return
  exportEmptyNotice.value = false
  // A DOWNLOAD, which the workbench's write vocabulary already covers correctly ("that did not
  // save" is wrong, but this table's export entries say what actually happened).
  await run(async () => {
    const result = await exportStockPreparationPrepLines({ ...props.scope, projectNo })
    triggerExportDownload(result.blob, result.filename)
    exportEmptyNotice.value = result.activeRowCount === 0
  }, 'write')
}

/** The same client-side trigger #5437 uses: a Blob object URL + a synthetic `<a download>` click,
 *  never a direct `<a href>` to the API (which would carry no Authorization header). */
function triggerExportDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * The shell owns routing — this view hands it the handle the server proved exists, or `null`.
 *
 * IT NEVER DOES NOTHING. The old body returned early when there was no `fillTarget`, which made the
 * composed panel's 「到多维表看数据」 a dead button on this tab: the panel renders that link off its
 * own run verdict, which knows nothing about whether a deep-link handle was issued. A button that
 * silently ignores a click is worse than an absent one, because it teaches an operator that clicks
 * on this page may or may not mean anything. `null` tells the shell to open the plain multitable
 * workbench, which is exactly where the legacy tab's own button goes.
 */
function openFillTarget(): void {
  emit('open-multitable', board.value?.fillTarget ?? null)
}

watch(() => props.projectNo, (next) => {
  const target = (next ?? '').trim()
  if (!target || target === openedProjectNo.value) return
  projectNoInput.value = target
  void loadBoard(target)
})

onMounted(async () => {
  await loadDirectory()
  const seeded = (props.projectNo ?? '').trim()
  if (seeded) await loadBoard(seeded)
})
</script>

<style scoped>
.sp-board {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}

.sp-board__lede {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.sp-board__search {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-3);
}

.sp-board__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.sp-board__field input {
  min-width: 240px;
  padding: 6px 8px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  font: inherit;
}

.sp-board__open,
.sp-board__button,
.sp-board__fill-cta {
  padding: 7px 14px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
  font: inherit;
  cursor: pointer;
}

.sp-board__open:disabled,
.sp-board__button:disabled,
.sp-board__fill-cta:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.sp-board__button--placeholder {
  border-style: dashed;
}

.sp-board__error,
.sp-board__empty,
.sp-board__notice {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.sp-board__empty-next {
  display: block;
  margin-top: 4px;
}

.sp-board__token {
  margin-left: 6px;
  font-size: 12px;
  color: var(--ms-text-3);
}

.sp-board__status {
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
}

.sp-board__title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  margin: 0 0 var(--ms-space-3);
  font-size: 15px;
}

.sp-board__name {
  color: var(--ms-text-2);
  font-weight: 400;
}

.sp-board__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--ms-space-3);
  margin: 0;
}

.sp-board__fact dt {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-board__fact dd {
  margin: 2px 0 0;
  color: var(--ms-text-1);
  font-size: 13px;
}

.sp-board__pending {
  margin: var(--ms-space-3) 0 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.sp-board__link {
  border: none;
  background: none;
  padding: 0;
  color: var(--ms-color-primary, #1677ff);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}

.sp-board__actions {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-board__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.sp-board__fill {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
}

.sp-board__fill-cta {
  align-self: flex-start;
  font-weight: 600;
}

.sp-board__fill-hint {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.sp-board__fill-cta--fallback {
  font-weight: 400;
  border-style: dashed;
}

/* Subordinate by design: the archive is somebody else's numbers, not the answer to 「拉过了吗?」. */
.sp-board__archive {
  margin: var(--ms-space-3) 0 0;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.7;
}

.sp-board__pull {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}
</style>
