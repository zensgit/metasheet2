<template>
  <aside
    class="approval-detail-pane"
    aria-label="审批详情"
    data-testid="approval-detail-pane"
  >
    <header class="approval-detail-pane__header">
      <div class="approval-detail-pane__title-row">
        <StatusTag domain="approvalInstance" :status="row.status" />
        <h3 class="approval-detail-pane__title">{{ row.title }}</h3>
      </div>
      <button
        type="button"
        class="approval-detail-pane__close"
        aria-label="关闭详情面板"
        data-testid="approval-detail-pane-close"
        @click="$emit('close')"
      >
        ×
      </button>
    </header>

    <div class="approval-detail-pane__meta">{{ row.requestNo || '-' }}</div>

    <p v-if="summaryLine" class="approval-detail-pane__summary">{{ summaryLine }}</p>

    <section class="approval-detail-pane__node" aria-label="当前节点与待处理人">
      <div v-if="detailLoading" class="approval-detail-pane__node-loading" data-testid="approval-detail-pane-loading">
        加载中…
      </div>
      <div v-else-if="detailError" class="approval-detail-pane__node-error" data-testid="approval-detail-pane-error">
        {{ detailError }}
      </div>
      <template v-else-if="detail">
        <div v-if="detail.currentNodeKey" class="approval-detail-pane__node-current">
          当前节点：{{ detail.currentNodeKey }}
        </div>
        <div v-if="pendingApproverLabels.length" class="approval-detail-pane__node-approvers">
          待处理人：{{ pendingApproverLabels.join('、') }}
        </div>
      </template>
    </section>

    <div v-if="showQuickActions" class="approval-detail-pane__actions">
      <el-popconfirm
        :title="`确认通过「${row.title}」？`"
        confirm-button-text="确认"
        cancel-button-text="取消"
        @confirm="$emit('quick-approve', row)"
      >
        <template #reference>
          <el-button
            type="primary"
            :loading="approveLoading"
            :disabled="actionsDisabled"
            data-testid="approval-detail-pane-approve"
          >
            通过
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
        驳回
      </el-button>
    </div>

    <el-button
      type="primary"
      link
      class="approval-detail-pane__full-link"
      data-testid="approval-detail-pane-full-link"
      @click="$emit('open-full-detail', row)"
    >
      打开完整详情
    </el-button>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ApprovalAssignmentDTO, UnifiedApprovalDTO } from '../../types/approval'
import StatusTag from '../../components/status/StatusTag.vue'

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

defineEmits<{
  (e: 'quick-approve', row: UnifiedApprovalDTO): void
  (e: 'quick-reject', row: UnifiedApprovalDTO): void
  (e: 'open-full-detail', row: UnifiedApprovalDTO): void
  (e: 'close'): void
}>()

// `assignment.metadata` carries no display name today — mirrors ApprovalDetailView's own
// `assignmentDisplayLabel` fallback-to-id convention (no separate directory fetch here).
function assigneeLabel(assignment: ApprovalAssignmentDTO): string {
  const metaName = assignment.metadata?.assigneeName
  return typeof metaName === 'string' && metaName.trim() ? metaName : assignment.assigneeId
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
    .map(assigneeLabel)
})
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
