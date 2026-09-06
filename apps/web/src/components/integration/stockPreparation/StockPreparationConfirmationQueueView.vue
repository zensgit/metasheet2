<template>
  <div class="stock-prep-confirm" data-testid="stock-prep-confirmation-queue">
    <p class="stock-prep-confirm__scope" data-testid="stock-prep-confirmation-scope">
      {{ bi(
        '这里列出系统拿不准、需要您拿主意的事。每一条说明是什么情况,您选一个处理办法,系统按您的决定继续。列表本身不显示具体内容,只有点开某一条时才会读出您填过的值。',
        'This is where the system lists what it cannot decide on its own. Each row says what the situation is; you pick how to handle it and the system carries on from there. The list itself shows no content — what you typed is read back only when you open a single row.',
      ) }}
    </p>

    <!-- CONTROL GATING (O2 / R-11). Every control below renders only when its capability is granted
         by `canStockPrepCapability`, which mirrors the server gate exactly. A control that would 403
         is never in the DOM — no disabled-but-present decoy, because a disabled control still tells
         the operator the capability exists here, and the matrix suite asserts on presence. -->
    <div class="stock-prep-confirm__bar">
      <!-- 项目号 with a NATIVE datalist. The list carries every project in the caller's own tenant,
           each option's VALUE being the number and its LABEL the name, so the browser's own
           type-ahead filters on either — which is the whole point: an operator who only remembers
           「注射水缓冲罐」 can now find 230920006 without being told it. The input stays a plain text
           field, so the hand-typed path a trained operator already uses is unchanged. -->
      <label class="stock-prep-confirm__field">
        <span>{{ bi('项目号(可按号码或名称搜)', 'Project no. (search by number or name)') }}</span>
        <input
          v-model="projectNo"
          type="text"
          list="stock-prep-project-directory-options"
          data-testid="stock-prep-confirmation-project-input"
          :placeholder="bi('项目号或名称', 'Project number or name')"
        >
        <datalist id="stock-prep-project-directory-options" data-testid="stock-prep-operator-project-datalist">
          <option
            v-for="project in directoryProjects"
            :key="project.projectId"
            :value="project.projectNo ?? ''"
          >{{ project.projectName ?? '' }}</option>
        </datalist>
      </label>

      <label class="stock-prep-confirm__field">
        <span>{{ bi('只看这种进展', 'Show only') }}</span>
        <select v-model="statusFilter" data-testid="stock-prep-confirmation-status-filter">
          <option value="">{{ bi('全部', 'All') }}</option>
          <option v-for="status in STOCK_PREPARATION_DECISION_STATUSES" :key="status" :value="status">
            {{ decisionStatusLabel(status) }}
          </option>
        </select>
      </label>

      <button
        v-if="can('confirmationQueue.list')"
        type="button"
        data-testid="stock-prep-confirmation-queue-refresh"
        :disabled="busy"
        @click="loadQueue"
      >
        {{ bi('刷新列表', 'Refresh the list') }}
      </button>

      <!-- 一线看得见自己工厂的项目 — THE capability's control. It renders whenever the capability is
           granted, unconditionally on data: R-11's "what is permitted must be visible" is a statement
           about the PERMISSION, and a control that appeared only once the worklist happened to be
           non-empty would make the alignment assertion depend on fixtures. The worklist itself is
           data-conditional and sits below. -->
      <button
        v-if="can('confirmationQueue.projectDirectory')"
        type="button"
        data-testid="stock-prep-operator-project-directory"
        :disabled="directoryBusy"
        @click="loadDirectory"
      >
        {{ bi('刷新我的项目', 'Refresh my projects') }}
      </button>

      <button
        v-if="can('confirmationQueue.readiness')"
        type="button"
        data-testid="stock-prep-confirmation-readiness"
        :disabled="busy"
        @click="loadReadiness"
      >
        {{ bi('检查是否准备好', 'Check it is ready') }}
      </button>

      <!-- 按项目导出物料 Excel — 仓库/采购 take this after the approval chain completes. Gated one
           notch tighter than the queue (same code as "看我填过什么"), because the workbook carries
           material names and quantities, not just handles/enums. -->
      <button
        v-if="can('confirmationQueue.export')"
        type="button"
        data-testid="stock-prep-confirmation-export"
        :disabled="busy || !projectNo"
        :title="!projectNo ? bi('先填项目号', 'Enter a project number first') : ''"
        @click="exportMaterials"
      >
        {{ bi('导出物料清单(Excel)', 'Export materials (Excel)') }}
      </button>

      <!-- 通知下一步 — A TURN SIGNAL, NOT A GUARD.
           Several people fill their own fields on this project's rows in order; this button moves
           whose-turn-it-is on one notch and tells the group chat who is up next (the last step also
           tells 仓库/采购). It decides NOTHING about who may write which column — per-column write
           enforcement is a separate, deferred decision.
           The `isCurrentHandler` half of the condition is COURTESY, not enforcement: the server
           re-checks it on the advance and answers 403 NOT_CURRENT_HANDLER regardless of what this
           template rendered. Hiding the button simply keeps five people from all seeing a button
           that only one of them can use.
           This pair is why `handoff.read`/`handoff.advance` carry `control: null` in the manifest:
           they are additionally gated on RUNTIME state, so presence ≠ grant and the F-04 matrix
           cannot measure them. StockPreparationHandoff.spec.ts covers their visibility instead. -->
      <!-- J1: the SECOND condition is the resend. The owed-notice invitation above is only honest if
           the button it names is on screen, and in that state `isCurrentHandler` is false — the turn
           has already moved on; what is outstanding is the message for the hop this caller completed.
           The server decides both (it holds the monotonic claim column and the step rosters); the
           page only renders what it is told. `completed` is deliberately NOT a bar on this branch: a
           terminal hop whose claim was interrupted leaves the chain finished and the 仓库/采购 notice
           still owed, which is the single most important message this feature sends. -->
      <button
        v-if="can('handoff.advance') && handoff.configured
          && ((handoff.isCurrentHandler && !handoff.completed) || handoffResendableStepKey)"
        type="button"
        data-testid="stock-prep-handoff-advance"
        :disabled="busy || !projectNo"
        :title="!projectNo ? bi('先填项目号', 'Enter a project number first') : ''"
        @click="advanceHandoff"
      >
        {{ handoffResendableStepKey
          ? bi('通知下一步(补发上一步的群消息)', 'Notify the next person (resend the previous step\'s message)')
          : (handoff.terminal
            ? bi('通知仓库和采购', 'Notify warehouse & purchasing')
            : bi('通知下一步', 'Notify the next person')) }}
      </button>

      <!-- Platform-admin capabilities. Reconcile performs a SOURCE READ (and consumes a B2a
           operation claim when armed); ensure PROVISIONS the ledger table. Both stay owner-level, so
           an operator never sees either. -->
      <button
        v-if="can('confirmationQueue.ensure')"
        type="button"
        data-testid="stock-prep-confirmation-ensure"
        :disabled="busy"
        @click="emit('admin-action', 'ensure')"
      >
        {{ bi('创建确认账本(管理员)', 'Create the confirmation ledger (admin)') }}
      </button>

      <button
        v-if="can('confirmationQueue.reconcile')"
        type="button"
        data-testid="stock-prep-confirmation-reconcile"
        :disabled="busy"
        @click="emit('admin-action', 'reconcile')"
      >
        {{ bi('重新扫描待确认的事(管理员)', 'Re-scan for things to confirm (admin)') }}
      </button>
    </div>

    <!-- The clamped enum code is what a person quotes when they ask us for help, so it stays on
         screen — subordinate to a sentence that says what actually happened to their data. -->
    <p v-if="errorCode" class="stock-prep-confirm__error" data-testid="stock-prep-confirmation-error">
      {{ bi(errorPlain(errorCode).zh, errorPlain(errorCode).en) }}
      <code class="stock-prep-confirm__token">{{ errorCode }}</code>
    </p>

    <!-- The download still happened — a valid, headers-only workbook — this is purely the notice. -->
    <p v-if="exportEmptyNotice" class="stock-prep-confirm__hint" data-testid="stock-prep-confirmation-export-empty">
      {{ bi(
        '这个项目号下没有有效的物料行,已下载一份仅含表头的空白模板。',
        'This project number has no active material rows — an empty, headers-only template was downloaded.',
      ) }}
    </p>

    <!-- 一线看得见自己工厂的项目 — THE WORKLIST. Rendered on mount, before anything is typed, so the
         page opens on "here is your work" instead of on an empty box demanding a number the operator
         was supposed to have memorised. Only projects with pending work appear here; the full
         directory is still behind the input's datalist above, which is what lets the empty states
         below tell "unknown number" from "nothing pending". -->
    <section
      v-if="can('confirmationQueue.projectDirectory') && worklist.length > 0"
      class="stock-prep-confirm__worklist"
      data-testid="stock-prep-operator-project-worklist"
    >
      <h3>{{ bi('您这边等着处理的项目', 'Projects waiting on you') }}</h3>
      <ul>
        <li v-for="project in worklist" :key="project.projectId">
          <button
            type="button"
            class="stock-prep-confirm__worklist-item"
            data-testid="stock-prep-operator-project-pick"
            :disabled="busy || !project.projectNo"
            @click="pickProject(project)"
          >
            <span class="stock-prep-confirm__worklist-no">{{ project.projectNo }}</span>
            <span class="stock-prep-confirm__worklist-name">{{ project.projectName }}</span>
            <span class="stock-prep-confirm__worklist-count">
              {{ bi('等您处理', 'waiting') }}: {{ project.pendingDecisionCount }}
            </span>
          </button>
        </li>
      </ul>
    </section>
    <!-- Whose turn it is. Renders for ANYONE who could read the status — the point of a turn signal
         is that the other four people can see it too, not only the one person holding the turn. A
         deployment with no chain configured renders nothing at all here. -->
    <p v-if="handoff.configured" class="stock-prep-confirm__hint" data-testid="stock-prep-handoff-status">
      <template v-if="handoff.completed">
        {{ bi('这个项目的备料接力已经走完。', 'The handoff chain for this project has run to the end.') }}
      </template>
      <template v-else>
        {{ bi('当前在:', 'Currently with: ') }}{{ handoffStepLabel(handoff.currentStepKey) }}
        <code v-if="handoff.currentStepKey" class="stock-prep-confirm__token">{{ handoff.currentStepKey }}</code>
      </template>
    </p>

    <!-- STILL OWED, STILL SENDABLE. The first version of this banner fired on exactly this state and
         told the operator it could NOT be resent — copy that discourages the one click that fixes it.
         It is an invitation now, and it renders only for the handler who can actually act on it. -->
    <p
      v-if="handoffResendableStepKey"
      class="stock-prep-confirm__hint"
      data-testid="stock-prep-handoff-notification-resendable"
    >
      {{ bi(
        '上一跳的群通知还没发出去,再点一次「通知下一步」就会补发。',
        'The group notice for the previous step has not gone out yet — press 通知下一步 again and it will be sent.',
      ) }}
      <code class="stock-prep-confirm__token">{{ handoffResendableStepKey }}</code>
    </p>

    <!-- GONE FOR GOOD. A later hop's claim moved the monotonic max past this one, so nothing the
         system can do will send it. Named from the append-only trail, because an interior gap has no
         other representation. -->
    <p
      v-if="handoffLostStepKeys.length > 0"
      class="stock-prep-confirm__hint"
      data-testid="stock-prep-handoff-notification-gap"
    >
      {{ bi(
        `「${handoffLostStepLabels}」这一步的群通知没发出去,系统已经不能补发了 —— 请您口头跟相关的人确认一下。`,
        `The group notice for "${handoffLostStepLabels}" never went out and can no longer be resent — please confirm with the people involved in person.`,
      ) }}
    </p>

    <!-- What just happened to the turn AND to the message — two separate facts, said as two facts.
         The enum stays on screen subordinate to the sentence, like every other token on this page. -->
    <p v-if="handoffNoticeText" class="stock-prep-confirm__hint" data-testid="stock-prep-handoff-notice">
      {{ handoffNoticeText }}
      <code v-if="handoffNoticeToken" class="stock-prep-confirm__token">{{ handoffNoticeToken }}</code>
    </p>

    <p v-if="readiness !== null" class="stock-prep-confirm__readiness" data-testid="stock-prep-confirmation-readiness-result">
      {{ readiness.ready === true
        ? bi('可以开始:记录确认结果的表已经建好了。', 'Ready to go: the table that records your decisions is in place.')
        : bi('还不能开始:记录确认结果的表还没建好,需要管理员先创建。', 'Not ready yet: the table that records your decisions has not been created — an admin has to create it first.') }}
    </p>

    <div v-if="queue" class="stock-prep-confirm__counts" data-testid="stock-prep-confirmation-counts">
      <span>{{ bi('等您处理', 'Waiting for you') }}: {{ queue.rowCount }}</span>
      <span>{{ bi('先挂起的', 'Parked for later') }}: {{ queue.parkedCount }}</span>
    </div>

    <table v-if="queue && queue.rows.length > 0" class="stock-prep-confirm__table" data-testid="stock-prep-confirmation-rows">
      <thead>
        <tr>
          <th>{{ bi('编号', 'Reference') }}</th>
          <th>{{ bi('什么情况', 'What happened') }}</th>
          <th>{{ bi('进展', 'Where it stands') }}</th>
          <th>{{ bi('已选的处理办法', 'How it was handled') }}</th>
          <th>{{ bi('填过值了吗', 'Value filled in') }}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in queue.rows" :key="row.decisionId || ''" data-testid="stock-prep-confirmation-row">
          <td><code class="stock-prep-confirm__token">{{ row.decisionId }}</code></td>
          <td>{{ row.conflictType }}</td>
          <td>
            <span>{{ decisionStatusLabel(row.status) }}</span>
            <code v-if="row.status" class="stock-prep-confirm__token">{{ row.status }}</code>
          </td>
          <td>
            <span>{{ decisionActionLabel(row.resolutionAction) }}</span>
            <code v-if="row.resolutionAction" class="stock-prep-confirm__token">{{ row.resolutionAction }}</code>
          </td>
          <!-- PRESENCE only — the queue never carries the value itself. -->
          <td>{{ row.resolvedValuePresent ? bi('是', 'yes') : bi('否', 'no') }}</td>
          <td>
            <button
              v-if="can('confirmationQueue.valueEntry')"
              type="button"
              data-testid="stock-prep-confirmation-value-entry"
              :disabled="busy || !row.decisionId"
              @click="loadValueEntry(row.decisionId)"
            >
              {{ bi('看我填过什么', 'See what I entered') }}
            </button>
            <button
              v-if="can('confirmationQueue.confirm')"
              type="button"
              data-testid="stock-prep-confirmation-select"
              :disabled="busy || !row.decisionId || !isConfirmableConflictType(row.conflictType)"
              :title="rowUnconfirmableReason(row) || undefined"
              @click="selectRow(row)"
            >
              {{ bi('我来定…', 'I\'ll decide…') }}
            </button>
            <!-- SAY WHY, AND SAY WHAT WOULD WORK. A disabled button with no reason sends the
                 operator to support; this row's whole problem is that the answer is not in this
                 page at all. -->
            <p
              v-if="rowUnconfirmableReason(row)"
              class="stock-prep-confirm__row-hint"
              data-testid="stock-prep-confirmation-unconfirmable-hint"
            >
              {{ rowUnconfirmableReason(row) }}
            </p>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- EMPTY-STATE HONESTY. This used to be one sentence — 「都清了」 — shown for three unrelated
         situations: nothing was ever synced here, the number was mistyped, and the project really is
         clear. Only the last is good news. `stockPrepDirectoryEmptyState` decides which of the four
         it actually is from facts the server now returns, and each carries the next step (or says
         plainly that the next step is not the operator's to take). -->
    <p
      v-else-if="queue && emptyState"
      class="stock-prep-confirm__empty"
      data-testid="stock-prep-confirmation-empty"
      :data-empty-state="emptyState"
    >
      {{ bi(emptyStateText.zh, emptyStateText.en) }}
      <span v-if="emptyStateText.zhNext" class="stock-prep-confirm__hint" data-testid="stock-prep-confirmation-empty-next">
        {{ bi(emptyStateText.zhNext, emptyStateText.enNext ?? '') }}
      </span>
    </p>

    <!-- The value-entry pane: the ONE content-bearing surface, gated on the same code as confirm. -->
    <section
      v-if="valueEntry && can('confirmationQueue.valueEntry')"
      class="stock-prep-confirm__pane"
      data-testid="stock-prep-confirmation-value-entry-pane"
    >
      <h3>{{ bi('您在这一条上填过的内容', 'What you entered on this one') }}</h3>
      <dl>
        <dt>{{ bi('填的值', 'The value you entered') }} <code class="stock-prep-confirm__token">resolvedValue</code></dt>
        <dd data-testid="stock-prep-confirmation-value-entry-value">{{ valueEntry.valueEntry.resolvedValue }}</dd>
        <dt>{{ bi('附带的值', 'The extra value') }} <code class="stock-prep-confirm__token">resolvedAuxValue</code></dt>
        <dd data-testid="stock-prep-confirmation-value-entry-aux">{{ valueEntry.valueEntry.resolvedAuxValue }}</dd>
        <dt>{{ bi('备注', 'Your note') }} <code class="stock-prep-confirm__token">notes</code></dt>
        <dd data-testid="stock-prep-confirmation-value-entry-notes">{{ valueEntry.valueEntry.notes }}</dd>
      </dl>
    </section>

    <!-- The confirm form: the frozen action vocabulary + the Q2-A value fields, one gate. -->
    <form
      v-if="selected && can('confirmationQueue.confirm')"
      class="stock-prep-confirm__form"
      data-testid="stock-prep-confirmation-form"
      @submit.prevent="submitConfirm"
    >
      <h3>{{ bi('这一条您打算怎么处理', 'How do you want to handle this one') }}</h3>
      <label class="stock-prep-confirm__field">
        <span>{{ bi('处理办法', 'What to do') }}</span>
        <select v-model="resolutionAction" data-testid="stock-prep-confirmation-action-select">
          <option v-for="action in STOCK_PREPARATION_RESOLUTION_ACTIONS" :key="action" :value="action">
            {{ decisionActionLabel(action) }}
          </option>
        </select>
      </label>
      <p v-if="selectedActionHint" class="stock-prep-confirm__hint" data-testid="stock-prep-confirmation-action-hint">
        {{ selectedActionHint }}
      </p>
      <label class="stock-prep-confirm__field">
        <span>{{ bi('填一个值(按上面的办法需要时)', 'A value, if the choice above needs one') }}</span>
        <input v-model="resolvedValue" type="text" data-testid="stock-prep-confirmation-value-input">
      </label>
      <label class="stock-prep-confirm__field">
        <span>{{ bi('附带的值(可不填)', 'An extra value (optional)') }}</span>
        <input v-model="resolvedAuxValue" type="text" data-testid="stock-prep-confirmation-aux-input">
      </label>
      <label class="stock-prep-confirm__field">
        <span>{{ bi('备注:为什么这么定(可不填)', 'Note: why you decided this (optional)') }}</span>
        <input v-model="notes" type="text" data-testid="stock-prep-confirmation-notes-input">
      </label>
      <button type="submit" data-testid="stock-prep-confirmation-confirm" :disabled="busy">
        {{ bi('就这么定', 'Save this decision') }}
      </button>
    </form>

    <!-- Everything this pane used to lead with, kept and one click away: the frozen server
         vocabularies (which is what an implementer matches a support thread against) and the exact
         field names a request body carries. -->
    <StockPrepTechnicalDetails testid="stock-prep-confirmation-tech">
      <dl>
        <dt>{{ bi('进展枚举', 'Decision status vocabulary') }}</dt>
        <dd>
          <span v-for="status in STOCK_PREPARATION_DECISION_STATUSES" :key="status">
            <code>{{ status }}</code> = {{ decisionStatusLabel(status) }};
          </span>
        </dd>
        <dt>{{ bi('处理办法枚举(服务端冻结)', 'Resolution-action vocabulary (frozen server-side)') }}</dt>
        <dd>
          <span v-for="action in STOCK_PREPARATION_RESOLUTION_ACTIONS" :key="action">
            <code>{{ action }}</code> = {{ decisionActionLabel(action) }};
          </span>
        </dd>
        <dt>{{ bi('请求体字段名', 'Request-body field names') }}</dt>
        <dd><code>resolvedValue</code> · <code>resolvedAuxValue</code> · <code>notes</code> · <code>inputFingerprint</code></dd>
        <dt>{{ bi('队列投影是 values-free 的', 'The queue projection is values-free') }}</dt>
        <dd>
          {{ bi(
            '队列只携带计数、指纹、状态与动作枚举;值内容仅在单条「值录入」读取中出现。',
            'The queue carries counts, fingerprints and the status/action enums only; entered content appears solely in the per-decision value-entry read.',
          ) }}
        </dd>
      </dl>
    </StockPrepTechnicalDetails>
  </div>
</template>

<script setup lang="ts">
// O1' / O2 — the confirmation-queue operator pane of `/stock-prep`.
//
// Two disciplines govern this file:
//
//  1. R-11 ALIGNMENT. Control visibility is decided ONLY by `canStockPrepCapability` over the shared
//     capability manifest (workbenchAccess.ts, mirrored from the plugin module the server gates
//     with). No control hand-rolls a `hasPermission('stock-prep:…')` probe, because the operate tier
//     is a conjunction and a hand-rolled probe would drift. A control the caller cannot exercise is
//     ABSENT, not disabled.
//  2. VALUES-FREE except one pane. The queue projection carries presence booleans; only the
//     value-entry pane renders content, and it renders under the same gate the server puts on that
//     read. Errors surface as the CLAMPED enum-shaped code from confirmApi.ts — never a server
//     message, which could carry a value.
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  STOCK_PREPARATION_DECISION_STATUSES,
  STOCK_PREPARATION_RESOLUTION_ACTIONS,
  advanceStockPreparationHandoff,
  confirmStockPreparationDecision,
  exportStockPreparationPrepLines,
  listStockPreparationDecisions,
  readStockPreparationDecisionReadiness,
  readStockPreparationHandoff,
  readStockPreparationOperatorDirectory,
  readStockPreparationValueEntry,
  type StockPreparationDecisionQueue,
  type StockPreparationDecisionReadiness,
  type StockPreparationDecisionRow,
  type StockPreparationDecisionStatus,
  type StockPreparationDecisionValueEntry,
  type StockPreparationHandoffAdvanceResult,
  type StockPreparationHandoffStatus,
  type StockPreparationOperatorDirectory,
  type StockPreparationOperatorProject,
  type StockPreparationResolutionAction,
  isConfirmableConflictType,
} from '../../../services/integration/stockPreparation/confirmationQueue'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  canStockPrepCapability,
} from '../../../services/integration/stockPreparation/workbenchAccess'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import {
  STOCK_PREP_DECISION_ACTION_PLAIN,
  STOCK_PREP_DECISION_STATUS_PLAIN,
  stockPrepDirectoryEmptyPlain,
  stockPrepDirectoryEmptyState,
  stockPrepEnumPlain,
  stockPrepErrorPlain,
  stockPrepHandoffOutcomePlain,
  stockPrepHandoffStepPlain,
  type StockPrepPlainEntry,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = defineProps<{ scope: IntegrationScope; projectNo?: string }>()
const emit = defineEmits<{ (event: 'admin-action', action: 'ensure' | 'reconcile'): void }>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const capabilityById = computed(() => {
  const byId = new Map<string, (typeof STOCK_PREP_WORKBENCH_CAPABILITIES)[number]>()
  for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) byId.set(capability.capability, capability)
  return byId
})

/** THE single visibility predicate. Unknown capability ids fail closed. */
function can(capabilityId: string): boolean {
  const capability = capabilityById.value.get(capabilityId)
  if (!capability) return false
  return canStockPrepCapability(capability, (permission) => auth.hasPermission(permission))
}

/**
 * The server vocabularies, in words. Both fall back to the raw token for anything the table does not
 * know, so a status or action added server-side reads exactly as it does today rather than blanking.
 */
function decisionStatusLabel(status: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_DECISION_STATUS_PLAIN, status)
  return plain ? bi(plain.zh, plain.en) : (status ?? '—')
}

function decisionActionLabel(action: string | null): string {
  const plain = stockPrepEnumPlain(STOCK_PREP_DECISION_ACTION_PLAIN, action)
  return plain ? bi(plain.zh, plain.en) : (action ?? '—')
}

const errorPlain = stockPrepErrorPlain

/** The step vocabulary in words, degrading to the raw key exactly like the two labels above. */
function handoffStepLabel(key: string | null): string {
  const plain = stockPrepHandoffStepPlain(key ?? '')
  return plain ? bi(plain.zh, plain.en) : (key ?? '—')
}

const projectNo = ref<string>(props.projectNo ?? '')
const statusFilter = ref<StockPreparationDecisionStatus | ''>('')
const busy = ref(false)
const errorCode = ref<string | null>(null)
const queue = ref<StockPreparationDecisionQueue | null>(null)
const readiness = ref<StockPreparationDecisionReadiness | null>(null)
const valueEntry = ref<StockPreparationDecisionValueEntry | null>(null)
const selected = ref<StockPreparationDecisionRow | null>(null)
const resolutionAction = ref<StockPreparationResolutionAction>('keep_multiple_rows')
const resolvedValue = ref('')
const resolvedAuxValue = ref('')
const notes = ref('')
/** Set after a successful export whose project had zero ACTIVE material rows — the download still
 *  happened (a valid, headers-only workbook), this is purely the plain-language notice for it. */
const exportEmptyNotice = ref(false)

// --- 一线看得见自己工厂的项目 ------------------------------------------------------------------
//
// The caller's OWN-TENANT project directory. Loaded on mount so the page opens on the operator's work
// rather than on an empty input; the server refuses this read to any principal without a tenant of
// its own, so nothing here can show one tenant another tenant's names.
const directory = ref<StockPreparationOperatorDirectory | null>(null)

const directoryProjects = computed<StockPreparationOperatorProject[]>(() => {
  // `Array.isArray` rather than a truthiness check on `directory.value`: this page renders whatever
  // the envelope parser hands back, and a degraded or partial payload (an older server, a truncated
  // response) must leave the operator with an empty list, never a blank page from a thrown computed.
  const projects = directory.value && Array.isArray(directory.value.projects) ? directory.value.projects : []
  // Only rows that actually carry a number can be picked or typed — a nameless/numberless row would
  // be an unselectable datalist entry, which is worse than absent.
  return projects.filter((project) => typeof project.projectNo === 'string' && project.projectNo.length > 0)
})

/** The worklist proper: the projects with something waiting, busiest first, then by number. */
const worklist = computed<StockPreparationOperatorProject[]>(() =>
  directoryProjects.value
    .filter((project) => project.pendingDecisionCount > 0)
    .slice()
    .sort((left, right) => (right.pendingDecisionCount - left.pendingDecisionCount)
      || String(left.projectNo).localeCompare(String(right.projectNo))))

/** Does the number currently in the box name a project in the caller's own directory? */
const projectKnown = computed<boolean>(() =>
  directoryProjects.value.some((project) => project.projectNo === projectNo.value))

/**
 * WHICH empty state, if any. Decided by the pure helper in plainLanguage.ts rather than inline, so
 * the copy and the condition it belongs to cannot drift apart.
 *
 * NO DIRECTORY IS ITSELF A STATE, not silence. Returning null here — which the first version did
 * whenever `directory.value` was null — rendered NOTHING for the three principals who never get a
 * directory: a `stock-prep:read`-only queue watcher (no request is issued for them at all), an
 * operate-holder whose load failed, and the tenantless platform admin the server refuses by design.
 * All three previously saw 「都清了」; a blank page is a worse answer than a wrong one, because the
 * operator cannot even tell the page finished loading.
 */
const emptyState = computed<string | null>(() => {
  const loaded = directory.value
  return stockPrepDirectoryEmptyState({
    directoryAvailable: loaded !== null,
    // Coerced defensively for the same reason as above: a partial payload must degrade to the most
    // conservative diagnosis ("nothing synced"), never crash and never claim "all clear".
    directoryReady: loaded !== null && loaded.directoryReady === true,
    ledgerReady: loaded !== null && loaded.ledgerReady === true,
    projectCount: loaded !== null && typeof loaded.projectCount === 'number'
      ? loaded.projectCount
      : directoryProjects.value.length,
    projectNo: projectNo.value,
    projectKnown: projectKnown.value,
    pendingRowCount: queue.value && Array.isArray(queue.value.rows) ? queue.value.rows.length : 0,
  })
})

const emptyStateText = computed<StockPrepPlainEntry>(() =>
  stockPrepDirectoryEmptyPlain(emptyState.value) ?? { zh: '', en: '' })

/**
 * The directory load has its OWN busy flag rather than sharing `busy` with the queue.
 *
 * That is not tidiness. `busy` disables the queue's own controls, and this load starts on mount — so
 * sharing it would leave 「刷新列表」 and every other control dead for the duration of a request the
 * operator did not ask for, and would make "can I click refresh yet" depend on a race with a
 * background fetch. The two concerns are independent and their spinners must be too.
 */
const directoryBusy = ref(false)

/**
 * THE TWO SERVER REFUSALS THAT ARE NOT FAULTS.
 *
 * The directory read is scoped to the caller's OWN tenant and requires the host to vouch for the
 * pairing, so it refuses two whole classes of principal BY DESIGN:
 *
 *   OPERATOR_SCOPE_TENANT_REQUIRED     — a tenantless platform admin (us: the consultant, support).
 *                                        They pass the permission gate and are then refused because
 *                                        they have no tenant of their own, which is the guard doing
 *                                        its job, not an outage.
 *   OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE — the deployment injects no host membership seam, so the
 *                                        read fails closed. Nothing the person at the screen can do.
 *
 * Both arrive on MOUNT, unprompted, which put a red write-flavoured error line on the page for every
 * platform admin on every single page open. Neither is actionable and neither is news, so neither
 * becomes an error banner. They are not silent, either: `directory_unavailable` renders in the empty
 * state and says exactly what is and is not known. The list is a CLOSED set of two codes — any other
 * failure, a 500 included, still surfaces, because a directory that genuinely broke IS news.
 */
const DIRECTORY_NOT_FOR_THIS_PRINCIPAL = Object.freeze([
  'OPERATOR_SCOPE_TENANT_REQUIRED',
  'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE',
])

async function loadDirectory(): Promise<void> {
  if (!can('confirmationQueue.projectDirectory')) return
  directoryBusy.value = true
  try {
    directory.value = await readStockPreparationOperatorDirectory(props.scope)
  } catch (error) {
    if (error instanceof StockPreparationConfirmApiError
      && DIRECTORY_NOT_FOR_THIS_PRINCIPAL.includes(error.code)) {
      // Not an error to report — see above. `directory.value` stays null, which is what the empty
      // state reads to say "no worklist for you, and we cannot judge this number".
      return
    }
    // Every other failure surfaces on the page's one error line like any other — an operator whose
    // worklist silently failed to load would read the empty page as "no work", which is the exact
    // dishonesty this change exists to remove.
    recordError(error)
  } finally {
    directoryBusy.value = false
  }
}

/** Pick a project from the worklist: fill the number the typed path already uses, then load it. */
async function pickProject(project: StockPreparationOperatorProject): Promise<void> {
  if (!project.projectNo) return
  projectNo.value = project.projectNo
  await loadQueue()
}

// The page opens on the operator's own work. A caller without the capability loads nothing and sees
// exactly the surface they saw before this change.
onMounted(() => {
  void loadDirectory()
})

/**
 * 通知下一步 state. INERT is the fail-soft resting position, and it is what the view holds whenever
 * the status is unknown for ANY reason — no project number typed yet, no `handoff.read` grant, a
 * deployment whose backend predates this route, or a rejected fetch. `configured: false` renders no
 * control and no status line, which is exactly the behaviour of a deployment that has not set a
 * chain up, so an outage degrades to "feature absent" rather than to a broken queue.
 */
const HANDOFF_INERT: StockPreparationHandoffStatus = Object.freeze({
  configured: false,
  projectNo: '',
  steps: [],
  stepCount: 0,
  stepIndex: null,
  currentStepKey: null,
  terminal: false,
  completed: false,
  isCurrentHandler: false,
  notifiedStepIndex: null,
  notificationsConfigured: false,
  resendableStepKey: null,
  lostStepKeys: [],
})

const handoff = ref<StockPreparationHandoffStatus>(HANDOFF_INERT)
/** The last advance's result — the source of the plain-language notice, cleared on each new press. */
const handoffAdvance = ref<StockPreparationHandoffAdvanceResult | null>(null)

/**
 * What to tell the operator after an advance.
 *
 * THE DISCRIMINATOR IS `notifyOutcome`, NOT `changed`, and that correction is the whole of this
 * comment. `changed` says whether the TURN moved; it says nothing about whether a message went out.
 * Those two used to be the same question, and the first version of this notice short-circuited on
 * `changed === false` and printed 「没有重复通知」.
 *
 * They came apart when the notification claim became a compare-and-set of its own: a request that is
 * BOTH a replay and the one that finally sends the owed notice is now ordinary, and so is the same
 * request FAILING to send it. On the old wording an operator whose resend had just failed — or
 * half-failed across 仓库 and 采购 — was told in words that nothing needed sending. The claim is spent
 * by then, so no later click can ever resend it: being told the wrong thing here is terminal, and the
 * group that missed the notice is never chased.
 *
 * So: if something was actually attempted (sent / partial / failed), say what happened to it. Only
 * `skipped` and `not_configured` on an unchanged turn are genuinely "nothing needed sending".
 */
const handoffNoticeText = computed<string>(() => {
  const result = handoffAdvance.value
  if (!result) return ''
  const attempted = result.notifyOutcome === 'sent'
    || result.notifyOutcome === 'partial'
    || result.notifyOutcome === 'failed'
  // J2: `resumed` is the COMMITTED verdict that this click took the claim, so a request carrying it
  // may never render the replay sentence — whatever the outcome. The first cut checked only
  // `attempted`, which left one outcome ('not_configured', now 'no_destination') reaching the
  // 「没什么要发」 wording on a click that had just spent the hop's one chance to be announced.
  if (result.changed === false && !attempted && result.resumed !== true) {
    return bi(
      '这一步之前已经交接过了,没有重复通知。',
      'This step had already been handed on, so nobody was notified a second time.',
    )
  }
  const plain = stockPrepHandoffOutcomePlain(result.notifyOutcome)
  if (!plain) return bi('已经交给下一步了。', 'It has been handed on to the next step.')
  const lead = bi(plain.zh, plain.en)
  const next = bi(plain.zhNext ?? '', plain.enNext ?? '')
  const body = next ? `${lead} ${next}` : lead
  // A RESUME is not the same event as a first advance and must not be described as one: the turn
  // moved earlier, and what this click did was send the notice that hop had been owed since.
  if (result.resumed === true) {
    return `${bi('这一跳之前没发出去的通知,这次补发了。', 'The notice this step had been owed was sent now.')} ${body}`
  }
  return body
})

/** The enum, kept on screen but subordinate — what a person quotes when they ask us about it. */
const handoffNoticeToken = computed<string | null>(() => handoffAdvance.value?.notifyOutcome ?? null)

/**
 * IS THERE A HOP WHOSE NOTICE NEVER WENT OUT? The claim is monotonic, so once a later hop is claimed
 * an earlier owed one can never be sent by anyone — pressing the button again does not help, and
 * until this line existed nothing on the screen said so.
 *
 * Two guards, both load-bearing. `notificationsConfigured` keeps a deliberate turn-state-only
 * deployment — whose `notifiedStepIndex` is null forever and correctly so — from being told it has
 * lost every notice it never meant to send. And the comparison is against `stepIndex - 1` because the
 * CURRENT hop has not been handed off yet: its notice is not late, it is not due.
 */
const handoffLostStepKeys = computed<string[]>(() => {
  const state = handoff.value
  if (!state.configured) return []
  return Array.isArray(state.lostStepKeys) ? state.lostStepKeys : []
})

/** The step whose notice is still owed AND still sendable by this caller. Server-computed. */
const handoffResendableStepKey = computed<string | null>(() => {
  const state = handoff.value
  if (!state.configured) return null
  return typeof state.resendableStepKey === 'string' && state.resendableStepKey ? state.resendableStepKey : null
})

/** The committed labels for the lost hops, so the sentence names them rather than counting them. */
const handoffLostStepLabels = computed<string>(() =>
  handoffLostStepKeys.value.map((key) => handoffStepLabel(key)).join('、'))

/** What the currently chosen handling actually does, in one line, before the operator commits. */
const selectedActionHint = computed<string>(() => {
  const plain = stockPrepEnumPlain(STOCK_PREP_DECISION_ACTION_PLAIN, resolutionAction.value)
  if (!plain) return ''
  const entry = STOCK_PREP_DECISION_ACTION_PLAIN[resolutionAction.value]
  return bi(entry?.zhNext ?? '', entry?.enNext ?? '')
})

/** Only the clamped enum code reaches state — a server message could carry a value. */
function recordError(error: unknown): void {
  errorCode.value = error instanceof StockPreparationConfirmApiError
    ? error.code
    : 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED'
}

async function run(task: () => Promise<void>): Promise<void> {
  busy.value = true
  errorCode.value = null
  try {
    await task()
  } catch (error) {
    recordError(error)
  } finally {
    busy.value = false
  }
}

/**
 * Whose turn it is, read FAIL-SOFT and deliberately OUTSIDE `run()`.
 *
 * Outside, because the turn signal is an addition to this page, not a precondition of it: a
 * deployment whose backend predates the handoff route, or one having a bad minute, must leave the
 * confirmation queue — the only page a floor operator has — working exactly as before. So this
 * swallows its own failure into INERT (feature absent) and never touches `errorCode` or `busy`.
 */
async function loadHandoff(): Promise<void> {
  if (!projectNo.value || !can('handoff.read')) {
    handoff.value = HANDOFF_INERT
    return
  }
  try {
    const status = await readStockPreparationHandoff({ ...props.scope, projectNo: projectNo.value })
    handoff.value = status && typeof status === 'object' ? status : HANDOFF_INERT
  } catch {
    handoff.value = HANDOFF_INERT
  }
}

/**
 * The queue refresh is this view's ONE load-on-demand entry point (there is no watcher and no
 * onMounted here — the operator types a project number and presses 刷新列表), so the turn signal
 * rides it rather than introducing a second refresh idiom the file does not otherwise use.
 */
async function loadQueue(): Promise<void> {
  await run(async () => {
    queue.value = await listStockPreparationDecisions({
      ...props.scope,
      projectNo: projectNo.value,
      status: statusFilter.value === '' ? null : statusFilter.value,
    })
  })
  await loadHandoff()
}

async function loadReadiness(): Promise<void> {
  await run(async () => {
    readiness.value = await readStockPreparationDecisionReadiness(props.scope)
  })
}

async function loadValueEntry(decisionId: string | null): Promise<void> {
  if (!decisionId) return
  await run(async () => {
    valueEntry.value = await readStockPreparationValueEntry({ ...props.scope, decisionId })
  })
}

/** Same client-side trigger the generic Multitable export uses (MultitableWorkbench.vue): a Blob
 *  object URL + a synthetic `<a download>` click, never a direct `<a href>` to the API (which would
 *  carry no Authorization header) and never window.open. */
function triggerExportDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function exportMaterials(): Promise<void> {
  if (!projectNo.value) return
  exportEmptyNotice.value = false
  await run(async () => {
    const result = await exportStockPreparationPrepLines({ ...props.scope, projectNo: projectNo.value })
    triggerExportDownload(result.blob, result.filename)
    exportEmptyNotice.value = result.activeRowCount === 0
  })
}

/**
 * 通知下一步. `fromStepKey` is the step this view BELIEVES is current; the server compares it to the
 * one it actually holds and answers 409 STEP_MISMATCH when somebody else moved first — which is why
 * a stale page cannot double-advance the chain. The server also re-checks that the caller is the
 * current handler; the button's `isCurrentHandler` condition is courtesy, not the gate.
 */
async function advanceHandoff(): Promise<void> {
  // FINISH WHAT IS OWED BEFORE MOVING ON. When a hop's notice is still unsent, replaying THAT hop is
  // what sends it; advancing the current one instead would claim the next step and push the monotonic
  // max past the owed hop, losing it for good. So the resend wins when both are possible — which is
  // also what the invitation on screen promises the click will do.
  const fromStepKey = handoffResendableStepKey.value ?? handoff.value.currentStepKey
  if (!projectNo.value || !fromStepKey) return
  handoffAdvance.value = null
  await run(async () => {
    handoffAdvance.value = await advanceStockPreparationHandoff({
      ...props.scope,
      projectNo: projectNo.value,
      fromStepKey,
    })
    await loadHandoff()
  })
}

/**
 * Why this row cannot be decided here, in the operator's own words — or `''` when it can.
 *
 * The confirm endpoint implements exactly one conflict type today; every other row answers 409 with
 * "resolutionAction is not valid for this conflict type", which reads like "pick a different
 * option" when in fact no option on this page will ever work. Observed against the customer's own
 * PLM on 2026-09-04: BOM lines pointing at parts absent from the parts library hold as
 * `missing_component`, land in this queue as pending, and cannot be cleared from here at all — the
 * only way out is repairing the source, after which the next sync closes these entries by itself.
 * So the row says that, instead of offering three buttons that all fail.
 */
function rowUnconfirmableReason(row: StockPreparationDecisionRow): string {
  if (!row.decisionId) return ''
  if (isConfirmableConflictType(row.conflictType)) return ''
  if (row.conflictType === 'missing_component') {
    return bi(
      '这条在这一页处理不了:BOM 里引用的零件在源系统的物料表里找不到。请到源系统补上该零件(或修正它的编号),下次同步会自动关掉这一条。',
      'This one cannot be settled here: the BOM line points at a part that is not in the source system\'s parts library. Add the part there (or correct its id) and the next sync closes this entry by itself.',
    )
  }
  return bi(
    '这一类目前还不能在这一页确认,系统会拒绝。请联系我们,或先到源系统修正数据后重新同步。',
    'This kind cannot be confirmed here yet — the server refuses it. Contact us, or fix the data in the source system and sync again.',
  )
}

function selectRow(row: StockPreparationDecisionRow): void {
  if (!isConfirmableConflictType(row.conflictType)) return
  selected.value = row
  resolvedValue.value = ''
  resolvedAuxValue.value = ''
  notes.value = ''
}

async function submitConfirm(): Promise<void> {
  const row = selected.value
  if (!row || !row.decisionId || !row.inputFingerprint) return
  await run(async () => {
    await confirmStockPreparationDecision({
      decisionId: row.decisionId as string,
      inputFingerprint: row.inputFingerprint as string,
      resolutionAction: resolutionAction.value,
      resolvedValue: resolvedValue.value,
      resolvedAuxValue: resolvedAuxValue.value,
      notes: notes.value,
    })
    selected.value = null
    await loadQueue()
  })
}

defineExpose({ can })
</script>

<style scoped>
.stock-prep-confirm__scope {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-confirm__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-2);
  margin-bottom: var(--ms-space-3);
}

.stock-prep-confirm__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.stock-prep-confirm__error {
  margin: 0 0 var(--ms-space-3);
  color: var(--el-color-danger, #c45656);
  font-size: 13px;
}

/* A grep-able identifier that is no longer the point of the line: still selectable and copyable,
   visibly subordinate to the sentence beside it. */
.stock-prep-confirm__token {
  display: inline-block;
  margin-left: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 11px;
  word-break: break-all;
}

.stock-prep-confirm__hint {
  flex-basis: 100%;
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}

/* The per-row reason a decision cannot be settled on this page. Same muted treatment as the
   other hints; it sits under a disabled button, so it must not compete with live controls. */
.stock-prep-confirm__row-hint {
  margin: 0.25rem 0 0;
  font-size: 0.85em;
  opacity: 0.85;
  max-width: 34rem;
}

/* 一线看得见自己工厂的项目 — the worklist. Deliberately the widest, plainest thing on the page after
   the input: it is what an operator opens this page to see. */
.stock-prep-confirm__worklist {
  margin-bottom: var(--ms-space-3);
}

.stock-prep-confirm__worklist h3 {
  margin: 0 0 var(--ms-space-2);
  font-size: 13px;
  color: var(--ms-text-2);
}

.stock-prep-confirm__worklist ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stock-prep-confirm__worklist-item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  width: 100%;
  padding: var(--ms-space-2);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: none;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
}

.stock-prep-confirm__worklist-item:disabled {
  cursor: default;
  opacity: 0.6;
}

/* The number stays monospace and selectable — it is what a person quotes on the phone — but the NAME
   is the thing that reads first, which is the whole point of this change. */
.stock-prep-confirm__worklist-no {
  font-family: var(--ms-font-mono, monospace);
  color: var(--ms-text-3);
  font-size: 12px;
}

.stock-prep-confirm__worklist-name {
  flex: 1 1 auto;
  font-weight: 600;
}

.stock-prep-confirm__worklist-count {
  color: var(--ms-text-2);
  font-size: 12px;
}

.stock-prep-confirm__empty {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-confirm__counts {
  display: flex;
  gap: var(--ms-space-3);
  margin-bottom: var(--ms-space-2);
  font-size: 13px;
  color: var(--ms-text-2);
}

.stock-prep-confirm__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.stock-prep-confirm__table th,
.stock-prep-confirm__table td {
  padding: var(--ms-space-2);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
}

.stock-prep-confirm__pane,
.stock-prep-confirm__form {
  margin-top: var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
}

.stock-prep-confirm__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-2);
}
</style>
