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
      <label class="stock-prep-confirm__field">
        <span>{{ bi('项目号', 'Project no.') }}</span>
        <input
          v-model="projectNo"
          type="text"
          data-testid="stock-prep-confirmation-project-input"
          :placeholder="bi('项目号', 'Project no.')"
        >
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
      <button
        v-if="can('handoff.advance') && handoff.configured && handoff.isCurrentHandler && !handoff.completed"
        type="button"
        data-testid="stock-prep-handoff-advance"
        :disabled="busy || !projectNo"
        :title="!projectNo ? bi('先填项目号', 'Enter a project number first') : ''"
        @click="advanceHandoff"
      >
        {{ handoff.terminal
          ? bi('通知仓库和采购', 'Notify warehouse & purchasing')
          : bi('通知下一步', 'Notify the next person') }}
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
              :disabled="busy || !row.decisionId"
              @click="selectRow(row)"
            >
              {{ bi('我来定…', 'I\'ll decide…') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-else-if="queue" class="stock-prep-confirm__empty" data-testid="stock-prep-confirmation-empty">
      {{ bi('这个项目号下没有需要您处理的事 —— 都清了。', 'Nothing here needs your attention for this project number — it is all clear.') }}
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
import { computed, ref } from 'vue'
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
  readStockPreparationValueEntry,
  type StockPreparationDecisionQueue,
  type StockPreparationDecisionReadiness,
  type StockPreparationDecisionRow,
  type StockPreparationDecisionStatus,
  type StockPreparationDecisionValueEntry,
  type StockPreparationHandoffAdvanceResult,
  type StockPreparationHandoffStatus,
  type StockPreparationResolutionAction,
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
  stockPrepEnumPlain,
  stockPrepErrorPlain,
  stockPrepHandoffOutcomePlain,
  stockPrepHandoffStepPlain,
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
})

const handoff = ref<StockPreparationHandoffStatus>(HANDOFF_INERT)
/** The last advance's result — the source of the plain-language notice, cleared on each new press. */
const handoffAdvance = ref<StockPreparationHandoffAdvanceResult | null>(null)

/**
 * What to tell the operator after an advance. A REPLAY (`changed === false`) is not an error and
 * must not read like one: nothing moved because it had already moved, and nobody was messaged twice.
 */
const handoffNoticeText = computed<string>(() => {
  const result = handoffAdvance.value
  if (!result) return ''
  if (result.changed === false) {
    return bi(
      '这一步之前已经交接过了,没有重复通知。',
      'This step had already been handed on, so nobody was notified a second time.',
    )
  }
  const plain = stockPrepHandoffOutcomePlain(result.notifyOutcome)
  if (!plain) return bi('已经交给下一步了。', 'It has been handed on to the next step.')
  const lead = bi(plain.zh, plain.en)
  const next = bi(plain.zhNext ?? '', plain.enNext ?? '')
  return next ? `${lead} ${next}` : lead
})

/** The enum, kept on screen but subordinate — what a person quotes when they ask us about it. */
const handoffNoticeToken = computed<string | null>(() => handoffAdvance.value?.notifyOutcome ?? null)

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
  const fromStepKey = handoff.value.currentStepKey
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

function selectRow(row: StockPreparationDecisionRow): void {
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
