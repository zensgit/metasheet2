<template>
  <div class="approval-mobile-list" data-testid="approval-mobile-list">
    <div
      v-if="loading"
      class="approval-mobile-list__loading"
      data-testid="approval-mobile-loading"
    >
      加载中…
    </div>
    <div
      v-else-if="approvals.length === 0"
      class="approval-mobile-list__empty"
      data-testid="approval-mobile-empty"
    >
      {{ emptyText }}
    </div>
    <button
      v-for="row in approvals"
      v-else
      :key="row.id"
      type="button"
      class="approval-mobile-list__card"
      data-testid="approval-mobile-card"
      :data-approval-id="row.id"
      @click="$emit('select', row)"
    >
      <div class="approval-mobile-list__card-top">
        <span class="approval-mobile-list__title">{{ row.title ?? '审批申请' }}</span>
        <span
          class="approval-mobile-list__status"
          :class="`approval-mobile-list__status--${statusTagType(row.status)}`"
          :data-status="row.status"
        >
          {{ statusLabel(row.status) }}
        </span>
      </div>
      <div class="approval-mobile-list__meta">
        <span class="approval-mobile-list__request-no">{{ row.requestNo ?? '-' }}</span>
        <span class="approval-mobile-list__requester">{{ row.requester?.name ?? '-' }}</span>
      </div>
      <div class="approval-mobile-list__date">{{ formatDate(row.createdAt) }}</div>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { UnifiedApprovalDTO } from '../../types/approval'

// T3-1 v0 — dedicated touch-first list card (ballot Q10). Replaces the desktop
// `el-table` (fixed column widths + horizontal scroll + tiny row-click targets)
// with full-width tappable cards. Kept free of Element Plus so it stays touch
// sized and trivially mountable in tests. Labels reuse the module's existing
// Chinese status/format vocabulary verbatim — no new user-facing copy.
withDefaults(
  defineProps<{
    approvals: UnifiedApprovalDTO[]
    loading?: boolean
    emptyText?: string
  }>(),
  {
    loading: false,
    emptyText: '暂无审批',
  },
)

defineEmits<{
  (event: 'select', row: UnifiedApprovalDTO): void
}>()

function statusTagType(status: string): string {
  const map: Record<string, string> = {
    pending: 'warning',
    approved: 'success',
    rejected: 'danger',
    revoked: 'info',
    cancelled: 'info',
  }
  return map[status] ?? 'info'
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: '待处理',
    approved: '已通过',
    rejected: '已驳回',
    revoked: '已撤回',
    cancelled: '已取消',
  }
  return map[status] ?? status
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}
</script>

<style scoped>
.approval-mobile-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.approval-mobile-list__loading,
.approval-mobile-list__empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--el-text-color-secondary, #909399);
  font-size: 14px;
}

.approval-mobile-list__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: #fff;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: 10px;
  padding: 14px 16px;
  cursor: pointer;
  /* Touch target floor — comfortably above the 44px accessibility minimum. */
  min-height: 72px;
}

.approval-mobile-list__card:active {
  background: var(--el-fill-color-light, #f5f7fa);
}

.approval-mobile-list__card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.approval-mobile-list__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary, #303133);
  line-height: 1.4;
}

.approval-mobile-list__status {
  flex-shrink: 0;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--el-fill-color-light, #f5f7fa);
  color: var(--el-text-color-secondary, #909399);
}

.approval-mobile-list__status--warning {
  background: #fdf6ec;
  color: #e6a23c;
}

.approval-mobile-list__status--success {
  background: #f0f9eb;
  color: #67c23a;
}

.approval-mobile-list__status--danger {
  background: #fef0f0;
  color: #f56c6c;
}

.approval-mobile-list__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: var(--el-text-color-regular, #606266);
}

.approval-mobile-list__date {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}
</style>
