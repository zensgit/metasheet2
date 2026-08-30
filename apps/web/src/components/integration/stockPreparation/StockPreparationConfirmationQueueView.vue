<template>
  <div class="stock-prep-confirm" data-testid="stock-prep-confirmation-queue">
    <p class="stock-prep-confirm__scope" data-testid="stock-prep-confirmation-scope">
      {{ bi(
        '本面为人工确认闭环入口:队列为 values-free 投影(仅计数、指纹、状态与动作枚举);值内容仅在下方「值录入」单条读取中出现。',
        'Human confirmation loop entry. The queue is a values-free projection (counts, fingerprints, status and action enums only); entered content appears only in the per-decision value-entry read below.',
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
        <span>{{ bi('状态', 'Status') }}</span>
        <select v-model="statusFilter" data-testid="stock-prep-confirmation-status-filter">
          <option value="">{{ bi('全部', 'All') }}</option>
          <option v-for="status in STOCK_PREPARATION_DECISION_STATUSES" :key="status" :value="status">
            {{ status }}
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
        {{ bi('刷新队列', 'Refresh queue') }}
      </button>

      <button
        v-if="can('confirmationQueue.readiness')"
        type="button"
        data-testid="stock-prep-confirmation-readiness"
        :disabled="busy"
        @click="loadReadiness"
      >
        {{ bi('检查就绪', 'Check readiness') }}
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
        {{ bi('初始化账本(管理员)', 'Provision ledger (admin)') }}
      </button>

      <button
        v-if="can('confirmationQueue.reconcile')"
        type="button"
        data-testid="stock-prep-confirmation-reconcile"
        :disabled="busy"
        @click="emit('admin-action', 'reconcile')"
      >
        {{ bi('重算队列(管理员)', 'Reconcile queue (admin)') }}
      </button>
    </div>

    <p v-if="errorCode" class="stock-prep-confirm__error" data-testid="stock-prep-confirmation-error">
      {{ errorCode }}
    </p>

    <p v-if="readiness !== null" class="stock-prep-confirm__readiness" data-testid="stock-prep-confirmation-readiness-result">
      {{ readiness.ready === true ? bi('账本已就绪', 'Ledger ready') : bi('账本未就绪', 'Ledger not ready') }}
    </p>

    <div v-if="queue" class="stock-prep-confirm__counts" data-testid="stock-prep-confirmation-counts">
      <span>{{ bi('行数', 'Rows') }}: {{ queue.rowCount }}</span>
      <span>{{ bi('人工暂挂', 'Parked') }}: {{ queue.parkedCount }}</span>
    </div>

    <table v-if="queue && queue.rows.length > 0" class="stock-prep-confirm__table" data-testid="stock-prep-confirmation-rows">
      <thead>
        <tr>
          <th>{{ bi('决定 id', 'Decision id') }}</th>
          <th>{{ bi('冲突类型', 'Conflict') }}</th>
          <th>{{ bi('状态', 'Status') }}</th>
          <th>{{ bi('动作', 'Action') }}</th>
          <th>{{ bi('已填值', 'Value entered') }}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in queue.rows" :key="row.decisionId || ''" data-testid="stock-prep-confirmation-row">
          <td>{{ row.decisionId }}</td>
          <td>{{ row.conflictType }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row.resolutionAction }}</td>
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
              {{ bi('查看值录入', 'View value entry') }}
            </button>
            <button
              v-if="can('confirmationQueue.confirm')"
              type="button"
              data-testid="stock-prep-confirmation-select"
              :disabled="busy || !row.decisionId"
              @click="selectRow(row)"
            >
              {{ bi('确认…', 'Confirm…') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-else-if="queue" class="stock-prep-confirm__empty" data-testid="stock-prep-confirmation-empty">
      {{ bi('该项目号下没有待确认决定。', 'No confirmation decisions for this project number.') }}
    </p>

    <!-- The value-entry pane: the ONE content-bearing surface, gated on the same code as confirm. -->
    <section
      v-if="valueEntry && can('confirmationQueue.valueEntry')"
      class="stock-prep-confirm__pane"
      data-testid="stock-prep-confirmation-value-entry-pane"
    >
      <h3>{{ bi('值录入(本人回读)', 'Value entry (author readback)') }}</h3>
      <dl>
        <dt>resolvedValue</dt>
        <dd data-testid="stock-prep-confirmation-value-entry-value">{{ valueEntry.valueEntry.resolvedValue }}</dd>
        <dt>resolvedAuxValue</dt>
        <dd data-testid="stock-prep-confirmation-value-entry-aux">{{ valueEntry.valueEntry.resolvedAuxValue }}</dd>
        <dt>notes</dt>
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
      <h3>{{ bi('确认决定', 'Confirm decision') }}</h3>
      <label class="stock-prep-confirm__field">
        <span>{{ bi('处理动作', 'Resolution action') }}</span>
        <select v-model="resolutionAction" data-testid="stock-prep-confirmation-action-select">
          <option v-for="action in STOCK_PREPARATION_RESOLUTION_ACTIONS" :key="action" :value="action">
            {{ action }}
          </option>
        </select>
      </label>
      <label class="stock-prep-confirm__field">
        <span>resolvedValue</span>
        <input v-model="resolvedValue" type="text" data-testid="stock-prep-confirmation-value-input">
      </label>
      <label class="stock-prep-confirm__field">
        <span>resolvedAuxValue</span>
        <input v-model="resolvedAuxValue" type="text" data-testid="stock-prep-confirmation-aux-input">
      </label>
      <label class="stock-prep-confirm__field">
        <span>notes</span>
        <input v-model="notes" type="text" data-testid="stock-prep-confirmation-notes-input">
      </label>
      <button type="submit" data-testid="stock-prep-confirmation-confirm" :disabled="busy">
        {{ bi('提交确认', 'Submit confirmation') }}
      </button>
    </form>
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
  confirmStockPreparationDecision,
  listStockPreparationDecisions,
  readStockPreparationDecisionReadiness,
  readStockPreparationValueEntry,
  type StockPreparationDecisionQueue,
  type StockPreparationDecisionReadiness,
  type StockPreparationDecisionRow,
  type StockPreparationDecisionStatus,
  type StockPreparationDecisionValueEntry,
  type StockPreparationResolutionAction,
} from '../../../services/integration/stockPreparation/confirmationQueue'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  canStockPrepCapability,
} from '../../../services/integration/stockPreparation/workbenchAccess'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'

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

async function loadQueue(): Promise<void> {
  await run(async () => {
    queue.value = await listStockPreparationDecisions({
      ...props.scope,
      projectNo: projectNo.value,
      status: statusFilter.value === '' ? null : statusFilter.value,
    })
  })
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
