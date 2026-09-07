<template>
  <PageShell width="default">
    <PageHeader
      title="批量转交"
      subtitle="把某位审批人名下的待办，整批交给另一位审批人。转交后由服务端逐条判定，结果逐条显示。"
    />

    <section class="batch-transfer__form" aria-label="批量转交设置">
      <div class="batch-transfer__field">
        <span class="batch-transfer__label">原审批人</span>
        <ApprovalUserPicker
          :model-value="fromUserId || null"
          placeholder="搜索用户名 / 邮箱 / ID"
          data-testid="batch-transfer-source-picker"
          @update:model-value="onSourceChange"
        />
        <el-button
          class="batch-transfer__load"
          :loading="loadingRows"
          :disabled="!fromUserId"
          data-testid="batch-transfer-load"
          @click="loadRows"
        >
          载入待办
        </el-button>
      </div>

      <div class="batch-transfer__field">
        <span class="batch-transfer__label">转交给</span>
        <ApprovalUserPicker
          :model-value="toUserId || null"
          placeholder="搜索用户名 / 邮箱 / ID"
          :excluded-user-ids="excludedTargets"
          data-testid="batch-transfer-target-picker"
          @update:model-value="toUserId = $event ?? ''"
        />
      </div>

      <div class="batch-transfer__field">
        <span class="batch-transfer__label">转交原因</span>
        <el-input
          v-model="reason"
          type="textarea"
          :rows="2"
          placeholder="填写转交原因（必填，会写入审批记录）"
          data-testid="batch-transfer-reason"
        />
      </div>
    </section>

    <el-alert
      v-if="loadError"
      type="error"
      show-icon
      :closable="false"
      class="batch-transfer__alert"
      data-testid="batch-transfer-load-error"
      title="待办列表加载失败，请重试"
    />

    <section class="batch-transfer__rows" aria-label="待转交审批">
      <div class="batch-transfer__rows-head">
        <el-checkbox
          :model-value="allSelected"
          :disabled="rows.length === 0"
          data-testid="batch-transfer-select-all"
          @update:model-value="toggleAll"
        >
          全选
        </el-checkbox>
        <span class="batch-transfer__count" data-testid="batch-transfer-selected-count">
          已选 {{ selectedIds.length }} / {{ rows.length }}
        </span>
      </div>

      <p v-if="loaded && rows.length === 0" class="batch-transfer__empty" data-testid="batch-transfer-empty">
        该审批人名下没有可转交的平台待办。
      </p>

      <p v-if="truncationNotice" class="batch-transfer__truncated" data-testid="batch-transfer-truncated">
        {{ truncationNotice }}
      </p>

      <ul class="batch-transfer__list">
        <li
          v-for="(row, index) in rows"
          :key="row.id"
          class="batch-transfer__row"
          :data-testid="`batch-transfer-row-${row.id}`"
        >
          <el-checkbox
            :model-value="selectedSet.has(row.id)"
            :data-testid="`batch-transfer-row-check-${row.id}`"
            @update:model-value="toggleRow(row.id, $event)"
          />
          <span class="batch-transfer__row-title">{{ rowLabel(row, index) }}</span>
          <span
            v-if="outcomeFor(row.id)"
            class="batch-transfer__row-outcome"
            :data-testid="`batch-transfer-outcome-${row.id}`"
            :data-outcome="outcomeFor(row.id)!.kind"
            :data-outcome-reason="outcomeFor(row.id)!.reason ?? ''"
          >{{ outcomeText(outcomeFor(row.id)!) }}</span>
        </li>
      </ul>
    </section>

    <section class="batch-transfer__actions">
      <span v-if="blockText" class="batch-transfer__block" data-testid="batch-transfer-block-reason">
        {{ blockText }}
      </span>
      <el-button
        type="primary"
        :loading="submitting"
        :disabled="blockReason !== null || submitting"
        data-testid="batch-transfer-submit"
        @click="submit"
      >
        转交所选
      </el-button>
    </section>

    <section
      v-if="summary"
      class="batch-transfer__summary"
      aria-label="转交结果"
      data-testid="batch-transfer-summary"
    >
      <span>提交 {{ summary.submitted }}</span>
      <span>成功 {{ summary.transferred }}</span>
      <span>跳过 {{ summary.skipped }}</span>
      <span v-if="summary.unreported > 0" data-testid="batch-transfer-unreported">
        未返回结果 {{ summary.unreported }}
      </span>
    </section>
  </PageShell>
</template>

<script setup lang="ts">
// P1b slice 3 — the admin 批量转交 page.
//
// WHAT THIS IS: the first web caller for `POST /api/approvals/admin/reassign`, an endpoint that has
// shipped (and been guarded by `rbacGuard('approvals:admin')`) with no UI at all. Every rule below
// is the SERVER's — this page adds no approval behaviour of its own:
//   * the request always carries explicit `instanceIds` (the rows the operator ticked), so the
//     server's own discovery branch is never invoked and the operator can never submit a set they
//     did not see;
//   * `reason` is required because the endpoint refuses without it, and it lands in the approval
//     record;
//   * `fromUserId === toUserId` is refused by the endpoint, so the source id is passed to the target
//     picker's existing `excludedUserIds` rather than being re-validated separately;
//   * the 200-row cap is the endpoint's own.
//
// HONEST ABOUT THE LIST: the listed set is NOT a promise of what will transfer. The server decides
// per instance inside a transaction (status re-check under lock, seat re-check, attendance-scope
// authorization), so a listed row can still come back skipped. That is why every submitted row gets
// its own outcome, and why an id the server mentions in NEITHER `succeeded` nor `skipped` renders as
// "未返回结果" instead of quietly looking like a success.
//
// PROJECTION PERMISSIONS ARE NOT RELAXED: the list read is the ordinary
// `GET /api/approvals` projection with the existing `assignee` filter. An admin sees another
// approver's rows only because the list scope already admits every row for an admin principal.
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import ApprovalUserPicker from '../../approvals/components/ApprovalUserPicker.vue'
import {
  APPROVAL_BATCH_TRANSFER_PAGE_LIMIT,
  bulkReassignApprovals,
  listPendingApprovalsForApprover,
} from '../../approvals/api'
import {
  blockReasonForTransfer,
  buildTransferOutcomes,
  describeSkipReason,
  summarizeTransferOutcomes,
  type ApprovalBatchTransferBlockReason,
  type ApprovalBatchTransferRowOutcome,
  type ApprovalBatchTransferSummary,
} from '../../approvals/batchTransfer'
import { useLocale } from '../../composables/useLocale'
import type { UnifiedApprovalDTO } from '../../types/approval'

const { isZh } = useLocale()

const fromUserId = ref('')
const toUserId = ref('')
const reason = ref('')
const rows = ref<UnifiedApprovalDTO[]>([])
const selectedIds = ref<string[]>([])
const totalPending = ref(0)
const loadingRows = ref(false)
const loaded = ref(false)
const loadError = ref(false)
const submitting = ref(false)
const outcomes = ref<ApprovalBatchTransferRowOutcome[]>([])
const summary = ref<ApprovalBatchTransferSummary | null>(null)

const selectedSet = computed(() => new Set(selectedIds.value))
// The list read is capped at the endpoint's own page maximum, which is also the service's cap on an
// explicit id array — so a queue larger than the cap renders a COMPLETE-LOOKING page that is not the
// whole queue. `total` comes back on the same response; saying so is the difference between "this
// approver has 200 items" and "this page shows 200 of them". Without this the operator can only
// discover the remainder by noticing that reloading still returns rows.
const truncationNotice = computed(() => {
  if (!loaded.value || totalPending.value <= rows.value.length) return ''
  return isZh.value
    ? `该审批人共有 ${totalPending.value} 条待办，本次仅载入前 ${rows.value.length} 条（单次上限）。处理完这一批后重新载入可继续。`
    : `This approver has ${totalPending.value} pending items; only the first ${rows.value.length} were loaded (per-request cap). Reload after this batch to continue.`
})
const allSelected = computed(() => rows.value.length > 0 && selectedIds.value.length === rows.value.length)
const excludedTargets = computed(() => (fromUserId.value ? [fromUserId.value] : []))

const blockReason = computed<ApprovalBatchTransferBlockReason | null>(() => blockReasonForTransfer({
  fromUserId: fromUserId.value,
  toUserId: toUserId.value,
  reason: reason.value,
  selectedIds: selectedIds.value,
  limit: APPROVAL_BATCH_TRANSFER_PAGE_LIMIT,
}))

const BLOCK_TEXT: Record<ApprovalBatchTransferBlockReason, { zh: string; en: string }> = {
  'no-source': { zh: '请先选择原审批人', en: 'Pick the source approver first' },
  'no-target': { zh: '请选择转交给谁', en: 'Pick who to transfer to' },
  'same-user': { zh: '原审批人与目标用户不能相同', en: 'Source and target must differ' },
  'no-selection': { zh: '请至少勾选一条待办', en: 'Select at least one item' },
  'no-reason': { zh: '请填写转交原因', en: 'A transfer reason is required' },
  'over-limit': { zh: `一次最多转交 ${APPROVAL_BATCH_TRANSFER_PAGE_LIMIT} 条`, en: `At most ${APPROVAL_BATCH_TRANSFER_PAGE_LIMIT} per request` },
}

const blockText = computed(() => {
  if (!blockReason.value) return ''
  const entry = BLOCK_TEXT[blockReason.value]
  return isZh.value ? entry.zh : entry.en
})

function resetResults(): void {
  outcomes.value = []
  summary.value = null
}

function onSourceChange(next: string | null): void {
  fromUserId.value = next ?? ''
  rows.value = []
  selectedIds.value = []
  totalPending.value = 0
  loaded.value = false
  loadError.value = false
  resetResults()
}

async function loadRows(): Promise<void> {
  if (!fromUserId.value || loadingRows.value) return
  loadingRows.value = true
  loadError.value = false
  resetResults()
  try {
    const page = await listPendingApprovalsForApprover(fromUserId.value)
    rows.value = Array.isArray(page?.data) ? page.data : []
    totalPending.value = typeof page?.total === 'number' && Number.isFinite(page.total) && page.total >= 0
      ? page.total
      : rows.value.length
    // Default to "everything the operator just looked at"; they can untick.
    selectedIds.value = rows.value.map((row) => row.id)
    loaded.value = true
  } catch {
    rows.value = []
    selectedIds.value = []
    totalPending.value = 0
    loaded.value = false
    loadError.value = true
  } finally {
    loadingRows.value = false
  }
}

function toggleAll(next: unknown): void {
  selectedIds.value = next === true ? rows.value.map((row) => row.id) : []
}

function toggleRow(id: string, next: unknown): void {
  const set = new Set(selectedIds.value)
  if (next === true) set.add(id)
  else set.delete(id)
  selectedIds.value = rows.value.map((row) => row.id).filter((rowId) => set.has(rowId))
}

// Values-free row label, following the same per-list ordinal convention ApprovalUserPicker's
// `optionLabel` established (`成员 N`): a row with neither a title nor a request number renders an
// ordinal, NEVER the raw instance id. The id still keys the row and the test hooks — it is what the
// operator is acting on — but it is not display text.
function rowLabel(row: UnifiedApprovalDTO, index: number): string {
  const title = row.title?.trim()
  if (title) return title
  const requestNo = row.requestNo?.trim()
  if (requestNo) return requestNo
  return isZh.value ? `审批 ${index + 1}` : `Approval ${index + 1}`
}

function outcomeFor(id: string): ApprovalBatchTransferRowOutcome | undefined {
  return outcomes.value.find((outcome) => outcome.id === id)
}

function outcomeText(outcome: ApprovalBatchTransferRowOutcome): string {
  if (outcome.kind === 'transferred') return isZh.value ? '已转交' : 'Transferred'
  if (outcome.kind === 'unreported') return isZh.value ? '未返回结果' : 'No result returned'
  return describeSkipReason(outcome.reason, isZh.value)
}

async function submit(): Promise<void> {
  if (blockReason.value !== null || submitting.value) return
  const submittedIds = [...selectedIds.value]
  try {
    await ElMessageBox.confirm(
      isZh.value
        ? `将把所选 ${submittedIds.length} 条待办转交给所选用户，转交原因会写入审批记录。是否继续？`
        : `${submittedIds.length} selected item(s) will be transferred to the selected user, and the reason will be written to the approval record. Continue?`,
      isZh.value ? '确认批量转交' : 'Confirm batch transfer',
      { type: 'warning' },
    )
  } catch {
    // Operator cancelled the confirm — no request is made.
    return
  }

  submitting.value = true
  resetResults()
  try {
    const result = await bulkReassignApprovals({
      fromUserId: fromUserId.value,
      toUserId: toUserId.value,
      reason: reason.value.trim(),
      instanceIds: submittedIds,
    })
    outcomes.value = buildTransferOutcomes(submittedIds, result)
    summary.value = summarizeTransferOutcomes(outcomes.value)
    ElMessage.success(isZh.value ? '批量转交已处理，请查看逐条结果' : 'Batch transfer processed; see the per-row results')
  } catch {
    ElMessage.error(isZh.value ? '批量转交请求未成功，请重试' : 'The batch transfer request did not succeed; please retry')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.batch-transfer__form {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  margin-bottom: var(--ms-space-4);
}

.batch-transfer__field {
  display: flex;
  align-items: flex-start;
  gap: var(--ms-space-3);
}

.batch-transfer__label {
  flex: 0 0 84px;
  padding-top: 6px;
  color: var(--ms-text-2);
}

.batch-transfer__load {
  flex: 0 0 auto;
}

.batch-transfer__alert {
  margin-bottom: var(--ms-space-3);
}

.batch-transfer__rows-head {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
  padding-bottom: var(--ms-space-2);
  border-bottom: 1px solid var(--ms-border-light);
}

.batch-transfer__count {
  color: var(--ms-text-3);
}

.batch-transfer__empty {
  padding: var(--ms-space-4) 0;
  color: var(--ms-text-3);
}

.batch-transfer__truncated {
  padding: var(--ms-space-2) 0;
  color: var(--ms-text-2);
}

.batch-transfer__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.batch-transfer__row {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
  padding: var(--ms-space-2) 0;
  border-bottom: 1px solid var(--ms-border-light);
}

.batch-transfer__row-title {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-transfer__row-outcome {
  flex: 0 0 auto;
  color: var(--ms-text-2);
}

.batch-transfer__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--ms-space-3);
  margin-top: var(--ms-space-4);
}

.batch-transfer__block {
  color: var(--ms-text-3);
}

.batch-transfer__summary {
  display: flex;
  gap: var(--ms-space-4);
  margin-top: var(--ms-space-3);
  color: var(--ms-text-2);
}
</style>
