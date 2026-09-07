<template>
  <div class="sp-board" data-testid="stock-prep-project-board" data-control="stock-prep-operator-project-board">
    <p class="sp-board__lede" data-testid="stock-prep-project-board-lede">
      {{ bi(
        '一个项目,一页做完:先把 BOM 从 PLM 拉过来,再到多维表里填采购和仓库的进度,填完通知下一步,需要给别人时导出成 Excel。',
        'One project, one page: pull the BOM in from PLM, fill in purchasing and warehouse progress in the multitable, tell the next person when you are done, and export to Excel when someone needs a copy.',
      ) }}
    </p>

    <!-- P0-2 (§2.3 寄生): `?projectNo=` empty renders the task-oriented home page, right here inside
         the SAME `project-board` tab — zero tab-structure change, zero landing-page change. Once a
         project is opened (below, or from a home card) this gives way to the existing workspace,
         which renders exactly as it did before this pass. -->
    <StockPreparationOperatorHome
      v-if="showHome"
      :scope="scope"
      :directory="directory"
      :directory-loaded="directoryLoaded"
      :memory="recentProjects"
      @open-project="onHomeOpenProject"
      @open-project-in-queue="onHomeOpenProjectInQueue"
      @focus-quick-open="focusProjectNoInput"
    />

    <!-- 线框 C ①: the way BACK. Without it `?projectNo=` is a one-way door — once an operator opens
         any project the home page is unreachable for the rest of the browser session, which would
         rebuild on the new landing page exactly the dead end this redesign exists to remove. -->
    <div v-if="!showHome" class="sp-board__back">
      <button
        type="button"
        class="sp-board__back-button"
        data-testid="stock-prep-project-board-back-home"
        @click="goHome"
      >
        {{ bi('‹ 返回今天要处理', '‹ Back to what needs you today') }}
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
    <!-- TWO LINES (P0-5 / I-21): 发生了什么 on the first, 该做什么(含找谁) on the second, plus the
         one payload a person can hand to us. This is the render point that matters most for the
         floor: `HANDOFF_NOT_CURRENT_HANDLER`'s second line 「看上面「轮到谁」…」 has nowhere else to
         appear, because handoff refusals surface here and nowhere else. -->
    <p v-if="visibleErrorCode" class="sp-board__error" data-testid="stock-prep-project-board-error">
      {{ bi(errorText.zh, errorText.en) }}
      <code class="sp-board__token">{{ visibleErrorCode }}</code>
      <span v-if="errorText.zhNext" class="sp-board__hint" data-testid="stock-prep-project-board-error-next">
        {{ bi(errorText.zhNext, errorText.enNext ?? '') }}
      </span>
      <button type="button" data-testid="stock-prep-project-board-error-copy" @click="copyError(visibleErrorCode)">
        {{ errorCopyLabel === 'copy' ? bi('复制这条报错', 'Copy this error') : bi('已复制', 'Copied') }}
      </button>
    </p>

    <!-- THREE-WAY EMPTY STATE, reused verbatim from #5445 rather than re-derived: it is the one
         place that can tell 「号码打错了」 from 「这台系统里还没有任何项目」 from 「表还没建好」. -->
    <p v-if="emptyPlain" class="sp-board__empty" data-testid="stock-prep-project-board-empty">
      {{ bi(emptyPlain.zh, emptyPlain.en) }}
      <span v-if="emptyPlain.zhNext" class="sp-board__empty-next">
        {{ bi(emptyPlain.zhNext, emptyPlain.enNext ?? '') }}
      </span>
    </p>

    <!-- P0-3 「下一步」条 — the workspace's ONE filled primary button (G1). §4.2's seven rules,
         evaluated by the pure `operatorNextStep` — this bar never invents its own priority order. -->
    <section
      v-if="nextStep"
      class="sp-board__next-step"
      data-testid="stock-prep-project-board-next-step"
      :data-next-step="nextStep.key"
    >
      <p class="sp-board__next-step-text">{{ bi(nextStep.zh, nextStep.en) }}</p>
      <button
        v-if="nextStep.action"
        type="button"
        class="sp-board__next-step-button"
        data-testid="stock-prep-project-board-next-step-action"
        data-primary-cta="stock-prep-project-board-next-step"
        @click="onNextStepAction"
      >
        {{ bi(nextStep.actionZh, nextStep.actionEn) }}
      </button>
    </section>

    <!-- ── 1. 搜项目 ────────────────────────────────────────────────────────────────────────────
         The SAME native datalist #5445 built for the confirmation queue: option VALUE is the number
         and option LABEL is the name, so the browser's own type-ahead filters on either. An operator
         who only remembers 「注射水缓冲罐」 finds 230920006 without being told it, and the trained
         operator who types the number keeps the path they already use. -->
    <div class="sp-board__search" :class="{ 'sp-board__search--home': showHome }">
      <label class="sp-board__field">
        <span>{{ bi('项目号(可按号码或名称搜)', 'Project no. (search by number or name)') }}</span>
        <input
          ref="projectNoInputEl"
          v-model="projectNoInput"
          type="text"
          list="stock-prep-board-directory-options"
          data-testid="stock-prep-project-board-input"
          :placeholder="bi('项目号或名称', 'Project number or name')"
          @keyup.enter="openProject"
        >
        <!-- D1=A: the union, not the directory alone. The home page's own caption says the list
             holds "这台电脑最近开过的、和管理员归档过的项目" — so it has to. -->
        <datalist id="stock-prep-board-directory-options" data-testid="stock-prep-project-board-datalist">
          <option
            v-for="project in directoryProjects"
            :key="project.projectId ?? project.projectNo ?? ''"
            :value="project.projectNo ?? ''"
          >{{ project.projectName ?? '' }}</option>
          <option
            v-for="entry in memoryOnlyProjectNos"
            :key="`memory:${entry}`"
            :value="entry"
          >{{ bi('这台电脑最近开过的', 'Recently opened on this computer') }}</option>
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
        ref="syncPanelEl"
        :scope="scope"
        :project-no="openedProjectNo"
        run-variant="pull"
        :run-emphasis="nextStep ? 'secondary' : 'primary'"
        :api="syncApi"
        :large-bom-api="largeBomApi"
        :large-bom-poll-wait="largeBomPollWait"
        @navigate-stage="(key: string) => emit('navigate-stage', key)"
        @open-multitable="openFillTarget"
        @synced="onSyncReportChanged"
        @busy-changed="onSyncBusyChanged"
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
          <!-- P0-6: the workspace title's own posture badge — same word as the home card / the sync
               panel's own status line, one shared `stockPrepPosture` call. -->
          <span
            class="sp-board__posture"
            :class="`sp-board__posture--${posture.tone}`"
            data-testid="stock-prep-project-board-posture"
          >{{ bi(posture.zh, posture.en) }}</span>
        </h3>
        <dl class="sp-board__facts">
          <div class="sp-board__fact" data-testid="stock-prep-project-board-rows">
            <dt :title="bi(rowsTooltip.zh, rowsTooltip.en)">{{ bi('表里有多少行', 'Rows in the table') }}</dt>
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import StockPreparationProjectSyncPanel from './StockPreparationProjectSyncPanel.vue'
import StockPreparationOperatorHome from './StockPreparationOperatorHome.vue'
import {
  exportStockPreparationPrepLines,
  readStockPreparationOperatorDirectory,
  type StockPreparationOperatorDirectory,
  type StockPreparationOperatorProject,
} from '../../../services/integration/stockPreparation/confirmationQueue'
import { readStockPreparationOperatorHomeDirectory } from '../../../services/integration/stockPreparation/operatorHomeDirectory'
import {
  advanceStockPreparationHandoff,
  readStockPreparationHandoff,
  readStockPreparationProjectBoard,
  type StockPreparationHandoffCursor,
  type StockPreparationProjectBoard,
} from '../../../services/integration/stockPreparation/projectBoard'
import type { StockPreparationProjectSyncApi, StockPreparationProjectSyncReport } from '../../../services/integration/stockPreparation/projectSync'
import type { StockPreparationLargeBomJobApi } from '../../../services/integration/stockPreparation/largeBomPull'
import {
  STOCK_PREP_TOOLTIP_ROWS_IN_TABLE,
  stockPrepBoardErrorPlain,
  stockPrepErrorCopyText,
  stockPrepErrorPlain,
  type StockPrepPlainEntry,
  type StockPrepPlainText,
} from '../../../services/integration/stockPreparation/plainLanguage'
import { copyTextToClipboard } from '../../../views/plm/plmClipboard'
import { canRunStockPrepProjectSync } from '../../../services/integration/stockPreparation/workbenchAccess'
import { useAuth } from '../../../composables/useAuth'
import { operatorNextStep, type OperatorNextStepResult } from '../../../services/integration/stockPreparation/operatorNextStep'
import { stockPrepPosture, type StockPrepPosture } from '../../../services/integration/stockPreparation/projectPosture'
import {
  readStockPrepRecentProjects,
  readStockPrepRememberedPosture,
  recordStockPrepProjectVisit,
  type StockPrepRecentProjectEntry,
} from '../../../services/integration/stockPreparation/operatorHomeMemory'

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
const projectNoInputEl = ref<HTMLInputElement | null>(null)
const directory = ref<StockPreparationOperatorDirectory | null>(null)
/** True once the FIRST directory read has settled (success or failure) — see `directoryLoaded` below. */
const directoryLoaded = ref(false)
/**
 * The number a load actually asked for — frozen at request time, decoupled from the live input.
 *
 * SEEDED FROM THE PROP AT SETUP, not in `onMounted`. `showHome` is derived from this, `onMounted`
 * runs AFTER the first render, and the directory read it awaited added a whole network round-trip on
 * top: a mount carrying `?projectNo=` therefore painted a full screen of task home — its
 * 「这里还没有您的项目」 empty state included — before the workspace replaced it, on every deep link
 * and every tab switch back to 项目备料.
 */
const openedProjectNo = ref<string>((props.projectNo ?? '').trim())

// ---------------------------------------------------------------------------
// P0-2/P0-3/P0-6 — the task-oriented home page, the "下一步" bar, and the shared posture badge.
// ---------------------------------------------------------------------------

/**
 * No project open yet — 设计稿 §2.3: `?projectNo=` empty renders the home page, in the SAME tab.
 *
 * `openedProjectNo` is seeded SYNCHRONOUSLY (see `onMounted`) rather than after the directory read
 * resolves. Deriving this from a value that only arrives one network round-trip later meant a mount
 * carrying `?projectNo=` painted a whole screen of task home — 「这里还没有您的项目」 and all —
 * before swapping to the workspace, on every single tab switch back to 项目备料.
 */
const showHome = computed<boolean>(() => openedProjectNo.value === '')

/**
 * D1=A's local half, read ONCE per mount and handed down — the home page never touches storage
 * itself. Re-read (not mutated in place) after each write so the card list reflects what this
 * browser just learned without a second component owning the same state.
 */
const recentProjects = ref<StockPrepRecentProjectEntry[]>(readStockPrepRecentProjects(props.scope))

/** Numbers this browser remembers that the directory does not carry — the F1 gap, for the datalist. */
const memoryOnlyProjectNos = computed<string[]>(() => {
  const known = new Set(directoryProjects.value.map((project) => project.projectNo ?? ''))
  return recentProjects.value.map((entry) => entry.projectNo).filter((no) => !known.has(no))
})

/** The composed sync panel's own report, mirrored up here ONLY so the "下一步" bar can read it. */
const syncReport = ref<StockPreparationProjectSyncReport | null>(null)
const syncBusy = ref(false)
const syncPanelEl = ref<InstanceType<typeof StockPreparationProjectSyncPanel> | null>(null)

/** §4.2 rule 4: this browser saw a `held` verdict for the currently-open project and has not yet
 *  re-run sync. Cleared the moment a DIFFERENT verdict lands, or a different project is opened. */
const wasHeldPending = ref(false)
/** §4.2 rule 4's OWN condition: pending just hit zero while `wasHeldPending` was true. */
const justConfirmedFlag = ref(false)
/**
 * §4.2 rule 4, THE PART THAT SURVIVES AN UNMOUNT. The only way to clear `pendingDecisionCount` in
 * this release is the confirmation-queue tab, and the shell mounts these tabs with `v-if` — no
 * KeepAlive anywhere in the chain — so going to confirm and coming back destroys and rebuilds this
 * whole component. Every session-local flag above is therefore guaranteed to be false at exactly the
 * moment rule 4 is supposed to fire, and the operator would instead be told 「数据都在多维表里了」
 * about rows that were never written. This ref carries the one fact that has to outlive the unmount,
 * read out of the SAME 本机记忆 D8 already sanctions (a closed enum key, nothing else), and captured
 * BEFORE this mount's own `watch(posture)` overwrites it.
 */
const rememberedHeld = ref(false)

const missingComponentsCount = computed<number>(() => {
  const list = syncReport.value?.missingComponents
  if (!list) return 0
  if (list.items.length === 0 && list.distinctCount <= 0) return 0
  return list.distinctCount > 0 ? list.distinctCount : list.items.length
})

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
const errorText = computed<StockPrepPlainEntry>(() => {
  const code = errorCode.value
  if (!code) return stockPrepBoardErrorPlain('')
  return errorShape.value === 'write' ? stockPrepErrorPlain(code) : stockPrepBoardErrorPlain(code)
})

/**
 * 「复制这条报错」(P0-5, I-21). The payload is the CODE plus one committed sentence — never the prose
 * above it, and never anything the server sent — so a person can paste it into a chat without
 * carrying a project number or a part out of the system with it.
 */
const errorCopyLabel = ref<'copy' | 'copied'>('copy')
let errorCopyResetTimer: ReturnType<typeof setTimeout> | null = null
async function copyError(code: string): Promise<void> {
  // Guarded: `copyTextToClipboard`'s fallback calls `document.execCommand`, which a host without any
  // copy mechanism (jsdom included) may not implement at all rather than answering `false`.
  let ok = false
  try {
    ok = await copyTextToClipboard(stockPrepErrorCopyText(code, locale.value === 'zh-CN'))
  } catch {
    ok = false
  }
  if (!ok) return
  errorCopyLabel.value = 'copied'
  if (errorCopyResetTimer) clearTimeout(errorCopyResetTimer)
  errorCopyResetTimer = setTimeout(() => { errorCopyLabel.value = 'copy' }, 3000)
}

// #3365「卸载即作废」.
onBeforeUnmount(() => {
  if (errorCopyResetTimer) clearTimeout(errorCopyResetTimer)
  errorCopyResetTimer = null
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

/** I-20: 表里有多少行's tooltip, the design's own worked example. */
const rowsTooltip = STOCK_PREP_TOOLTIP_ROWS_IN_TABLE

const notifyTitle = computed<string>(() => {
  const cursor = handoff.value
  if (!cursor) return ''
  if (cursor.terminal) return bi('已经是最后一步了', 'This is already the last step')
  if (!cursor.isCurrentHandler) return bi('现在不是轮到您,所以不用您来通知', 'It is not your turn, so this is not yours to send')
  return ''
})

/**
 * P0-6: the workspace title's own posture badge — the second of the "三处同词一致" call sites, fed
 * from THIS page's own live `board` + the composed sync panel's `busy`/report state (via `syncBusy`/
 * `missingComponentsCount` above).
 */
const posture = computed<StockPrepPosture>(() => stockPrepPosture({
  busy: syncBusy.value,
  pendingDecisionCount: board.value?.pendingDecisionCount ?? 0,
  missingComponentsCount: missingComponentsCount.value,
  pulledRowCount: board.value?.pulledRowCount ?? 0,
}))

/**
 * P0-3: the "下一步" bar's input — every field already lives on this page or the composed panel; see
 * operatorNextStep.ts's own header for why this adds no fetch. `null` while no project is open, or
 * while a genuine read failure is already showing its own red banner (G3: that banner is the answer;
 * a second, guessed suggestion underneath it would contradict it — a `boardFound: false` reading of a
 * 500 would wrongly say "never pulled").
 */
const nextStep = computed<OperatorNextStepResult | null>(() => {
  if (!openedProjectNo.value || visibleErrorCode.value) return null
  const cursor = handoff.value
  const step = operatorNextStep({
    boardFound: board.value !== null,
    pulledRowCount: board.value?.pulledRowCount ?? 0,
    missingComponentsCount: missingComponentsCount.value,
    pendingDecisionCount: board.value?.pendingDecisionCount ?? 0,
    justConfirmed: justConfirmed.value,
    hasExported: Boolean(board.value?.lastExportAt),
    isCurrentHandler: Boolean(cursor?.isCurrentHandler && !cursor.terminal),
  })
  // R-11 again: a control the caller cannot exercise is ABSENT, not disabled and not silently inert.
  // Both sync-driving actions are gated by the same predicate the composed panel gates its own run
  // button with, so the bar can never offer a button whose click would be swallowed. The SENTENCE
  // still renders — knowing what the next step is remains useful to someone who has to ask a
  // colleague to press it, and the panel below says in words who that is.
  if ((step.action === 'pull' || step.action === 'resync') && !canRunPull.value) {
    return { ...step, action: null, actionZh: '', actionEn: '' }
  }
  return step
})

/**
 * §4.2 rule 4's real condition: everything this browser knows says the operator has just finished
 * confirming and has not yet re-synced. Either half is enough — the live one for "confirmed without
 * leaving the tab" (P1's embedded panel), the remembered one for the only path P0 actually has.
 * `pulledRowCount > 0` keeps it off a project that has never been pulled at all, where rule 1 owns
 * the bar.
 */
const justConfirmed = computed<boolean>(() => {
  if (justConfirmedFlag.value) return true
  if (!rememberedHeld.value) return false
  if (syncReport.value) return false // a run landed in THIS mount; its verdict is the newer fact
  const current = board.value
  return current !== null && current.pendingDecisionCount === 0 && current.pulledRowCount > 0
})

// justConfirmed tracking (§4.2 rule 4), SESSION-LOCAL and reset whenever a different project opens.
watch(openedProjectNo, () => {
  wasHeldPending.value = false
  justConfirmedFlag.value = false
  syncReport.value = null
  syncBusy.value = false
})

watch(syncReport, (report) => {
  if (!report) return
  wasHeldPending.value = report.verdict === 'held'
  justConfirmedFlag.value = false
  rememberedHeld.value = false
})

watch(() => board.value?.pendingDecisionCount ?? 0, (count) => {
  if (wasHeldPending.value && count === 0) {
    justConfirmedFlag.value = true
    wasHeldPending.value = false
  }
})

// P0-6/D8: refresh this browser's memory of the open project's posture whenever it actually changes —
// see operatorHomeMemory.ts for what is (and is not) stored.
//
// ONLY FOR A PROJECT THAT REALLY RESOLVED. Without the `board` guard a mistyped number would 404,
// leave `board` null, settle on 「还没拉过」 and be remembered forever: the home page would grow a
// permanent junk card per typo, and 30 of them would evict every real entry.
watch(posture, (value) => {
  if (!openedProjectNo.value || board.value === null) return
  recordStockPrepProjectVisit(openedProjectNo.value, value.key, props.scope)
  recentProjects.value = readStockPrepRecentProjects(props.scope)
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
 * The directory read. Loaded independently of any board read: an operator arriving with nothing typed
 * must still see their own projects in the type-ahead, and a directory failure must not stop a board
 * read that was going to work.
 *
 * IT IS TWO DIFFERENT READS, chosen by which of this component's two faces is on screen — and that
 * split is a CONTRACT, not a preference.
 *
 * This one file is both 今天要处理 (the home page, `showHome`) and 项目备料页 (the workspace, a project
 * open). Only the home page needs the U2 union: its cards, its three-sentence banner and its
 * pull-target-only rows all come from `?includePullTargets=1`. The workspace
 * needs none of it — the only thing it renders off `directory` is the search box's datalist, which
 * the plain archived-project list has always filled.
 *
 * And the union is not free. `stock-preparation-operator-project-directory.cjs` states the cost and
 * the owner's ruling on it in its own header: the scan reads the whole binding sheet and pages by
 * LIMIT/OFFSET, so it is quadratic (~2.5·10⁶ rows touched at the 50,000-row bound), and 「项目备料页
 * does not opt in — it runs its own NARROWED scan and must not also pay an unnarrowed one」. The board
 * already pays a narrowed pull-target read of its own (`readPullTargetRowFacts`). Sending the opted-in
 * call from a workspace mount would charge that scan to every single project an operator opens, which
 * the 5-second throttle cannot help with at all — opening A, then B, then C is minutes apart, so it is
 * three full scans.
 *
 * So: home → the opted-in, throttled wrapper. Workspace → the plain call, byte-for-byte what this view
 * sent before this pass. `watch(showHome)` below covers the one transition that flips faces without
 * remounting.
 */
async function loadDirectory(): Promise<void> {
  // Read the face ONCE, up front: `showHome` can flip while the request is in flight, and a `finally`
  // that re-read it could label the response with the wrong mode.
  const home = showHome.value
  try {
    // See operatorHomeDirectory.ts for why the home call (and only it) opts in and throttles: the
    // confirmation queue's own directory read stays the plain, un-opted-in, un-throttled call too.
    directory.value = home
      ? await readStockPreparationOperatorHomeDirectory(props.scope)
      : await readStockPreparationOperatorDirectory(props.scope)
  } catch {
    directory.value = null
  } finally {
    // P0-2: lets the home page tell "the read failed" (directory stays null AFTER this settles) apart
    // from "still loading" (directory is null BEFORE it settles) — see StockPreparationOperatorHome
    // .vue's `directoryAvailable`.
    directoryLoaded.value = true
  }
}

/**
 * 返回今天要处理 — the ONE transition that changes face without changing component.
 *
 * `goHome` (and the shell's `?projectNo=` dropping for any other reason) clears `openedProjectNo` on a
 * component that is already mounted, so nothing re-runs `onMounted`. Without this the home page would
 * render off whatever directory the WORKSPACE mount fetched — the un-opted-in one — and every U2
 * surface would be silently, permanently dead: the three sentences never appear (their fields are
 * absent, and absent means "unknown, say nothing"), and self-service pull-target projects never show
 * up in the card list. So the moment this view comes home, it re-reads with the opt-in.
 *
 * ONE DIRECTION ONLY. Going the other way — home → a project — keeps the union already in hand, which
 * is a superset of what the workspace needs; re-reading there would pay for less data.
 */
watch(showHome, (isHome) => {
  if (isHome) void loadDirectory()
})

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
  // Read the remembered conclusion BEFORE this mount's own `watch(posture)` overwrites it — that
  // watch fires as soon as the board lands, so anything read afterwards would be this mount's own
  // echo rather than what the previous mount left behind. A refresh must not re-read it: by then the
  // entry has already been rewritten, and rule 4 would latch on forever.
  if (!refresh) {
    rememberedHeld.value = target !== ''
      && readStockPrepRememberedPosture(target, props.scope) === 'pending_decision'
  }
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

/** The one place that actually opens a project — the search box below and the home page above both
 *  funnel through this, so "typed a number" and "clicked a home card" can never diverge in behaviour. */
async function openProjectByNo(no: string): Promise<void> {
  const target = no.trim()
  if (!target) return
  projectNoInput.value = target
  emit('select-project-no', target)
  await loadBoard(target)
}

async function openProject(): Promise<void> {
  await openProjectByNo(projectNoInput.value)
}

/** 线框 C ①: back to 今天要处理. The shell owns the URL, so this asks it to drop `?projectNo=`;
 *  the prop watcher below then brings this view home, exactly as a browser Back button would. */
function goHome(): void {
  emit('select-project-no', '')
  void loadBoard('')
}

async function focusProjectNoInput(): Promise<void> {
  await nextTick()
  projectNoInputEl.value?.focus()
}

/** P0-2: a home card / the home page's own fallback input opened a project. */
async function onHomeOpenProject(projectNo: string): Promise<void> {
  await openProjectByNo(projectNo)
}

/** P0-2: a home card whose posture is 等您拿主意 — open the project AND land straight in the queue. */
async function onHomeOpenProjectInQueue(projectNo: string): Promise<void> {
  await openProjectByNo(projectNo)
  emit('navigate-stage', 'confirmation-queue')
}

/**
 * The sync panel's `@synced`. A REFRESH, never a reload: the panel that emitted this is still on
 * screen showing the run it just finished, and the operator is reading it.
 */
async function reloadBoard(): Promise<void> {
  if (!openedProjectNo.value) return
  await loadBoard(openedProjectNo.value, 'refresh')
}

/** P0-3: the composed sync panel just finished a run (or forwarded the large-BOM channel's own). */
function onSyncReportChanged(report: StockPreparationProjectSyncReport | null): void {
  syncReport.value = report
  void reloadBoard()
}

function onSyncBusyChanged(value: boolean): void {
  syncBusy.value = value
}

/**
 * P0-3: the "下一步" bar's ONE button. Each action reuses an existing control's own handler/emit —
 * this function adds no new capability, it only decides which existing one to reach for.
 */
function onNextStepAction(): void {
  const step = nextStep.value
  if (!step || !step.action) return
  if (step.action === 'pull' || step.action === 'resync') {
    // IT ACTUALLY RUNS THE SYNC. An earlier revision only scrolled down to the panel's own run
    // button, which put two nearly-identically-worded buttons on one screen where the upper one did
    // nothing — the exact "which of these do I press" this redesign exists to delete. The panel
    // exposes its single `onRun` (permission- and busy-guarded there too), so there is still only
    // one implementation of what 同步 means.
    void syncPanelEl.value?.run?.()
    return
  }
  if (step.action === 'view-missing') {
    // A LIST, not an action: the missing-parts table is rendered by the panel below, so the honest
    // thing this button can do is put it in front of the operator.
    try {
      syncPanelEl.value?.$el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    } catch {
      // jsdom / an older browser without smooth-scroll support: no-op, never a thrown error.
    }
    return
  }
  if (step.action === 'go-confirm') {
    emit('navigate-stage', 'confirmation-queue')
    return
  }
  if (step.action === 'open-fill') {
    openFillTarget()
    return
  }
  if (step.action === 'notify-next') {
    void notifyNext()
  }
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

/**
 * The shell's `?projectNo=` is the state bit for 首页 ⇄ 工作区 (§2.3), so it has to be followed in
 * BOTH directions. The empty case used to early-return, which meant browser Back — and the shell's
 * own 「返回今天要处理」 — left the workspace on screen with no way out.
 */
watch(() => props.projectNo, (next) => {
  const target = (next ?? '').trim()
  if (target === openedProjectNo.value) return
  projectNoInput.value = target
  void loadBoard(target)
})

onMounted(async () => {
  const seeded = (props.projectNo ?? '').trim()
  await loadDirectory()
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

.sp-board__posture {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.sp-board__posture--warning { background: color-mix(in srgb, var(--ms-color-warning) 16%, transparent); color: var(--ms-color-warning); }
.sp-board__posture--danger { background: color-mix(in srgb, var(--ms-color-danger) 16%, transparent); color: var(--ms-color-danger); }
.sp-board__posture--primary { background: color-mix(in srgb, var(--ms-color-primary) 16%, transparent); color: var(--ms-color-primary); }
.sp-board__posture--success { background: color-mix(in srgb, var(--ms-color-success) 16%, transparent); color: var(--ms-color-success); }
.sp-board__posture--info { background: color-mix(in srgb, var(--ms-color-info) 20%, transparent); color: var(--ms-color-info); }
.sp-board__posture--neutral { background: var(--ms-bg-page); color: var(--ms-text-3); }

.sp-board__back {
  display: flex;
}

.sp-board__back-button {
  padding: 4px 0;
  border: none;
  background: none;
  color: var(--ms-color-primary, #1677ff);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

/* In home mode the search box IS the 「拉一个新项目」 card's input, so it joins the dashed block the
   home page renders directly above it rather than floating loose under the cards. */
.sp-board__search--home {
  margin-top: calc(var(--ms-space-4) * -1);
  padding: 0 var(--ms-space-3) var(--ms-space-3);
  border: 1px dashed var(--ms-border-light);
  border-top: none;
  border-radius: 0 0 8px 8px;
}

.sp-board__next-step {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-3);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-color-primary);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ms-color-primary) 6%, var(--ms-bg-card));
}

.sp-board__next-step-text {
  margin: 0;
  color: var(--ms-text-1);
  font-size: 13px;
  line-height: 1.7;
}

.sp-board__next-step-button {
  flex-shrink: 0;
  padding: 8px 16px;
  border: 1px solid var(--ms-color-primary);
  border-radius: 6px;
  background: var(--ms-color-primary);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
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
