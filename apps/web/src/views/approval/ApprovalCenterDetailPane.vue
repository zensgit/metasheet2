<template>
  <aside
    class="approval-detail-pane"
    :aria-label="t.paneLabel"
    data-testid="approval-detail-pane"
  >
    <header class="approval-detail-pane__header">
      <div class="approval-detail-pane__title-row">
        <StatusTag v-bind="statusTag" />
        <h3 class="approval-detail-pane__title">{{ row.title }}</h3>
      </div>
      <button
        type="button"
        class="approval-detail-pane__close"
        :aria-label="t.closeLabel"
        data-testid="approval-detail-pane-close"
        @click="$emit('close')"
      >
        ×
      </button>
    </header>

    <div class="approval-detail-pane__meta">{{ row.requestNo || '-' }}</div>

    <p v-if="summaryLine" class="approval-detail-pane__summary">{{ summaryLine }}</p>

    <section class="approval-detail-pane__node" :aria-label="t.nodeLabel">
      <div v-if="detailLoading" class="approval-detail-pane__node-loading" data-testid="approval-detail-pane-loading">
        {{ t.loading }}
      </div>
      <div v-else-if="detailError" class="approval-detail-pane__node-error" data-testid="approval-detail-pane-error">
        {{ detailError }}
      </div>
      <template v-else-if="detail">
        <div
          v-if="detail.currentStep !== null || detail.totalSteps !== null"
          class="approval-detail-pane__node-current"
        >
          {{ stepProgressText(detail.currentStep ?? '-', detail.totalSteps ?? '-') }}
        </div>
        <div
          v-if="cancelRoundPendingWord"
          class="approval-detail-pane__node-approvers"
          data-testid="approval-detail-pane-cancel-round-pending"
        >
          {{ cancelRoundPendingWord }}
        </div>
        <div v-else-if="pendingApproverLabels.length" class="approval-detail-pane__node-approvers">
          {{ pendingApproversText }}
        </div>
      </template>
    </section>

    <div v-if="showQuickActions" class="approval-detail-pane__actions">
      <el-popconfirm
        :title="approveConfirmTitle"
        :confirm-button-text="t.confirm"
        :cancel-button-text="t.cancel"
        @confirm="$emit('quick-approve', row)"
      >
        <template #reference>
          <el-button
            type="primary"
            :loading="approveLoading"
            :disabled="actionsDisabled"
            data-testid="approval-detail-pane-approve"
          >
            {{ t.approve }}
          </el-button>
        </template>
      </el-popconfirm>
      <el-button
        type="danger"
        plain
        :disabled="actionsDisabled"
        data-testid="approval-detail-pane-reject"
        @click="$emit('quick-reject', row)"
      >
        {{ t.reject }}
      </el-button>
    </div>

    <el-button
      type="primary"
      link
      class="approval-detail-pane__full-link"
      data-testid="approval-detail-pane-full-link"
      @click="$emit('open-full-detail', row)"
    >
      {{ t.openFull }}
    </el-button>
  </aside>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import type { ApprovalAssignmentDTO, UnifiedApprovalDTO } from '../../types/approval'
import StatusTag from '../../components/status/StatusTag.vue'
import { ensureUserNamesResolved, getResolvedUserName } from '../../approvals/directoryResolve'
import { approvalStatusTagProps, isCancelRoundWorkflow, needsCancelRoundCloseReason } from '../../approvals/cancelRound'
import { resolveStatusDisplay } from '../../utils/statusDomains'
import { useLocale } from '../../composables/useLocale'
import { CENTER_PANE_EN, CENTER_PANE_ZH } from './approvalCenterLabels'

// UI-7 (approval-parity-master-design-lock-20260817.md §4 UI-7) — the desktop master-detail pane's
// read-only content. Presentation only: every mutating action is EMITTED to the parent
// (ApprovalCenterView), which dispatches through the exact same `handleInlineApprove` /
// `openRowReject` functions the row-level inline actions already use — this component never calls
// the approval API directly, so there is only ever one approve/reject code path (master §M no-new-
// verbs discipline; excluded scope: no new confirmation flow, no new dialog).
const props = defineProps<{
  /** The selected list row — already-known data, used for immediate (zero-fetch) title/status/编号. */
  row: UnifiedApprovalDTO
  /** The single-fetch detail (getApproval(id)), used for current-node + pending-approver freshness. */
  detail: UnifiedApprovalDTO | null
  detailLoading: boolean
  detailError: string
  /** Reuses the SAME summary line already computed for this row in the table (useApprovalListFieldSummary). */
  summaryLine: string
  /** Pending tab + platform-native row only (mirrors ApprovalCenterView's `isRowBatchSelectable`). */
  showQuickActions: boolean
  approveLoading: boolean
  /** Mirrors the row actions' shared gate (`inlineApprovingId !== null`) — one in-flight approve at a time. */
  actionsDisabled: boolean
}>()

// 撤销锁 P-2: the pane shows the list row immediately and the single-fetch detail once it lands. The
// detail read whitelist-projects `cancelRoundCloseReason`, so for a cancel-round instance it is the
// source of the V-word; before it lands (or if it fails) a REJECTED cancel-round row says 「读取中」 /
// 「暂时无法读取」 rather than guessing between an approver's rejection and a system closure.
// O-8 / F8-1: pane chrome follows the shell locale (module-scope `useLocale()` singleton).
const { isZh } = useLocale()
const t = computed(() => (isZh.value ? CENTER_PANE_ZH : CENTER_PANE_EN))
const approveConfirmTitle = computed(() => (isZh.value ? `确认通过「${props.row.title}」？` : `Approve "${props.row.title}"?`))
function stepProgressText(current: number | string, total: number | string): string {
  return isZh.value ? `第 ${current} / ${total} 步` : `Step ${current} / ${total}`
}

const statusTag = computed(() => {
  const detail = props.detail
  if (detail && detail.id === props.row.id) return approvalStatusTagProps(detail)
  if (!needsCancelRoundCloseReason(props.row)) return approvalStatusTagProps(props.row)
  return approvalStatusTagProps(props.row, props.detailError ? { kind: 'unavailable' } : { kind: 'resolving' })
})

defineEmits<{
  (e: 'quick-approve', row: UnifiedApprovalDTO): void
  (e: 'quick-reject', row: UnifiedApprovalDTO): void
  (e: 'open-full-detail', row: UnifiedApprovalDTO): void
  (e: 'close'): void
}>()

// `assignment.metadata` carries no display name today — only `assigneeId` (see
// `ApprovalAssignmentDTO`). Prefers `metadata.assigneeName` if a producer ever populates it; then
// (member-display-identity, 2026-08-19) the shared authorized-scope resolver
// (`getResolvedUserName`, ensured by the watcher below); when still unresolvable, falls back to a
// values-free, still-distinguishable ordinal (`成员 N`) rather than the raw internal user id —
// mirrors ApprovalDetailView's own `assignmentDisplayLabel` values-free convention.
function assigneeLabel(assignment: ApprovalAssignmentDTO, ordinal: number): string {
  const metaName = assignment.metadata?.assigneeName
  if (typeof metaName === 'string' && metaName.trim()) return metaName.trim()
  const resolved = getResolvedUserName(assignment.assigneeId)
  if (resolved) return resolved
  return isZh.value ? `成员 ${ordinal}` : `Member ${ordinal}`
}

// Every ACTIVE assignment at the current node(s) — linear (`currentNodeKey`) or parallel
// (`currentNodeKeys`), mirroring ApprovalDetailView's `currentActiveNodeKeys` resolution.
const pendingApproverLabels = computed<string[]>(() => {
  const detail = props.detail
  if (!detail) return []
  const keys = new Set<string>(
    detail.currentNodeKeys && detail.currentNodeKeys.length > 0
      ? detail.currentNodeKeys
      : detail.currentNodeKey
        ? [detail.currentNodeKey]
        : [],
  )
  if (keys.size === 0) return []
  return detail.assignments
    .filter((a) => a.isActive && !!a.nodeKey && keys.has(a.nodeKey))
    .map((a, index) => assigneeLabel(a, index + 1))
})
const pendingApproversText = computed(() => {
  const names = pendingApproverLabels.value
  return isZh.value ? `待处理人：${names.join('、')}` : `Pending approvers: ${names.join(', ')}`
})

// 撤销轮 — ratified 撤销锁 §15.6 (P-6) seat display boundary, lift conditions not met: the pane
// names no current approver for a cancel round; the V1 word stands in for the 待处理人 line.
const cancelRoundPendingWord = computed<string>(() => {
  if (!isCancelRoundWorkflow(props.detail) || pendingApproverLabels.value.length === 0) return ''
  return resolveStatusDisplay('cancelRound', 'cancellation_pending_approval', true).label
})

// member-display-identity (2026-08-19): a `watch` side effect (never inside the `computed` above)
// kicks off the batch resolve for every pending-approver id this pane has in view.
watch(
  () => props.detail?.assignments.map((a) => a.assigneeId) ?? [],
  (ids) => ensureUserNamesResolved(ids),
  { immediate: true },
)
</script>

<style scoped>
.approval-detail-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 360px;
  flex: 0 0 360px;
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-left: 3px solid var(--ms-color-primary);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  align-self: flex-start;
}

.approval-detail-pane__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.approval-detail-pane__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.approval-detail-pane__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ms-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.approval-detail-pane__close {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--ms-text-2);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
}

.approval-detail-pane__close:hover {
  color: var(--ms-text-1);
}

.approval-detail-pane__meta {
  font-size: 12px;
  color: var(--ms-text-2);
}

.approval-detail-pane__summary {
  margin: 0;
  font-size: 13px;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.approval-detail-pane__node {
  padding-top: 10px;
  border-top: 1px solid var(--ms-border-light);
  font-size: 13px;
  color: var(--ms-text-1);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-detail-pane__node-loading,
.approval-detail-pane__node-error {
  color: var(--ms-text-2);
  font-size: 13px;
}

.approval-detail-pane__node-error {
  color: var(--ms-color-danger);
}

.approval-detail-pane__actions {
  display: flex;
  gap: 8px;
}

.approval-detail-pane__full-link {
  align-self: flex-start;
}
</style>
