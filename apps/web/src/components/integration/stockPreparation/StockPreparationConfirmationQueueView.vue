<template>
  <div class="confirm-queue" data-testid="stock-prep-confirmation-queue">
    <p class="confirm-queue__scope" data-testid="stock-prep-confirmation-scope">
      {{ bi(
        '本队列为唯一的待确认清单:仅展示计数、状态、动作与指纹,不展示任何来源单元格内容。',
        'This queue is the authoritative pending list: counts, statuses, actions and fingerprints only — never a source cell value.',
      ) }}
    </p>

    <div class="confirm-queue__filters">
      <label class="confirm-queue__field">
        <span>{{ bi('项目号', 'Project no.') }}</span>
        <input
          v-model.trim="projectNo"
          type="text"
          data-testid="stock-prep-confirmation-project-no"
          @keyup.enter="loadQueue"
        >
      </label>
      <label class="confirm-queue__field">
        <span>{{ bi('状态', 'Status') }}</span>
        <select v-model="statusFilter" data-testid="stock-prep-confirmation-status">
          <option value="">{{ bi('全部', 'All') }}</option>
          <option v-for="status in STATUS_FILTERS" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button
        type="button"
        data-testid="stock-prep-confirmation-load"
        :disabled="!projectNo || loading"
        @click="loadQueue"
      >
        {{ bi('加载队列', 'Load queue') }}
      </button>
    </div>

    <p v-if="listError" class="confirm-queue__error" data-testid="stock-prep-confirmation-error">
      {{ listError }}
    </p>

    <p v-if="list" class="confirm-queue__counts" data-testid="stock-prep-confirmation-counts">
      {{ bi('共', 'Total') }} {{ list.rowCount }} ·
      {{ bi('已挂起', 'Parked') }} {{ list.parkedCount }}
    </p>

    <table v-if="list && list.rows.length" class="confirm-queue__table">
      <thead>
        <tr>
          <th>{{ bi('决定 ID', 'Decision ID') }}</th>
          <th>{{ bi('冲突类型', 'Conflict type') }}</th>
          <th>{{ bi('状态', 'Status') }}</th>
          <th>{{ bi('已录入值', 'Value entered') }}</th>
          <th>{{ bi('操作', 'Actions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in list.rows" :key="row.decisionId || ''" data-testid="stock-prep-confirmation-row">
          <td>{{ row.decisionId }}</td>
          <td>{{ row.conflictType }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row.resolvedValuePresent ? bi('是', 'yes') : bi('否', 'no') }}</td>
          <td>
            <!-- R-11: the two confirm-tier controls render ONLY for a principal the server would
                 also accept. A read-tier operator sees the row and its presence flags, and no
                 control that would 403. -->
            <button
              v-if="canConfirm"
              type="button"
              data-testid="stock-prep-confirmation-open"
              :disabled="busy"
              @click="openDecision(row)"
            >
              {{ bi('处理', 'Work on') }}
            </button>
            <button
              v-if="canConfirm"
              type="button"
              data-testid="stock-prep-confirmation-reveal-value"
              :disabled="busy || !row.decisionId"
              @click="revealValueEntry(row)"
            >
              {{ bi('查看已录入值', 'View entered value') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-else-if="list" class="confirm-queue__empty" data-testid="stock-prep-confirmation-empty">
      {{ bi('该项目号下没有待确认项。', 'No pending decisions for this project number.') }}
    </p>

    <!-- The confirm-tier detail pane: value entry + the frozen O1-A action vocabulary. -->
    <section
      v-if="canConfirm && active"
      class="confirm-queue__detail"
      data-testid="stock-prep-confirmation-detail"
    >
      <h3>{{ bi('确认', 'Confirm') }} · {{ active.decisionId }}</h3>

      <p
        v-if="valueEntry"
        class="confirm-queue__value"
        data-testid="stock-prep-confirmation-value-entry"
      >
        {{ bi('已录入值', 'Entered value') }}:
        <code>{{ valueEntry.valueEntry.resolvedValue ?? bi('(未填)', '(not filled)') }}</code>
      </p>

      <label class="confirm-queue__field">
        <span>{{ bi('处理动作(必选)', 'Resolution action (required)') }}</span>
        <select v-model="resolutionAction" data-testid="stock-prep-confirmation-action">
          <option value="" disabled>{{ bi('请选择', 'Select') }}</option>
          <option v-for="action in STOCK_PREPARATION_DECISION_ACTIONS" :key="action" :value="action">
            {{ action }}
          </option>
        </select>
      </label>

      <label class="confirm-queue__field">
        <span>{{ bi('值', 'Value') }}</span>
        <input v-model.trim="resolvedValue" type="text" data-testid="stock-prep-confirmation-value-input">
      </label>

      <label class="confirm-queue__field">
        <span>{{ bi('辅助值', 'Aux value') }}</span>
        <input v-model.trim="resolvedAuxValue" type="text" data-testid="stock-prep-confirmation-aux-input">
      </label>

      <label class="confirm-queue__field">
        <span>{{ bi('备注', 'Notes') }}</span>
        <input v-model.trim="notes" type="text" data-testid="stock-prep-confirmation-notes-input">
      </label>

      <p v-if="detailError" class="confirm-queue__error" data-testid="stock-prep-confirmation-detail-error">
        {{ detailError }}
      </p>

      <button
        type="button"
        data-testid="stock-prep-confirmation-submit"
        :disabled="!resolutionAction || busy || !active.inputFingerprint"
        @click="submitConfirm"
      >
        {{ bi('提交确认', 'Submit confirmation') }}
      </button>
    </section>
  </div>
</template>

<script setup lang="ts">
// O2 / R-11 — the `/stock-prep` CONFIRMATION QUEUE, the operator surface the O1' ruling adopted
// (o1-ruling-20260829.md 附:同日第二项裁决: 「定位收窄为『确认队列工作台』」).
//
// R-11 CONTRACT, which is what this file is really for:
//   - the queue table renders for `stockprep:read` — exactly the tier the server answers the list on;
//   - the "work on" / "view entered value" / "submit confirmation" controls render ONLY when
//     `canConfirmStockPrepDecision` holds — exactly the tier the server answers value-entry and
//     confirm on. A read-tier operator therefore sees no control that would 403.
//   - RECONCILE has NO control here at any tier, including admin: it re-reads the customer's
//     external source and can burn a one-shot armed B2a claim, which is an owner-level act performed
//     out of band, not queue work.
//
// The predicates come from services/integration/stockPreparation/permissions.ts — the same
// derivation the plugin's `hasStockPrepPermission` runs — so visibility here and authority there
// cannot drift into either half of the R-11 failure.
//
// VALUES-FREE except the one unlocked pane: the table renders presence booleans; value CONTENTS
// appear only inside the confirm-gated detail pane, and never in an error string (the
// StockPreparationConfirmApiError surface is clamped to enum-shaped codes/field names upstream).
import { computed, ref } from 'vue'
import { useAuth } from '../../../composables/useAuth'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  canConfirmStockPrepDecision,
  canReadStockPrepQueue,
} from '../../../services/integration/stockPreparation/permissions'
import {
  confirmStockPreparationDecision,
  listStockPreparationDecisions,
  readStockPreparationDecisionValueEntry,
  STOCK_PREPARATION_DECISION_ACTIONS,
  type StockPreparationDecisionAction,
  type StockPreparationDecisionList,
  type StockPreparationDecisionRow,
  type StockPreparationDecisionValueEntry,
} from '../../../services/integration/stockPreparation/confirmationQueue'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'

const props = defineProps<{ scope: IntegrationScope }>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

/** The frozen ledger status vocabulary the list route accepts as a filter. */
const STATUS_FILTERS = ['pending', 'confirmed', 'superseded', 'cancelled'] as const

const canRead = computed(() => canReadStockPrepQueue(auth.hasPermission))
const canConfirm = computed(() => canConfirmStockPrepDecision(auth.hasPermission))

const projectNo = ref('')
const statusFilter = ref('')
const list = ref<StockPreparationDecisionList | null>(null)
const listError = ref('')
const loading = ref(false)

const active = ref<StockPreparationDecisionRow | null>(null)
const valueEntry = ref<StockPreparationDecisionValueEntry | null>(null)
const resolutionAction = ref<StockPreparationDecisionAction | ''>('')
const resolvedValue = ref('')
const resolvedAuxValue = ref('')
const notes = ref('')
const detailError = ref('')
const busy = ref(false)

/** Values-free error copy: the clamped server CODE, never a server message that could carry a value. */
function errorCode(reason: unknown): string {
  return reason instanceof StockPreparationConfirmApiError
    ? reason.code
    : 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED'
}

async function loadQueue(): Promise<void> {
  // Layer B of the gate (layer A is the route guard on `stockprep:read`). A component can be mounted
  // by a future caller that forgot the guard; the read must refuse on its own terms too.
  if (!canRead.value || !projectNo.value || loading.value) return
  loading.value = true
  listError.value = ''
  try {
    list.value = await listStockPreparationDecisions({
      ...props.scope,
      projectNo: projectNo.value,
      status: statusFilter.value || null,
    })
  } catch (reason) {
    list.value = null
    listError.value = errorCode(reason)
  } finally {
    loading.value = false
  }
}

function openDecision(row: StockPreparationDecisionRow): void {
  if (!canConfirm.value) return
  active.value = row
  valueEntry.value = null
  resolutionAction.value = ''
  resolvedValue.value = ''
  resolvedAuxValue.value = ''
  notes.value = ''
  detailError.value = ''
}

async function revealValueEntry(row: StockPreparationDecisionRow): Promise<void> {
  // Layer B for the ONE value-bearing read. Mirrors the server's confirm-tier gate exactly.
  if (!canConfirm.value || !row.decisionId || busy.value) return
  busy.value = true
  detailError.value = ''
  try {
    active.value = row
    valueEntry.value = await readStockPreparationDecisionValueEntry({
      ...props.scope,
      decisionId: row.decisionId,
    })
  } catch (reason) {
    valueEntry.value = null
    detailError.value = errorCode(reason)
  } finally {
    busy.value = false
  }
}

async function submitConfirm(): Promise<void> {
  const row = active.value
  if (!canConfirm.value || !row || !row.decisionId || !row.inputFingerprint) return
  if (!resolutionAction.value || busy.value) return
  busy.value = true
  detailError.value = ''
  try {
    await confirmStockPreparationDecision({
      decisionId: row.decisionId,
      inputFingerprint: row.inputFingerprint,
      resolutionAction: resolutionAction.value,
      resolvedValue: resolvedValue.value || undefined,
      resolvedAuxValue: resolvedAuxValue.value || undefined,
      notes: notes.value || undefined,
    })
    active.value = null
    valueEntry.value = null
    await loadQueue()
  } catch (reason) {
    detailError.value = errorCode(reason)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.confirm-queue__scope {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.confirm-queue__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-3);
  margin-bottom: var(--ms-space-3);
}

.confirm-queue__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--ms-text-2);
}

.confirm-queue__counts {
  margin: 0 0 var(--ms-space-2);
  color: var(--ms-text-2);
  font-size: 13px;
}

.confirm-queue__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.confirm-queue__table th,
.confirm-queue__table td {
  padding: var(--ms-space-2);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
}

.confirm-queue__detail {
  margin-top: var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  align-items: flex-start;
}

.confirm-queue__error {
  margin: 0;
  color: var(--el-color-danger);
  font-size: 13px;
}

.confirm-queue__empty {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
}
</style>
